export * as DelegationRuntime from "./runtime.js"

import type { Options } from "./config.js"
import { isStorageFailure, open, type StorageFailureCode, type Store } from "./storage.js"
import { Effect, Exit, Fiber } from "effect"
import type { Supervisor } from "./supervisor.js"

export interface Runtime {
  readonly options: Options
  readonly store: Store
  health: Health
  stopping: boolean
  supervision?: { readonly supervisor: Supervisor; readonly fiber: Fiber.Fiber<void, unknown> }
}

export type HealthReason =
  | StorageFailureCode
  | "options_conflict"
  | "invalid_options"
  | "startup_failed"
  | "monitor_failed"
  | "monitor_stopped"

export type Health =
  | Readonly<{ status: "healthy" }>
  | Readonly<{ status: "degraded"; reason: HealthReason; detail: string }>

export type Lease =
  | Readonly<{ health: Health; runtime: Runtime; close: () => Promise<void> }>
  | Readonly<{
      health: { status: "degraded"; reason: HealthReason; detail: string }
      store?: Store
      close: () => Promise<void>
    }>

interface Entry {
  readonly options: Options
  readonly runtime: Promise<Runtime>
  leases: number
}

const runtimes = new Map<string, Entry>()

export async function acquire(options: Options): Promise<Lease> {
  const existing = runtimes.get(options.store)
  if (existing && !equivalent(existing.options, options)) {
    return existing.runtime.then(
      (runtime) =>
        degraded(
          "options_conflict",
          "Delegation activations for one store must use equivalent options",
          runtime.store,
        ),
      () => degraded("options_conflict", "Delegation activations for one store must use equivalent options"),
    )
  }

  const entry = existing ?? {
    options,
    runtime: open(options).then((store) => ({ options, store, health: { status: "healthy" }, stopping: false })),
    leases: 0,
  }
  if (!existing) runtimes.set(options.store, entry)

  try {
    const runtime = await entry.runtime
    entry.leases++
    return healthy(runtime, entry)
  } catch (cause) {
    if (runtimes.get(options.store) === entry) runtimes.delete(options.store)
    if (isStorageFailure(cause)) return degraded(cause.code, cause.message)
    return degraded("startup_failed", cause instanceof Error ? cause.message : String(cause))
  }
}

function healthy(runtime: Runtime, entry: Entry): Lease {
  let closed = false
  return {
    get health() {
      return runtime.health
    },
    runtime,
    async close() {
      if (closed) return
      closed = true
      const current = runtimes.get(runtime.options.store)
      if (current !== entry) return
      current.leases--
      if (current.leases > 0) return
      runtimes.delete(runtime.options.store)
      runtime.stopping = true
      if (runtime.supervision) await Effect.runPromise(Fiber.interrupt(runtime.supervision.fiber))
      await runtime.supervision?.supervisor.close()
      await runtime.store.close()
    },
  }
}

export function supervise(runtime: Runtime, supervisor: Supervisor, monitor: Effect.Effect<void, unknown>) {
  if (runtime.supervision) return runtime.supervision.supervisor
  const fiber = Effect.runFork(monitor)
  runtime.supervision = { supervisor, fiber }
  fiber.addObserver((exit) => {
    if (runtime.stopping) return
    if (Exit.isFailure(exit)) {
      void degrade(runtime, "monitor_failed", String(exit.cause))
      return
    }
    void degrade(runtime, "monitor_stopped", "Delegation event monitor stopped unexpectedly")
  })
  return supervisor
}

export async function degrade(runtime: Runtime, reason: HealthReason, detail: string) {
  if (runtime.health.status === "degraded") return
  runtime.health = { status: "degraded", reason, detail }
  runtime.stopping = true
  if (!runtime.supervision) return
  await Effect.runPromise(Fiber.interrupt(runtime.supervision.fiber))
  await runtime.supervision.supervisor.close()
}

function degraded(reason: HealthReason, detail: string, store?: Store): Lease {
  return { health: { status: "degraded", reason, detail }, ...(store === undefined ? {} : { store }), close: async () => {} }
}

function equivalent(left: Options, right: Options) {
  return left.profile === right.profile && left.store === right.store && left.concurrency === right.concurrency
}

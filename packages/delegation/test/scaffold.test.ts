import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdir, mkdtemp, rm, stat, utimes } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Plugin } from "@opencode-ai/plugin/effect"
import type { CommandExecutor, CommandRegistrationOptions } from "@opencode-ai/plugin/effect/command"
import { Effect, Logger } from "effect"
import DelegationPlugin from "../src/plugin"
import { decode } from "../src/config"
import { developmentConfig, initializeProfile } from "../src/distribution"
import { acquire, degrade, supervise } from "../src/runtime"
import { isStorageFailure, open } from "../src/storage"
import { Supervisor } from "../src/supervisor"

describe("delegation package scaffold", () => {
  test("decodes and normalizes coordinator options", () => {
    const profile = path.join(import.meta.dir, "profile")
    expect(
      decode({
        profile,
        store: path.join(profile, ".", "coordinator.sqlite"),
        concurrency: 3,
      }),
    ).toEqual({
      profile: path.resolve(profile),
      store: path.join(path.resolve(profile), "coordinator.sqlite"),
      concurrency: 3,
    })
    expect(() => decode({ profile, store: path.join(profile, "coordinator.sqlite"), concurrency: 0 })).toThrow()
    expect(() => decode({ profile, store: path.join(profile, "..", "outside.sqlite"), concurrency: 1 })).toThrow()
    expect(decode({ profile, store: path.join(profile, "coordinator.sqlite") }).concurrency).toBe(6)
  })

  test("normalizes SQLite operational errors into fail-closed storage failures", async () => {
    await using tmp = await tempDirectory()
    const options = await initializeProfile({ profile: tmp.path })
    const store = await open(options)
    const batch = await store.admit({
      parentID: "parent-a",
      canonical: "batch",
      agent: "general",
      model: { providerID: "openai", modelID: "gpt-5" },
      files: [],
      agents: [],
      skills: [],
      operations: ["one"],
      admittedAt: 1,
    })
    const database = new Database(options.store)
    database.exec(`
      CREATE TRIGGER fail_receipt_ack BEFORE UPDATE OF acknowledged ON delegation_receipt
      BEGIN SELECT RAISE(ABORT, 'simulated SQLite failure'); END;
    `)

    const failure = await store.acknowledgeReceipt(batch.batch.id).catch((cause) => cause)
    expect(isStorageFailure(failure)).toBe(true)
    expect(failure).toMatchObject({ code: "store_unwritable" })
    database.close()
    await store.close()
  })

  test("migrates schema 5 through runtime-safety delivery state", async () => {
    await using tmp = await tempDirectory()
    const options = await initializeProfile({ profile: tmp.path })
    const database = new Database(options.store)
    database.exec(`
      ALTER TABLE delegation_receipt DROP COLUMN conflicted;
      ALTER TABLE delegation_terminal_report DROP COLUMN conflicted;
      ALTER TABLE delegation_recovery DROP COLUMN conflicted;
      ALTER TABLE delegation_control_receipt DROP COLUMN conflicted;
      ALTER TABLE delegation_operation DROP COLUMN completion_observed_at;
      DROP TABLE delegation_permission_wait;
      ALTER TABLE delegation_operation DROP COLUMN execution_ended_at;
      ALTER TABLE delegation_operation DROP COLUMN execution_end_source;
      ALTER TABLE delegation_operation DROP COLUMN terminal_reason_code;
      ALTER TABLE delegation_operation DROP COLUMN recovery_reconciled_at;
      ALTER TABLE delegation_operation DROP COLUMN recovery_eligible;
      UPDATE delegation_meta SET value = '5' WHERE key = 'schema';
      PRAGMA user_version = 5;
    `)
    database.close()

    await initializeProfile({ profile: tmp.path })
    const store = await open(options)
    const admitted = await store.admit({
      parentID: "parent-a",
      canonical: "migrated",
      agent: "general",
      model: { providerID: "openai", modelID: "gpt-5" },
      files: [],
      agents: [],
      skills: [],
      operations: ["migrated"],
      admittedAt: 1,
    })
    await store.acknowledgeReceipt(admitted.batch.id)
    expect((await store.snapshot({ parentID: "parent-a" })).delivery).toEqual({
      admission: { pending: 0, conflicted: 0 },
      terminal: { pending: 0, conflicted: 0 },
      recovery: { pending: 0, conflicted: 0 },
      control: { pending: 0, conflicted: 0 },
    })
    await store.close()
  })

  test("initializes and verifies a dedicated durable profile", async () => {
    await using tmp = await tempDirectory()
    const options = await initializeProfile({ profile: tmp.path, concurrency: 2 })
    const store = await open(options)

    expect(await store.check()).toBe("ok")
    await store.close()
    expect(await Bun.file(path.join(tmp.path, "profile.json")).json()).toEqual({ version: 1 })
  })

  test("fails closed for an uninitialized profile", async () => {
    await using tmp = await tempDirectory()
    const options = decode({
      profile: tmp.path,
      store: path.join(tmp.path, "coordinator.sqlite"),
      concurrency: 1,
    })

    await expect(open(options)).rejects.toMatchObject({ code: "profile_uninitialized" })
  })

  test("shares one runtime across concurrent activations until its final lease closes", async () => {
    await using tmp = await tempDirectory()
    const options = await initializeProfile({ profile: tmp.path, concurrency: 2 })
    const [first, second] = await Promise.all([acquire(options), acquire(options)])

    if (!("runtime" in first) || !("runtime" in second)) throw new Error("expected healthy runtime leases")
    expect(first.runtime).toBe(second.runtime)
    let monitors = 0
    let stopped = 0
    const monitor = Effect.sync(() => monitors++).pipe(
      Effect.andThen(Effect.never),
      Effect.ensuring(Effect.sync(() => stopped++)),
    )
    const firstSupervisor = supervise(
      first.runtime,
      new Supervisor(first.runtime.store, options.concurrency, supervisorServices),
      monitor,
    )
    const secondSupervisor = supervise(
      second.runtime,
      new Supervisor(second.runtime.store, options.concurrency, supervisorServices),
      monitor,
    )
    await Bun.sleep(0)
    expect(secondSupervisor).toBe(firstSupervisor)
    expect(monitors).toBe(1)
    await first.close()
    expect(stopped).toBe(0)
    expect(await second.runtime.store.check()).toBe("ok")
    await second.close()
    expect(stopped).toBe(1)
    await expect(second.runtime.store.check()).rejects.toMatchObject({ code: "store_closed" })
  })

  test("fails closed while another runtime owns the store", async () => {
    await using tmp = await tempDirectory()
    const options = await initializeProfile({ profile: tmp.path, concurrency: 2 })
    const first = await open(options)

    await expect(open(options)).rejects.toMatchObject({ code: "store_owned" })
    await first.close()
  })

  test("detects coordinator ownership loss after startup without deleting the replacement guard", async () => {
    await using tmp = await tempDirectory()
    const options = await initializeProfile({ profile: tmp.path, concurrency: 1 })
    const store = await open(options)
    const owner = path.join(`${options.store}.owner`, "owner.json")
    await Bun.write(owner, JSON.stringify({ pid: process.pid, token: "replacement" }))

    await expect(store.check()).rejects.toMatchObject({ code: "store_owned" })
    await expect(
      store.admit({
        parentID: "parent-a",
        canonical: "lost-owner",
        agent: "general",
        model: { providerID: "openai", modelID: "gpt-5" },
        files: [],
        agents: [],
        skills: [],
        operations: ["must not commit"],
        admittedAt: 1,
      }),
    ).rejects.toMatchObject({ code: "store_owned" })
    await store.close()
    expect(await Bun.file(owner).exists()).toBe(true)
    await rm(`${options.store}.owner`, { recursive: true, force: true })
  })

  test("does not steal an ownership guard while another process is initializing it", async () => {
    await using tmp = await tempDirectory()
    const options = await initializeProfile({ profile: tmp.path, concurrency: 1 })
    await rm(`${options.store}.owner`, { recursive: true, force: true })
    await mkdir(`${options.store}.owner`)

    await expect(open(options)).rejects.toMatchObject({ code: "store_owned" })
    expect((await stat(`${options.store}.owner`)).isDirectory()).toBe(true)
    await rm(`${options.store}.owner`, { recursive: true, force: true })
  })

  test("serializes stale ownership reclamation", async () => {
    await using tmp = await tempDirectory()
    const options = await initializeProfile({ profile: tmp.path, concurrency: 1 })
    const owner = `${options.store}.owner`
    await rm(owner, { recursive: true, force: true })
    await mkdir(owner)
    await Bun.write(path.join(owner, "owner.json"), JSON.stringify({ pid: 2_147_483_647, token: "stale" }))
    await mkdir(`${owner}.reclaim`)

    await expect(open(options)).rejects.toMatchObject({ code: "store_owned" })
    expect(await Bun.file(path.join(owner, "owner.json")).exists()).toBe(true)
    await rm(`${owner}.reclaim`, { recursive: true, force: true })
    await rm(owner, { recursive: true, force: true })
  })

  test("recovers owner and reclamation guards left by crashed processes", async () => {
    await using tmp = await tempDirectory()
    const options = await initializeProfile({ profile: tmp.path, concurrency: 1 })
    const owner = `${options.store}.owner`
    const reclaim = `${owner}.reclaim`
    await rm(owner, { recursive: true, force: true })
    const stale = new Date(Date.now() - 10_000)
    await mkdir(owner)
    await utimes(owner, stale, stale)
    const incomplete = await open(options)
    expect(await incomplete.check()).toBe("ok")
    await incomplete.close()

    await mkdir(owner)
    await Bun.write(path.join(owner, "owner.json"), JSON.stringify({ pid: 2_147_483_647, token: "stale" }))
    await mkdir(reclaim)
    await utimes(owner, stale, stale)
    await utimes(reclaim, stale, stale)

    const store = await open(options)

    expect(await store.check()).toBe("ok")
    await store.close()
  })

  test("keeps conflicting activations visible but degraded", async () => {
    await using tmp = await tempDirectory()
    const options = await initializeProfile({ profile: tmp.path, concurrency: 2 })
    const healthy = await acquire(options)
    const conflict = await acquire({ ...options, concurrency: 3 })

    expect(healthy.health).toEqual({ status: "healthy" })
    expect(conflict.health).toMatchObject({ status: "degraded", reason: "options_conflict" })
    expect("store" in conflict).toBe(true)
    await conflict.close()
    await healthy.close()
  })

  test("moves a shared runtime to degraded fail-closed health without discarding its store", async () => {
    await using tmp = await tempDirectory()
    const options = await initializeProfile({ profile: tmp.path, concurrency: 1 })
    const lease = await acquire(options)
    if (!("runtime" in lease)) throw new Error("expected healthy runtime lease")
    const interrupted: string[] = []
    const supervisor = new Supervisor(lease.runtime.store, 1, {
      ...supervisorServices,
      interrupt: async (sessionID) => interrupted.push(sessionID),
    })
    supervise(lease.runtime, supervisor, Effect.never)

    await degrade(lease.runtime, "store_corrupt", "quick_check failed")

    expect(lease.health).toEqual({ status: "degraded", reason: "store_corrupt", detail: "quick_check failed" })
    expect(await lease.runtime.store.check()).toBe("ok")
    await lease.close()
  })

  test("degrades the shared runtime when its event monitor fails", async () => {
    await using tmp = await tempDirectory()
    const options = await initializeProfile({ profile: tmp.path, concurrency: 1 })
    const lease = await acquire(options)
    if (!("runtime" in lease)) throw new Error("expected healthy runtime lease")
    supervise(
      lease.runtime,
      new Supervisor(lease.runtime.store, 1, supervisorServices),
      Effect.fail(new Error("event stream failed")),
    )

    await Bun.sleep(0)

    expect(lease.health).toMatchObject({ status: "degraded", reason: "monitor_failed" })
    await lease.close()
  })

  test("generates an explicit local development plugin entry", async () => {
    await using tmp = await tempDirectory()
    const config = await developmentConfig({ profile: tmp.path, concurrency: 4 })

    expect(config.plugins[0]).toMatchObject({
      package: path.resolve(import.meta.dir, "../src/plugin.ts"),
      options: {
        profile: path.resolve(tmp.path),
        store: path.join(path.resolve(tmp.path), "coordinator.sqlite"),
        concurrency: 4,
      },
    })
  })

  test("exports one stable Effect plugin", () => {
    expect(DelegationPlugin.id).toBe("opencode.delegation")
    expect(typeof DelegationPlugin.effect).toBe("function")
  })

  test("keeps only the control transport out of command discovery", async () => {
    const registrations: Array<{ readonly name: string; readonly options?: CommandRegistrationOptions }> = []
    const context = {
      options: { profile: "invalid" },
      command: {
        register: (name: string, _execute: CommandExecutor, options?: CommandRegistrationOptions) =>
          Effect.sync(() => {
            registrations.push({ name, ...(options === undefined ? {} : { options }) })
            return { dispose: Effect.void }
          }),
      },
      plugin: {
        query: {
          register: () => Effect.succeed({ dispose: Effect.void }),
        },
      },
    }

    await Effect.runPromise(
      // Only command and query registration are evaluated after intentionally degraded activation.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      Effect.scoped(DelegationPlugin.effect(context as unknown as Plugin.Context)).pipe(
        Effect.provide(Logger.layer([])),
      ),
    )

    expect(registrations).toEqual([
      { name: "delegate" },
      { name: "delegation", options: { discoverable: false } },
    ])
  })
})

const supervisorServices = {
  parentExists: async () => true,
  validate: async () => {},
  createChild: async () => "child",
  prompt: async () => {},
  resume: async () => {},
  cancelInbox: async () => {},
  interrupt: async () => {},
  steer: async () => {},
  messages: async () => [],
  synthetic: async () => {},
}

async function tempDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-delegation-"))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

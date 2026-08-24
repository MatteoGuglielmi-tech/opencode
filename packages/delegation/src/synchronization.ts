export * as DelegationSynchronization from "./synchronization.js"

import type { WorkspaceResult } from "./supervision.js"
import { reconcileHistoryRefresh } from "./supervision.js"

type Workspace = Extract<WorkspaceResult, { readonly type: "workspace" }>

export interface SynchronizationClock {
  readonly setTimeout: (run: () => void, delay: number) => number
  readonly clearTimeout: (timer: number) => void
}

export type SynchronizationFailure = {
  readonly code:
    | "plugin_unavailable"
    | "query_unavailable"
    | "invalid_request"
    | "invalid_response"
    | "coordinator_unavailable"
    | "projection_invalid"
    | "timeout"
  readonly detail?: string
}

export type CombinedSupervision<Permission> = {
  readonly workspace: Workspace
  readonly permissions: ReadonlyMap<string, ReadonlyArray<Permission>>
}

export type SynchronizationState<Permission> =
  | { readonly freshness: "loading"; readonly combined?: undefined; readonly failure?: undefined }
  | {
      readonly freshness: "live" | "stale" | "degraded"
      readonly combined?: CombinedSupervision<Permission>
      readonly failure?: SynchronizationFailure
    }

export function createSupervisionSynchronization<Permission = never>(input: {
  readonly load: (request?: {
    readonly generation: number
    readonly history: ReadonlyArray<{
      readonly parentID: string
      readonly limit: number
      readonly operationID?: string
    }>
  }) => Promise<WorkspaceResult>
  readonly permissions: (childIDs: ReadonlyArray<string>) => Promise<ReadonlyMap<string, ReadonlyArray<Permission>>>
  readonly publish: (state: SynchronizationState<Permission>) => void
  readonly unresolvedLocal?: () => boolean
  readonly clock?: SynchronizationClock
}) {
  const clock = input.clock ?? systemClock
  let state: SynchronizationState<Permission> = { freshness: "loading" }
  let mounted = false
  let requested = false
  let active: Promise<void> | undefined
  let serial = Promise.resolve()
  let timer: number | undefined
  let failures = 0
  let localActions = 0

  const publish = (next: SynchronizationState<Permission>) => {
    if (!mounted) return
    state = next
    input.publish(next)
  }

  const clearTimer = () => {
    if (timer === undefined) return
    clock.clearTimeout(timer)
    timer = undefined
  }

  const schedule = (delay: number) => {
    if (!mounted) return
    clearTimer()
    timer = clock.setTimeout(() => {
      timer = undefined
      void refresh()
    }, delay)
  }

  const serialize = <Value>(task: () => Promise<Value>) => {
    const result = serial.then(task, task)
    serial = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }

  const attempt = () =>
    serialize(async () => {
      if (!mounted) return
      const previous = state.combined
      const request = previous
        ? {
            generation: previous.workspace.generation + 1,
            history: previous.workspace.parents.map((parent) => ({
              parentID: parent.session.id,
              limit: Math.max(1, parent.operations.length),
              ...(parent.session.id === previous.workspace.focus?.parentID && previous.workspace.focus.operationID
                ? { operationID: previous.workspace.focus.operationID }
                : {}),
            })),
          }
        : undefined
      const result = await within(input.load(request), clock, 5_000)
      if (result.type !== "workspace") {
        if (result.type === "history-page") throw new RefreshFailure("invalid_response")
        throw new RefreshFailure(result.code, result.detail)
      }
      const workspace = previous ? reconcileHistoryRefresh(previous.workspace, result) : result
      const childIDs = [
        ...new Set(
          workspace.parents.flatMap((parent) =>
            parent.operations.flatMap((operation) =>
              operation.presentationState !== "terminal" && operation.childID ? [operation.childID] : [],
            ),
          ),
        ),
      ].toSorted()
      const permissions = await within(input.permissions(childIDs), clock, 5_000)
      if (!mounted) return
      if (workspace.health.status === "healthy") failures = 0
      publish({
        freshness: workspace.health.status === "healthy" ? "live" : "degraded",
        combined: { workspace, permissions },
      })
      const unresolved =
        localActions > 0 ||
        input.unresolvedLocal?.() ||
        workspace.parents.some((parent) =>
          parent.operations.some((operation) => operation.presentationState !== "terminal"),
        )
      schedule(unresolved ? 1_000 : 5_000)
    })

  const refresh = () => {
    if (!mounted) return Promise.resolve()
    clearTimer()
    if (active) {
      requested = true
      return active
    }
    active = attempt()
      .catch((cause) => {
        if (!mounted) return
        const failure = refreshFailure(cause)
        publish({
          freshness: "stale",
          ...(state.combined ? { combined: state.combined } : {}),
          failure,
        })
        schedule([1_000, 2_000, 4_000, 8_000][failures++] ?? 15_000)
      })
      .finally(() => {
        active = undefined
        if (!mounted || !requested) return
        requested = false
        void refresh()
      })
    return active
  }

  return {
    start() {
      if (mounted) return
      mounted = true
      input.publish(state)
      void refresh()
    },
    stop() {
      mounted = false
      requested = false
      clearTimer()
    },
    request() {
      if (!mounted) return
      void refresh()
    },
    async reconcile() {
      await refresh()
      await serial
      return state
    },
    trackAction() {
      localActions++
      if (mounted) void refresh()
      let completed = false
      return () => {
        if (completed) return
        completed = true
        localActions--
        if (mounted) void refresh()
      }
    },
    mutationsEnabled: () => state.freshness === "live",
    serialize,
    current: () => state,
    async idle() {
      while (active || requested) {
        await active
        await Promise.resolve()
      }
      await serial
    },
  }
}

class RefreshFailure extends Error {
  constructor(
    readonly code: SynchronizationFailure["code"],
    readonly detail?: string,
  ) {
    super(detail ?? code)
  }
}

function refreshFailure(cause: unknown): SynchronizationFailure {
  if (cause instanceof RefreshFailure) return { code: cause.code, ...(cause.detail ? { detail: cause.detail } : {}) }
  const tag = typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : undefined
  const detail = cause instanceof Error ? cause.message : undefined
  if (tag === "PluginUnavailableError") return { code: "plugin_unavailable", ...(detail ? { detail } : {}) }
  if (tag === "PluginQueryUnavailableError") return { code: "query_unavailable", ...(detail ? { detail } : {}) }
  if (tag === "PluginQueryInvalidRequestError") return { code: "invalid_request", ...(detail ? { detail } : {}) }
  return { code: "invalid_response", ...(detail ? { detail } : {}) }
}

function within<Value>(promise: Promise<Value>, clock: SynchronizationClock, delay: number) {
  return new Promise<Value>((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(new RefreshFailure("timeout", "Refresh timed out after five seconds")), delay)
    promise.then(
      (value) => {
        clock.clearTimeout(timer)
        resolve(value)
      },
      (cause) => {
        clock.clearTimeout(timer)
        reject(cause)
      },
    )
  })
}

const systemClock: SynchronizationClock = {
  setTimeout: (run, delay) => Number(setTimeout(run, delay)),
  clearTimeout: (timer) => clearTimeout(timer),
}

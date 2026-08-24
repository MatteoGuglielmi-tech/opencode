import { describe, expect, test } from "bun:test"
import {
  createSupervisionSynchronization,
  type SynchronizationClock,
  type SynchronizationState,
} from "../src/synchronization"
import type { WorkspaceResult } from "../src/supervision"

describe("Delegation supervision synchronization", () => {
  test("polls active work every second and terminal work every five seconds without event hints", async () => {
    const clock = fakeClock()
    const calls: number[] = []
    const snapshots = [workspace("running", 1), workspace("terminal", 2), workspace("terminal", 3)]
    const harness = createSupervisionSynchronization({
      clock,
      load: async () => (calls.push(clock.now()), snapshots.shift()!),
      permissions: async () => new Map(),
      publish() {},
    })

    harness.start()
    await harness.idle()
    expect(calls).toEqual([0])
    await clock.advance(999)
    expect(calls).toEqual([0])
    await clock.advance(1)
    await harness.idle()
    expect(calls).toEqual([0, 1_000])
    await clock.advance(4_999)
    expect(calls).toHaveLength(2)
    await clock.advance(1)
    await harness.idle()
    expect(calls).toEqual([0, 1_000, 6_000])
  })

  test("event hints request an early snapshot and coalesce while refresh is running", async () => {
    const clock = fakeClock()
    const pending: Array<(value: WorkspaceResult) => void> = []
    let calls = 0
    const harness = createSupervisionSynchronization({
      clock,
      load: () =>
        new Promise((resolve) => {
          calls++
          pending.push(resolve)
        }),
      permissions: async () => new Map(),
      publish() {},
    })

    harness.start()
    harness.request()
    harness.request()
    await Promise.resolve()
    expect(calls).toBe(1)
    pending.shift()!(workspace("running", 1))
    await settle()
    expect(calls).toBe(2)
    pending.shift()!(workspace("running", 2))
    await harness.idle()
    expect(calls).toBe(2)
  })

  test("polls terminal work every second while a local action is unresolved and refreshes on completion", async () => {
    const clock = fakeClock()
    const calls: number[] = []
    const harness = createSupervisionSynchronization({
      clock,
      load: async () => (calls.push(clock.now()), workspace("terminal", calls.length)),
      permissions: async () => new Map(),
      publish() {},
    })

    harness.start()
    await harness.idle()
    const complete = harness.trackAction()
    await harness.idle()
    await clock.advance(1_000)
    await harness.idle()
    expect(calls).toEqual([0, 0, 1_000])
    complete()
    await harness.idle()
    expect(calls).toEqual([0, 0, 1_000, 1_000])
  })

  test("awaits an explicit authoritative reconciliation", async () => {
    const clock = fakeClock()
    let calls = 0
    const harness = createSupervisionSynchronization({
      clock,
      load: async () => workspace("running", ++calls),
      permissions: async () => new Map(),
      publish() {},
    })

    harness.start()
    await harness.idle()
    const state = await harness.reconcile()

    expect(calls).toBe(2)
    expect(state).toMatchObject({ freshness: "live", combined: { workspace: { observedAt: 2 } } })
  })

  test("applies delegation facts and required child permissions atomically", async () => {
    const clock = fakeClock()
    const published: SynchronizationState<string>[] = []
    let finishPermissions: (value: ReadonlyMap<string, ReadonlyArray<string>>) => void = () => {}
    const harness = createSupervisionSynchronization<string>({
      clock,
      load: async () => workspace("running", 1),
      permissions: (childIDs) => {
        expect(childIDs).toEqual(["ses_child"])
        return new Promise((resolve) => {
          finishPermissions = resolve
        })
      },
      publish: (state) => published.push(state),
    })

    harness.start()
    await settle()
    expect(published).toEqual([{ freshness: "loading" }])
    finishPermissions(new Map([["ses_child", ["per_one"]]]))
    await harness.idle()
    expect(published.at(-1)).toMatchObject({
      freshness: "live",
      combined: { workspace: { observedAt: 1 } },
    })
    expect(published.at(-1)?.combined?.permissions.get("ses_child")).toEqual(["per_one"])
  })

  test("times out after five seconds, retains the complete view, and retries with bounded backoff", async () => {
    const clock = fakeClock()
    const states: SynchronizationState<never>[] = []
    let calls = 0
    const harness = createSupervisionSynchronization({
      clock,
      load: async () => {
        calls++
        if (calls === 1) return workspace("running", 1)
        return new Promise<WorkspaceResult>(() => {})
      },
      permissions: async () => new Map(),
      publish: (state) => states.push(state),
    })

    harness.start()
    await harness.idle()
    await clock.advance(1_000)
    await clock.advance(5_000)
    await harness.idle()
    expect(states.at(-1)).toMatchObject({ freshness: "stale", combined: { workspace: { observedAt: 1 } } })
    expect(harness.mutationsEnabled()).toBe(false)
    expect(calls).toBe(2)
    await clock.advance(999)
    expect(calls).toBe(2)
    await clock.advance(1)
    expect(calls).toBe(3)
  })

  test("uses one, two, four, eight, then fifteen second retry delays and explicit refresh bypasses them", async () => {
    const clock = fakeClock()
    const calls: number[] = []
    const harness = createSupervisionSynchronization({
      clock,
      load: async () => {
        calls.push(clock.now())
        throw new Error("offline")
      },
      permissions: async () => new Map(),
      publish() {},
    })

    harness.start()
    await harness.idle()
    for (const delay of [1_000, 2_000, 4_000, 8_000, 15_000]) {
      await clock.advance(delay)
      await harness.idle()
    }
    expect(calls).toEqual([0, 1_000, 3_000, 7_000, 15_000, 30_000])
    await clock.advance(1)
    harness.request()
    await harness.idle()
    expect(calls.at(-1)).toBe(30_001)
  })

  test("a safe degraded snapshot replaces older data and freezes timing at its observation", async () => {
    const clock = fakeClock()
    const snapshots = [
      workspace("running", 1),
      { ...workspace("running", 2), health: { status: "degraded" as const, reason: "monitor_failed", detail: "lost" } },
    ]
    let state: SynchronizationState<never> = { freshness: "loading" }
    const harness = createSupervisionSynchronization({
      clock,
      load: async () => snapshots.shift()!,
      permissions: async () => new Map(),
      publish: (value) => (state = value),
    })

    harness.start()
    await harness.idle()
    harness.request()
    await harness.idle()
    expect(state).toMatchObject({ freshness: "degraded", combined: { workspace: { observedAt: 2 } } })
    expect(harness.mutationsEnabled()).toBe(false)
  })

  test("retains the previous combined snapshot when required permission synchronization fails", async () => {
    const clock = fakeClock()
    let calls = 0
    const harness = createSupervisionSynchronization<string>({
      clock,
      load: async () => workspace("running", ++calls),
      permissions: async () => {
        if (calls === 1) return new Map([["ses_child", ["per_one"]]])
        throw new Error("permission unavailable")
      },
      publish() {},
    })

    harness.start()
    await harness.idle()
    harness.request()
    await harness.idle()
    expect(harness.current()).toMatchObject({
      freshness: "stale",
      combined: { workspace: { observedAt: 1 } },
      failure: { code: "invalid_response", detail: "permission unavailable" },
    })
    expect(harness.current().combined?.permissions.get("ses_child")).toEqual(["per_one"])
  })

  test("serializes pagination with refresh and drops queued refresh work after unmount", async () => {
    const clock = fakeClock()
    let calls = 0
    let finishPagination = () => {}
    const harness = createSupervisionSynchronization({
      clock,
      load: async () => (calls++, workspace("running", calls)),
      permissions: async () => new Map(),
      publish() {},
    })

    harness.start()
    await harness.idle()
    const pagination = harness.serialize(
      () =>
        new Promise<void>((resolve) => {
          finishPagination = resolve
        }),
    )
    await settle()
    harness.request()
    await settle()
    expect(calls).toBe(1)
    harness.stop()
    finishPagination()
    await pagination
    await harness.idle()
    expect(calls).toBe(1)
  })

  test("reloads current depth and preserves stable focus across concurrent insertion", async () => {
    const clock = fakeClock()
    const requests: unknown[] = []
    const first = workspace("running", 1)
    first.parents[0].operations.push(operation("dop_old", "terminal"))
    first.focus = { parentID: "ses_parent", operationID: "dop_old" }
    const second = workspace("running", 2)
    second.parents[0].operations.unshift(operation("dop_new", "running"))
    second.parents[0].operations.push(operation("dop_old", "terminal"))
    const snapshots = [first, second]
    const harness = createSupervisionSynchronization<never>({
      clock,
      load: async (request) => (requests.push(request), snapshots.shift()!),
      permissions: async () => new Map(),
      publish() {},
    })

    harness.start()
    await harness.idle()
    harness.request()
    await harness.idle()
    expect(requests[1]).toMatchObject({ history: [{ parentID: "ses_parent", limit: 2, operationID: "dop_old" }] })
    const state = harness.current()
    expect(state.combined?.workspace.focus).toEqual({ parentID: "ses_parent", operationID: "dop_old" })
    expect(state.combined?.workspace.parents[0].operations.map((item) => item.id)).toEqual([
      "dop_new",
      "dop_running",
      "dop_old",
    ])
  })
})

function workspace(state: "running" | "terminal", observedAt: number) {
  return {
    type: "workspace" as const,
    generation: observedAt,
    health: { status: "healthy" as const },
    observedAt,
    parents: [
      {
        session: { id: "ses_parent", archived: false, updated: observedAt },
        counts: {
          total: 1,
          queued: 0,
          starting: 0,
          running: state === "running" ? 1 : 0,
          finalizing: 0,
          waiting: 0,
          completed: state === "terminal" ? 1 : 0,
          failed: 0,
          interrupted: 0,
          cancellationRequested: 0,
          recoveryEligible: 0,
          actionable: state === "running" ? 1 : 0,
          deliveryPending: 0,
          deliveryConflicted: 0,
        },
        lastActivityAt: observedAt,
        newestActionableOperationID: state === "running" ? "dop_running" : undefined,
        newestOperationID: "dop_running",
        batches: [],
        operations: [operation("dop_running", state)],
      },
    ],
    focus: { parentID: "ses_parent", operationID: "dop_running" },
  }
}

function operation(id: string, state: "running" | "terminal") {
  return {
    id,
    batchID: "dlg_batch",
    parentID: "ses_parent",
    index: 0,
    text: id,
    internalState: state === "running" ? ("running" as const) : ("completed" as const),
    presentationState: state,
    cancellationRequested: false,
    agent: "general",
    model: { providerID: "openai", modelID: "gpt-5" },
    childID: state === "running" ? "ses_child" : undefined,
    timeline: { admittedAt: 0, permissionWaits: [] },
    ...(state === "terminal"
      ? { outcome: { state: "completed" as const, reason: { code: "completed" as const } } }
      : {}),
  }
}

function fakeClock(): SynchronizationClock & { now(): number; advance(ms: number): Promise<void> } {
  let time = 0
  let id = 0
  const timers = new Map<number, { at: number; run: () => void }>()
  return {
    now: () => time,
    setTimeout(run, delay) {
      const token = ++id
      timers.set(token, { at: time + delay, run })
      return token
    },
    clearTimeout(token) {
      timers.delete(token)
    },
    async advance(ms) {
      const target = time + ms
      while (true) {
        const next = [...timers.entries()].toSorted((left, right) => left[1].at - right[1].at)[0]
        if (!next || next[1].at > target) break
        time = next[1].at
        timers.delete(next[0])
        next[1].run()
        await Promise.resolve()
        await Promise.resolve()
      }
      time = target
    },
  }
}

async function settle() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

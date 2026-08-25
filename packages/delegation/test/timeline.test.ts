import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { decode } from "../src/config"
import { initialize, open, type Store } from "../src/storage"
import { projectWorkspace } from "../src/supervision"
import { operationInspector, timelineTrack } from "../src/tui"
import { ltrDirection } from "../src/direction"

describe("Delegation operation timelines", () => {
  test("retains immutable milestones, aggregate permission waits, Finalizing, and Terminal truth", async () => {
    await using fixture = await timelineStore()
    const admitted = await fixture.store.admit(request(["ordinary completion"], 10))
    const operationID = admitted.batch.operations[0].id
    await fixture.store.acknowledgeReceipt(admitted.batch.id)
    await fixture.store.claimQueued(1, 20)
    await fixture.store.transition(operationID, ["starting"], "running", { executionStartedAt: 30 })
    await fixture.store.startPermissionWait(operationID, 40)
    await fixture.store.startPermissionWait(operationID, 41)
    await fixture.store.endPermissionWait(operationID, 50, "replied")
    await fixture.store.transition(operationID, ["running"], "running", {
      executionEndedAt: 60,
      executionEndSource: "session_event",
    })

    const finalizing = await projection(fixture.store, 70)
    expect(finalizing).toMatchObject({
      type: "workspace",
      observedAt: 70,
      parents: [
        {
          operations: [
            {
              id: operationID,
              presentationState: "finalizing",
              timeline: {
                admittedAt: 10,
                permitClaimedAt: 20,
                executionStartedAt: 30,
                executionEndedAt: 60,
                executionEndSource: "session_event",
                permissionWaits: [{ sequence: 1, startedAt: 40, endedAt: 50, closeReason: "replied" }],
              },
            },
          ],
        },
      ],
    })

    await fixture.store.transition(operationID, ["running"], "completed", {
      terminalAt: 80,
      reasonCode: "completed",
      outcome: "done",
    })
    await fixture.store.transition(operationID, ["completed"], "failed", {
      terminalAt: 90,
      reasonCode: "execution_failed",
    })
    await fixture.store.close()
    fixture.store = await open(fixture.options)
    const terminal = await projection(fixture.store, 100)
    expect(terminal).toMatchObject({
      type: "workspace",
      observedAt: 100,
      parents: [
        {
          operations: [
            {
              presentationState: "terminal",
              outcome: { state: "completed", reason: { code: "completed" } },
              timeline: { executionEndedAt: 60, concludedAt: 80 },
            },
          ],
        },
      ],
    })
  })

  test("uses observedAt for open phases and exposes queue facts and batch timing independently of pagination", async () => {
    await using fixture = await timelineStore()
    const batch = await fixture.store.admit(request(["first", "second"], 10))

    const queued = await projection(fixture.store, 25)
    expect(queued).toMatchObject({
      type: "workspace",
      observedAt: 25,
      parents: [
        {
          batches: [{ id: batch.batch.id }],
          operations: [
            { queuePosition: 1, queueBlocker: "admission_delivery", presentationState: "queued" },
            { queuePosition: 2, queueBlocker: "admission_delivery", presentationState: "queued" },
          ],
        },
      ],
    })
    if (queued.type !== "workspace") throw new Error("expected workspace")
    expect(timelineTrack(queued.parents[0].operations[0], queued.observedAt)).toContain("Queue 15ms")

    await fixture.store.acknowledgeReceipt(batch.batch.id)
    await fixture.store.claimQueued(1, 30)
    await fixture.store.transition(batch.batch.operations[0].id, ["starting"], "failed", {
      terminalAt: 40,
      reasonCode: "setup_failed",
      reason: "setup failed",
    })
    await fixture.store.claimQueued(1, 50)
    await fixture.store.transition(batch.batch.operations[1].id, ["starting"], "interrupted", {
      terminalAt: 60,
      reasonCode: "cancelled_before_start",
      reason: "cancelled before start",
    })

    expect(await fixture.store.snapshot({ parentID: "parent-a", limit: 1 })).toMatchObject({
      batches: [
        {
          startedAt: 30,
          concludedAt: 60,
          outcomes: { completed: 0, failed: 1, interrupted: 1 },
        },
      ],
    })
  })

  test("normalizes conclusion through an open permission wait and renders waiting as an overlay", async () => {
    await using fixture = await timelineStore()
    const batch = await fixture.store.admit(request(["wait then stop"], 10))
    await fixture.store.acknowledgeReceipt(batch.batch.id)
    await fixture.store.claimQueued(1, 20)
    await fixture.store.startPermissionWait(batch.batch.operations[0].id, 40)
    await fixture.store.transition(batch.batch.operations[0].id, ["waiting"], "interrupted", {
      terminalAt: 30,
      reasonCode: "user_interrupted",
    })

    const result = await projection(fixture.store, 50)
    expect(result).toMatchObject({
      type: "workspace",
      parents: [
        {
          operations: [
            {
              timeline: {
                concludedAt: 40,
                permissionWaits: [
                  { sequence: 1, startedAt: 40, endedAt: 40, closeReason: "operation_concluded" },
                ],
              },
            },
          ],
        },
      ],
    })
    if (result.type !== "workspace") throw new Error("expected workspace")
    expect(timelineTrack(result.parents[0].operations[0], result.observedAt)).toContain("overlays: Waiting")
  })

  test("marks restart execution endpoints as uncertain and closes open permission waits", async () => {
    await using fixture = await timelineStore()
    const batch = await fixture.store.admit(request(["restart"], 10))
    await fixture.store.acknowledgeReceipt(batch.batch.id)
    await fixture.store.claimQueued(1, 20)
    await fixture.store.transition(batch.batch.operations[0].id, ["starting"], "running", {
      childID: "child-restart",
      executionStartedAt: 30,
    })
    await fixture.store.startPermissionWait(batch.batch.operations[0].id, 40)
    await fixture.store.reconcileStartup(50)

    expect(await projection(fixture.store, 60)).toMatchObject({
      type: "workspace",
      parents: [
        {
          operations: [
            {
              presentationState: "terminal",
              timeline: {
                executionEndedAt: 50,
                executionEndSource: "startup_reconciliation",
                concludedAt: 50,
                permissionWaits: [
                  { sequence: 1, startedAt: 40, endedAt: 50, closeReason: "service_restart" },
                ],
              },
              outcome: { reason: { code: "service_restarted" } },
              recovery: {
                reconciledAt: 50,
                previousState: "waiting",
                eligible: true,
              },
            },
          ],
        },
      ],
    })
    const result = await projection(fixture.store, 60)
    if (result.type !== "workspace") throw new Error("expected workspace")
    expect(timelineTrack(result.parents[0].operations[0], result.observedAt)).toContain("uncertain")
  })

  test("projects setup failure, execution failure, cancellation before start, and user interruption distinctly", async () => {
    await using fixture = await timelineStore()
    const active = await fixture.store.admit(request(["setup", "execution", "interruption"], 10))
    const cancelled = await fixture.store.admit(request(["cancelled"], 11))
    await fixture.store.acknowledgeReceipt(active.batch.id)
    await fixture.store.claimQueued(3, 20)
    await fixture.store.transition(active.batch.operations[0].id, ["starting"], "failed", {
      terminalAt: 21,
      reasonCode: "setup_failed",
      reason: "invalid model",
    })
    await fixture.store.transition(active.batch.operations[1].id, ["starting"], "running", {
      executionStartedAt: 22,
    })
    await fixture.store.transition(active.batch.operations[1].id, ["running"], "failed", {
      executionEndedAt: 23,
      executionEndSource: "session_event",
      terminalAt: 23,
      reasonCode: "execution_failed",
      reason: "provider failed",
    })
    await fixture.store.transition(active.batch.operations[2].id, ["starting"], "running", {
      executionStartedAt: 24,
    })
    await fixture.store.transition(active.batch.operations[2].id, ["running"], "interrupted", {
      executionEndedAt: 25,
      executionEndSource: "session_event",
      terminalAt: 25,
      reasonCode: "user_interrupted",
      reason: "stopped",
    })
    await fixture.store.transition(cancelled.batch.operations[0].id, ["queued"], "interrupted", {
      terminalAt: 26,
      reasonCode: "cancelled_before_start",
      reason: "cancelled before start",
    })

    const result = await projection(fixture.store, 30)
    if (result.type !== "workspace") throw new Error("expected workspace")
    expect(result.parents[0].operations.map((operation) => operation.outcome?.reason.code)).toEqual([
      "cancelled_before_start",
      "setup_failed",
      "execution_failed",
      "user_interrupted",
    ])
  })

  test("fails impossible chronology as a typed invalid projection", async () => {
    await using fixture = await timelineStore()
    const batch = await fixture.store.admit(request(["corrupt"], 10))
    await fixture.store.close()
    const database = new Database(fixture.options.store)
    database
      .query("UPDATE delegation_operation SET state = 'running', permit_claimed_at = 30, execution_started_at = 20 WHERE id = ?")
      .run(batch.batch.operations[0].id)
    database.close()
    fixture.store = await open(fixture.options)

    expect(await projection(fixture.store, 40)).toEqual({
      type: "failure",
      code: "projection_invalid",
      detail: expect.stringContaining(batch.batch.operations[0].id),
      health: { status: "degraded", reason: "projection_invalid" },
    })

    await fixture.store.close()
    const inconsistent = new Database(fixture.options.store)
    inconsistent
      .query(
        `UPDATE delegation_operation SET state = 'failed', permit_claimed_at = 30, execution_started_at = 30,
         execution_ended_at = NULL, execution_end_source = NULL, terminal_at = 40,
         terminal_reason_code = 'setup_failed' WHERE id = ?`,
      )
      .run(batch.batch.operations[0].id)
    inconsistent.close()
    fixture.store = await open(fixture.options)
    expect(await projection(fixture.store, 50)).toMatchObject({
      type: "failure",
      code: "projection_invalid",
      detail: expect.stringContaining("setup_failed"),
    })
  })

  test("renders compact textual state and inspectable identity, context, model, outcome, and recovery", async () => {
    await using fixture = await timelineStore()
    const batch = await fixture.store.admit(request(["inspect"], 10))
    await fixture.store.acknowledgeReceipt(batch.batch.id)
    await fixture.store.claimQueued(1, 15)
    await fixture.store.transition(batch.batch.operations[0].id, ["starting"], "failed", {
      terminalAt: 20,
      reasonCode: "setup_failed",
      reason: "provider unavailable",
    })
    const result = await projection(fixture.store, 30)
    if (result.type !== "workspace") throw new Error("expected workspace")
    const operation = result.parents[0].operations[0]

    expect(timelineTrack(operation, result.observedAt)).toContain("Terminal")
    expect(operationInspector(operation, result.observedAt)).toEqual(
      expect.arrayContaining([
        expect.stringContaining(operation.id),
        expect.stringContaining("parent-a"),
        expect.stringContaining("openai/gpt-5"),
        expect.stringContaining(`Observed ${ltrDirection(30)}`),
        expect.stringContaining("setup_failed"),
      ]),
    )
  })
})

async function timelineStore() {
  const profile = await mkdtemp(path.join(os.tmpdir(), "opencode-delegation-timeline-"))
  const options = decode({ profile, store: path.join(profile, "coordinator.sqlite"), concurrency: 1 })
  await initialize(options)
  return {
    options,
    store: await open(options),
    async [Symbol.asyncDispose]() {
      await this.store.close()
      await rm(profile, { recursive: true, force: true })
    },
  }
}

function request(operations: string[], admittedAt: number) {
  return {
    parentID: "parent-a",
    canonical: `${operations.join("-")}-${admittedAt}`,
    agent: "general",
    model: { providerID: "openai", modelID: "gpt-5" },
    files: [],
    agents: [],
    skills: [],
    operations,
    admittedAt,
  }
}

function projection(store: Store, observedAt: number) {
  return projectWorkspace({
    store,
    health: { status: "healthy" },
    sessions: [{ id: "parent-a", title: "Parent", archived: false, updated: 1 }],
    input: {},
    observedAt,
  })
}

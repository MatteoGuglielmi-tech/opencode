import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { execute, parse } from "../src/control"
import { decode } from "../src/config"
import { initialize, isStorageFailure, open, StorageError } from "../src/storage"

describe("delegation controls", () => {
  test("does not classify validation conflicts as runtime storage failures", () => {
    expect(isStorageFailure(new StorageError("control_invalid", "invalid target"))).toBe(false)
    expect(isStorageFailure(new StorageError("control_conflict", "conflicting retry"))).toBe(false)
    expect(isStorageFailure(new StorageError("invocation_conflict", "conflicting admission"))).toBe(false)
    expect(isStorageFailure(new StorageError("store_owned", "ownership lost"))).toBe(true)
  })

  test("parses status filters and literal steer text", () => {
    expect(parse("action=status batch=dlg_1 state=queued cursor=2:3 limit=25")).toEqual({
      action: "status",
      batchID: "dlg_1",
      state: "queued",
      cursor: "2:3",
      limit: 25,
    })
    expect(parse("action=steer operation=dop_1 keep batch=literal and preserve spaces")).toEqual({
      action: "steer",
      operationID: "dop_1",
      text: "keep batch=literal and preserve spaces",
    })
    expect(parse("action=steer operation=dop_1 focus=now")).toEqual({
      action: "steer",
      operationID: "dop_1",
      text: "focus=now",
    })
  })

  test("rejects unknown, duplicate, and incompatible control arguments", () => {
    expect(() => parse("action=status wat=1")).toThrow("Unknown field: wat")
    expect(() => parse("action=status limit=1 limit=2")).toThrow("Duplicate field: limit")
    expect(() => parse("action=status operation=a batch=b")).toThrow("cannot combine")
    expect(() => parse("action=cancel")).toThrow("requires batch or operation")
    expect(() => parse("action=cancel batch=a operation=b")).toThrow("requires exactly one")
    expect(() => parse("action=steer operation=a")).toThrow("requires trailing text")
    expect(() => parse("action=retry batch=a")).toThrow("requires operation")
    expect(() => parse("action=status limit=201")).toThrow("between 1 and 200")
  })

  test("atomically reconciles retry controls and their immutable receipts", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["recover me"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    await store.claimQueued(1, 2)
    await store.transition(batch.batch.operations[0].id, ["starting"], "running", {
      childID: "child-a",
      executionStartedAt: 3,
    })
    await store.reconcileStartup(4)

    const input = {
      parentID: "parent-a",
      invocationID: "control-1",
      canonical: JSON.stringify({ action: "retry", operationID: batch.batch.operations[0].id }),
      action: { action: "retry" as const, operationID: batch.batch.operations[0].id },
      committedAt: 5,
    }
    const first = await store.commitControl(input)
    const retry = first.retryBatchID
    expect(first).toMatchObject({ created: true, retryBatchID: expect.any(String), receipt: { acknowledged: false } })
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({ recoveryEligible: false })
    expect((await store.snapshot({ parentID: "parent-a", batchID: retry })).operations).toEqual([
      expect.objectContaining({ state: "queued", retryOfOperationID: batch.batch.operations[0].id }),
    ])

    expect(await store.commitControl(input)).toEqual({ ...first, created: false })
    await expect(store.commitControl({ ...input, canonical: "different" })).rejects.toMatchObject({
      code: "control_conflict",
    })
    expect(await store.pendingControls()).toHaveLength(1)
    await store.close()
  })

  test("commits only parent-owned cancellation, steering, and dismissal controls", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["running", "queued"], 1))
    const other = await store.admit(request("parent-b", ["private"], 2))
    await store.acknowledgeReceipt(batch.batch.id)
    await store.claimQueued(1, 3)
    await store.transition(batch.batch.operations[0].id, ["starting"], "running", {
      childID: "child-a",
      executionStartedAt: 4,
    })

    const steer = await store.commitControl({
      parentID: "parent-a",
      invocationID: "steer-1",
      canonical: "steer",
      action: { action: "steer", operationID: batch.batch.operations[0].id, text: "focus" },
      committedAt: 5,
    })
    expect(steer.effect).toMatchObject({
      kind: "steer",
      operationID: batch.batch.operations[0].id,
      childID: "child-a",
      text: "focus",
      messageID: expect.stringMatching(/^msg_/),
    })

    const cancel = await store.commitControl({
      parentID: "parent-a",
      invocationID: "cancel-1",
      canonical: "cancel",
      action: { action: "cancel", batchID: batch.batch.id },
      committedAt: 6,
    })
    expect(cancel.effect).toEqual({ kind: "cancel", operationIDs: batch.batch.operations.map((item) => item.id) })
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({ cancellationRequested: true })
    expect(await store.operation(batch.batch.operations[1].id)).toMatchObject({
      state: "interrupted",
      cancellationRequested: true,
    })
    await expect(
      store.commitControl({
        parentID: "parent-a",
        invocationID: "foreign",
        canonical: "foreign",
        action: { action: "dismiss", operationID: other.batch.operations[0].id },
        committedAt: 7,
      }),
    ).rejects.toMatchObject({ code: "control_invalid" })
    expect(await store.pendingControls()).toHaveLength(2)
    await store.close()
  })

  test("delivers status snapshots and applies replayable mutating controls", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["running"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    await store.claimQueued(1, 2)
    await store.transition(batch.batch.operations[0].id, ["starting"], "running", {
      childID: "child-a",
      executionStartedAt: 3,
    })
    const delivered: Array<Record<string, unknown>> = []
    const steered: Array<Record<string, unknown>> = []
    const services = {
      health: () => ({ status: "healthy" as const }),
      cancel: async () => {},
      steer: async (effect: Record<string, unknown>) => steered.push(effect),
      synthetic: (input: Record<string, unknown>) => Effect.sync(() => delivered.push(input)),
    }

    await Effect.runPromise(
      execute({ sessionID: "parent-a", id: "status-1", arguments: "action=status" }, services, store),
    )
    expect(delivered[0]).toMatchObject({
      sessionID: "parent-a",
      delivery: "steer",
      resume: false,
      metadata: {
        source: "delegation",
        kind: "delegation-snapshot",
        version: 1,
        health: { status: "healthy" },
        snapshot: { operations: [{ id: batch.batch.operations[0].id }] },
      },
    })

    const command = {
      sessionID: "parent-a",
      id: "steer-1",
      arguments: `action=steer operation=${batch.batch.operations[0].id} focus now`,
    }
    await Effect.runPromise(execute(command, services, store, () => 4))
    await Effect.runPromise(execute(command, services, store, () => 5))
    expect(steered).toEqual([
      expect.objectContaining({ childID: "child-a", text: "focus now", messageID: expect.stringMatching(/^msg_/) }),
      expect.objectContaining({ childID: "child-a", text: "focus now", messageID: expect.stringMatching(/^msg_/) }),
    ])
    expect(steered[0]?.messageID).toBe(steered[1]?.messageID)
    expect(await store.pendingControls()).toEqual([])

    const degraded = {
      ...services,
      health: () => ({ status: "degraded" as const, reason: "store_owned" as const, detail: "ownership lost" }),
    }
    await Effect.runPromise(execute({ sessionID: "parent-a", arguments: "action=status" }, degraded, store))
    expect(delivered.at(-1)).toMatchObject({ metadata: { health: { status: "degraded", reason: "store_owned" } } })
    await expect(Effect.runPromise(execute(command, degraded, store))).rejects.toMatchObject({
      code: "coordinator_unavailable",
    })
    await store.close()
    await expect(
      Effect.runPromise(execute({ sessionID: "parent-a", arguments: "action=status" }, degraded, store)),
    ).rejects.toMatchObject({ code: "coordinator_unavailable" })
  })

  test("projects pending and conflicted state for every durable delivery lane", async () => {
    await using tmp = await tempDirectory()
    const options = await initializeOptions(tmp.path)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["finish"], 1))
    const operationID = batch.batch.operations[0].id
    await store.acknowledgeReceipt(batch.batch.id)
    await store.claimQueued(1, 2)
    await store.transition(operationID, ["starting"], "completed", { terminalAt: 3, outcome: "result" })
    const blocked = await store.admit(request("parent-a", ["blocked"], 4))
    await store.commitControl({
      parentID: "parent-a",
      invocationID: "control-1",
      canonical: "cancel",
      action: { action: "cancel", operationID },
      committedAt: 5,
    })
    await store.markDeliveryConflict("admission", blocked.batch.id, "parent-a")
    await store.markDeliveryConflict("control", "control-1", "parent-a")

    expect(await store.snapshot({ parentID: "parent-a" })).toMatchObject({
      batches: [{ receiptDelivery: "acknowledged" }, { receiptDelivery: "conflicted" }],
      operations: [
        {
          terminalDelivery: "pending",
          terminalOutcome: { report: expect.stringContaining("result"), metadata: { kind: "terminal-outcome" } },
        },
        { state: "queued" },
      ],
      delivery: {
        admission: { pending: 0, conflicted: 1 },
        terminal: { pending: 1, conflicted: 0 },
        recovery: { pending: 0, conflicted: 0 },
        control: { pending: 0, conflicted: 1 },
      },
    })
    await store.close()
  })
})

async function initializeOptions(profile: string) {
  const options = decode({ profile, store: path.join(profile, "coordinator.sqlite") })
  await initialize(options)
  return options
}

function request(parentID: string, operations: string[], admittedAt: number) {
  return {
    parentID,
    canonical: `${parentID}-${admittedAt}`,
    agent: "general",
    model: { providerID: "openai", modelID: "gpt-5" },
    files: [],
    agents: [],
    skills: [],
    operations,
    admittedAt,
  }
}

async function tempDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-delegation-control-"))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

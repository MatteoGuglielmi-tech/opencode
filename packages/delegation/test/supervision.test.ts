import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { decode } from "../src/config"
import { initialize, open } from "../src/storage"
import { DefinitePromptError, type Services, Supervisor } from "../src/supervisor"

describe("delegation supervision", () => {
  test("claims acknowledged work in per-parent FIFO order up to the configured capacity", async () => {
    await using tmp = await tempDirectory()
    const options = decode({
      profile: tmp.path,
      store: path.join(tmp.path, "coordinator.sqlite"),
      concurrency: 2,
    })
    await initialize(options)
    const store = await open(options)
    const first = await store.admit(request("parent-a", ["one", "two", "three"], 1))
    const other = await store.admit(request("parent-b", ["other"], 2))

    expect(await store.claimQueued(2, 10)).toEqual([])
    await store.acknowledgeReceipt(first.batch.id)
    await store.acknowledgeReceipt(other.batch.id)

    expect((await store.claimQueued(2, 10)).map((operation) => operation.text)).toEqual(["one", "two", "other"])
    expect((await store.claimQueued(2, 11)).map((operation) => operation.text)).toEqual([])
    await store.transition(first.batch.operations[0].id, ["starting"], "failed", { terminalAt: 12, reason: "setup" })
    expect((await store.claimQueued(2, 13)).map((operation) => operation.text)).toEqual(["three"])
    await store.close()
  })

  test("projects parent-scoped durable snapshots with stable pagination", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const first = await store.admit(request("parent-a", ["one", "two"], 1))
    await store.admit(request("parent-b", ["hidden"], 2))
    await store.acknowledgeReceipt(first.batch.id)
    await store.claimQueued(1, 3)

    const page = await store.snapshot({ parentID: "parent-a", limit: 1 })
    expect(page).toMatchObject({
      version: 1,
      batches: [{ id: first.batch.id, sequence: 1 }],
      operations: [{ id: first.batch.operations[0].id, state: "starting", fifoPosition: 1 }],
    })
    expect(page.nextCursor).not.toContain(":")
    expect(await store.snapshot({ parentID: "parent-a", cursor: page.nextCursor, limit: 1 })).toMatchObject({
      operations: [{ id: first.batch.operations[1].id, state: "queued", fifoPosition: 2 }],
    })
    expect(await store.snapshot({ parentID: "parent-b", operationID: first.batch.operations[0].id })).toMatchObject({
      batches: [],
      operations: [],
    })
    await expect(store.snapshot({ parentID: "parent-b", cursor: page.nextCursor, limit: 1 })).rejects.toThrow(
      "snapshot cursor is invalid",
    )
    await store.close()
  })

  test("continues toward older batches when newer work is inserted concurrently", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const oldest = await store.admit(request("parent-a", ["oldest"], 1))
    const middle = await store.admit(request("parent-a", ["middle"], 2))

    const first = await store.snapshot({ parentID: "parent-a", limit: 1 })
    expect(first.operations.map((operation) => operation.id)).toEqual([middle.batch.operations[0].id])
    const newest = await store.admit(request("parent-a", ["newest"], 3))
    const older = await store.snapshot({ parentID: "parent-a", cursor: first.nextCursor, limit: 1 })

    expect(older.operations.map((operation) => operation.id)).toEqual([oldest.batch.operations[0].id])
    expect(older.operations.some((operation) => operation.id === newest.batch.operations[0].id)).toBe(false)
    await store.close()
  })

  test("derives complete batch outcomes independently of operation pagination", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const active = await store.admit(request("parent-a", ["completed", "failed", "queued"], 1))
    const concluded = await store.admit(request("parent-a", ["completed", "failed", "interrupted"], 2))
    await store.transition(active.batch.operations[0].id, ["queued"], "completed", { terminalAt: 3 })
    await store.transition(active.batch.operations[1].id, ["queued"], "failed", { terminalAt: 4 })
    await store.transition(concluded.batch.operations[0].id, ["queued"], "completed", { terminalAt: 5 })
    await store.transition(concluded.batch.operations[1].id, ["queued"], "failed", { terminalAt: 6 })
    await store.transition(concluded.batch.operations[2].id, ["queued"], "interrupted", { terminalAt: 7 })

    const newest = await store.snapshot({ parentID: "parent-a", limit: 3 })
    expect(newest).toMatchObject({
      batches: [
        {
          id: concluded.batch.id,
          status: "concluded",
          outcomes: { completed: 1, failed: 1, interrupted: 1 },
        },
      ],
    })
    expect(
      await store.snapshot({
        parentID: "parent-a",
        cursor: newest.nextCursor,
        limit: 1,
      }),
    ).toMatchObject({
      batches: [
        {
          id: active.batch.id,
          status: "active",
          outcomes: { completed: 1, failed: 1, interrupted: 0 },
        },
      ],
    })
    await store.close()
  })

  test("starts children with a cancellation-safe handshake and follows authoritative events", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["one", "two"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    const calls: Array<{ readonly type: string; readonly input: Record<string, unknown> }> = []
    let child = 0
    let now = 10
    const supervisor = new Supervisor(
      store,
      1,
      {
        parentExists: async () => true,
        validate: async () => {},
        createChild: async (input) => {
          calls.push({ type: "create", input })
          return `child-${++child}`
        },
        prompt: async (input) => calls.push({ type: "prompt", input }),
        resume: async (sessionID) => calls.push({ type: "resume", input: { sessionID } }),
        cancelInbox: async (input) => calls.push({ type: "cancel-inbox", input }),
        interrupt: async (sessionID) => calls.push({ type: "interrupt", input: { sessionID } }),
        steer: async (input) => calls.push({ type: "steer", input }),
        messages: async () => [],
        synthetic: async (input) => calls.push({ type: "synthetic", input }),
      },
      () => now,
    )

    await supervisor.drain()
    expect(calls.map((call) => call.type)).toEqual(["create", "prompt", "resume"])
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "starting",
      childID: "child-1",
      promptAdmitted: true,
    })
    expect(await store.operation(batch.batch.operations[1].id)).toMatchObject({ state: "queued" })

    await supervisor.handle({ type: "permission.asked", sessionID: "child-1", requestID: "permission-1" })
    await supervisor.handle({ type: "permission.asked", sessionID: "child-1", requestID: "permission-2" })
    await supervisor.handle({ type: "session.execution.started", sessionID: "child-1" })
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "waiting",
      executionStartedAt: 10,
    })
    now = 11
    await supervisor.handle({ type: "session.execution.started", sessionID: "child-1" })
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "waiting",
      executionStartedAt: 10,
    })
    await supervisor.handle({ type: "permission.replied", sessionID: "child-1", requestID: "permission-1" })
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({ state: "waiting" })
    await supervisor.handle({ type: "permission.replied", sessionID: "child-1", requestID: "permission-2" })
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({ state: "running" })
    await supervisor.handle({ type: "permission.asked", sessionID: "child-1", requestID: "permission-2" })
    await supervisor.handle({ type: "permission.replied", sessionID: "child-1", requestID: "permission-2" })
    expect((await store.snapshot({ parentID: "parent-a" })).operations[0].permissionWaits).toHaveLength(1)
    now = 12
    await supervisor.handle({ type: "session.execution.started", sessionID: "child-1" })
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "running",
      executionStartedAt: 10,
    })
    await supervisor.handle({ type: "session.execution.succeeded", sessionID: "child-1" })
    await supervisor.handle({ type: "session.execution.failed", sessionID: "child-1", reason: "stale" })
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({ state: "completed" })
    expect(await store.operation(batch.batch.operations[1].id)).toMatchObject({ state: "starting", childID: "child-2" })
    await store.close()
  })

  test("starts a child for an attached slash skill that remains visible at execution", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit({
      ...request("parent-a", ["/bugfix-session inspect the failure"], 1),
      skills: [{ id: "bugfix-session" }],
    })
    await store.acknowledgeReceipt(batch.batch.id)
    const calls: string[] = []
    const supervisor = new Supervisor(store, 1, {
      parentExists: async () => true,
      validate: async (operation) => {
        if (!operation.skills.some((skill) => skill.id === "bugfix-session"))
          throw new Error("attached skill was not admitted")
      },
      createChild: async () => {
        calls.push("create")
        return "child-1"
      },
      prompt: async () => calls.push("prompt"),
      resume: async () => calls.push("resume"),
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    await supervisor.drain()

    expect(calls).toEqual(["create", "prompt", "resume"])
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({ state: "starting", childID: "child-1" })
    await supervisor.close()
    await store.close()
  })

  test("rejects an attached skill that disappears before child creation", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit({
      ...request("parent-a", ["/missing inspect the failure"], 1),
      skills: [{ id: "missing" }],
    })
    await store.acknowledgeReceipt(batch.batch.id)
    let created = false
    const supervisor = new Supervisor(store, 1, {
      parentExists: async () => true,
      validate: async (operation) => {
        if (operation.skills.some((skill) => skill.id === "missing"))
          throw new Error("Admitted skill disappeared: missing")
      },
      createChild: async () => {
        created = true
        return "child-1"
      },
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    await supervisor.drain()

    expect(created).toBe(false)
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "failed",
      reason: "Admitted skill disappeared: missing",
    })
    await supervisor.close()
    await store.close()
  })

  test("serializes concurrent lifecycle events for one operation", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["one"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    let activeReads = 0
    let concurrentReads = 0
    const serializedStore = {
      ...store,
      async operation(operationID: string) {
        activeReads++
        concurrentReads = Math.max(concurrentReads, activeReads)
        await Bun.sleep(10)
        const operation = await store.operation(operationID)
        activeReads--
        return operation
      },
    }
    const supervisor = new Supervisor(serializedStore, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "child-1",
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    await supervisor.drain()
    await Promise.all([
      supervisor.handle({ type: "permission.asked", sessionID: "child-1", requestID: "permission-1" }),
      supervisor.handle({ type: "session.execution.started", sessionID: "child-1" }),
    ])

    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "waiting",
      executionStartedAt: expect.any(Number),
    })
    expect(concurrentReads).toBe(1)
    await store.close()
  })

  test("cancels admitted starting work before it can resume", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["one"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    const calls: string[] = []
    let cancellation: Promise<void> | undefined
    const supervisor = new Supervisor(
      store,
      1,
      {
        parentExists: async () => true,
        validate: async () => {},
        createChild: async () => "child-1",
        prompt: async () => {
          calls.push("prompt")
          cancellation = supervisor.interrupt(batch.batch.operations[0].id)
        },
        resume: async () => calls.push("resume"),
        cancelInbox: async () => calls.push("cancel-inbox"),
        interrupt: async () => calls.push("interrupt"),
        steer: async () => {},
        messages: async () => [],
        synthetic: async () => {},
      },
      () => 10,
    )

    await supervisor.drain()
    await cancellation
    expect(calls).toEqual(["prompt", "cancel-inbox"])
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "interrupted",
      reason: "cancelled before start",
    })
    await supervisor.close()
    expect(calls).toEqual(["prompt", "cancel-inbox"])
    await store.close()
  })

  test("serializes a delayed cancellation request before child resume", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["one"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    const cancellationStarted = Promise.withResolvers<void>()
    const serializedStore = {
      ...store,
      async requestCancellation(operationID: string, cancelledAt: number) {
        cancellationStarted.resolve()
        await Bun.sleep(20)
        return store.requestCancellation(operationID, cancelledAt)
      },
    }
    const calls: string[] = []
    let cancellation: Promise<void> | undefined
    const supervisor = new Supervisor(serializedStore, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "child-1",
      prompt: async () => {
        cancellation = supervisor.interrupt(batch.batch.operations[0].id)
      },
      resume: async () => calls.push("resume"),
      cancelInbox: async () => calls.push("cancel-inbox"),
      interrupt: async () => calls.push("interrupt"),
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    await supervisor.drain()
    await cancellationStarted.promise
    await cancellation

    expect(calls).toEqual(["cancel-inbox"])
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "interrupted",
      reason: "cancelled before start",
    })
    await store.close()
  })

  test("releases a child when cancellation is observed immediately after binding", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["one"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    const cancellingStore = {
      ...store,
      async transition(...input: Parameters<typeof store.transition>) {
        const changed = await store.transition(...input)
        if (input[3]?.childID) await store.requestCancellation(input[0], 2)
        return changed
      },
    }
    const interrupted: string[] = []
    const supervisor = new Supervisor(cancellingStore, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "child-1",
      prompt: async () => {
        throw new Error("must not prompt")
      },
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async (sessionID) => interrupted.push(sessionID),
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    await supervisor.drain()

    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "interrupted",
      reason: "cancelled before start",
    })
    await supervisor.close()
    expect(interrupted).toEqual([])
    await store.close()
  })

  test("conservatively interrupts uncertain prompt admission and cancels its deterministic inbox item", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["uncertain", "next"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    const cancelled: string[] = []
    const interrupted: string[] = []
    let prompts = 0
    const supervisor = new Supervisor(store, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => `child-${prompts + 1}`,
      prompt: async () => {
        prompts++
        if (prompts === 1) throw new Error("acknowledgement lost")
      },
      resume: async () => {},
      cancelInbox: async (input) => {
        cancelled.push(input.inboxID)
        throw new Error("already promoted")
      },
      interrupt: async (sessionID) => interrupted.push(sessionID),
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    await supervisor.drain()

    expect(cancelled).toHaveLength(1)
    expect(interrupted).toEqual(["child-1"])
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "interrupted",
      reason: "prompt admission acknowledgement uncertain",
    })
    expect(await store.operation(batch.batch.operations[1].id)).toMatchObject({ state: "starting" })
    await supervisor.close()
    expect(interrupted).toEqual(["child-1", "child-2"])
    await store.close()
  })

  test("fails definite prompt admission errors without treating them as uncertain commits", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["invalid", "next"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    const interrupted: string[] = []
    let prompts = 0
    const supervisor = new Supervisor(store, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => `child-${prompts + 1}`,
      prompt: async () => {
        prompts++
        if (prompts === 1) throw new DefinitePromptError("Admitted skill disappeared")
      },
      resume: async () => {},
      cancelInbox: async () => {
        throw new Error("must not cancel")
      },
      interrupt: async (sessionID) => interrupted.push(sessionID),
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    await supervisor.drain()

    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "failed",
      reason: "Admitted skill disappeared",
    })
    expect(await store.operation(batch.batch.operations[1].id)).toMatchObject({ state: "starting" })
    await supervisor.close()
    expect(interrupted).toEqual(["child-2"])
    await store.close()
  })

  test("releases a bound child after generic startup failure", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["failure", "next"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    let failed = false
    const failingStore = {
      ...store,
      async transition(...input: Parameters<typeof store.transition>) {
        if (input[3]?.childID === "child-1" && !failed) {
          failed = true
          throw new Error("child binding unavailable")
        }
        return store.transition(...input)
      },
    }
    const interrupted: string[] = []
    let children = 0
    const supervisor = new Supervisor(failingStore, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => `child-${++children}`,
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async (sessionID) => interrupted.push(sessionID),
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    await supervisor.drain()

    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "failed",
      reason: "child binding unavailable",
    })
    expect(await store.operation(batch.batch.operations[1].id)).toMatchObject({ state: "starting" })
    await supervisor.close()
    expect(interrupted).toEqual(["child-2"])
    await store.close()
  })

  test("releases failed starts and applies idempotent queued and active controls", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["fails", "runs", "queued"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    const calls: string[] = []
    const supervisor = new Supervisor(
      store,
      1,
      {
        parentExists: async () => true,
        validate: async (operation) => {
          if (operation.text === "fails") throw new Error("admitted dependency disappeared")
        },
        createChild: async () => "child-running",
        prompt: async () => {},
        resume: async () => {},
        cancelInbox: async () => {},
        interrupt: async () => calls.push("interrupt"),
        steer: async () => calls.push("steer"),
        messages: async () => [],
        synthetic: async () => {},
      },
      () => 10,
    )

    await supervisor.drain()
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "failed",
      reason: "admitted dependency disappeared",
    })
    await supervisor.handle({ type: "session.execution.started", sessionID: "child-running" })
    await supervisor.steer(batch.batch.operations[1].id, "focus")
    await supervisor.interruptBatch(batch.batch.id)
    await supervisor.interruptBatch(batch.batch.id)

    expect(calls).toEqual(["steer", "interrupt"])
    expect(await store.operation(batch.batch.operations[2].id)).toMatchObject({
      state: "interrupted",
      reason: "cancelled before start",
    })
    await supervisor.handle({ type: "session.deleted", sessionID: "child-running" })
    expect(await store.operation(batch.batch.operations[1].id)).toMatchObject({
      state: "interrupted",
      reason: "child session deleted",
    })
    await supervisor.handle({ type: "session.deleted", sessionID: "parent-a" })
    expect(await store.operation(batch.batch.operations[0].id)).toBeUndefined()
    await store.close()
  })

  test("stops active children and purges retained records when their parent is deleted", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["running"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    const interrupted: string[] = []
    const supervisor = new Supervisor(store, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "child-running",
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async (sessionID) => interrupted.push(sessionID),
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    await supervisor.drain()
    await supervisor.handle({ type: "session.execution.started", sessionID: "child-running" })
    await supervisor.handle({ type: "session.deleted", sessionID: "parent-a" })

    expect(interrupted).toEqual(["child-running"])
    expect(await store.operation(batch.batch.operations[0].id)).toBeUndefined()
    expect(await store.pendingTerminals()).toEqual([])
    expect(await store.pendingRecoveries()).toEqual([])
    await store.close()
  })

  test("interrupts a child created after parent deletion starts and releases its ownership", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["starting"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    const childCreating = Promise.withResolvers<void>()
    const releaseChild = Promise.withResolvers<void>()
    const deletionStarted = Promise.withResolvers<void>()
    const serializedStore = {
      ...store,
      async activeByParent(parentID: string) {
        const active = await store.activeByParent(parentID)
        deletionStarted.resolve()
        return active
      },
    }
    const calls: string[] = []
    const supervisor = new Supervisor(serializedStore, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => {
        calls.push("create")
        childCreating.resolve()
        await releaseChild.promise
        return "child-delayed"
      },
      prompt: async () => calls.push("prompt"),
      resume: async () => calls.push("resume"),
      cancelInbox: async () => {},
      interrupt: async () => calls.push("interrupt"),
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    const draining = supervisor.drain()
    await childCreating.promise
    const deleting = supervisor.handle({ type: "session.deleted", sessionID: "parent-a" })
    await deletionStarted.promise
    releaseChild.resolve()
    await Promise.all([draining, deleting])

    expect(calls).toEqual(["create", "prompt", "interrupt"])
    expect(await store.operation(batch.batch.operations[0].id)).toBeUndefined()
    expect(await store.pendingTerminals()).toEqual([])
    await supervisor.close()
    expect(calls).toEqual(["create", "prompt", "interrupt"])
    await store.close()
  })

  test("does not start queued work after parent deletion reads its active inventory", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["queued"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    const inventoryRead = Promise.withResolvers<void>()
    const releaseInventory = Promise.withResolvers<void>()
    const serializedStore = {
      ...store,
      async activeByParent(parentID: string) {
        const active = await store.activeByParent(parentID)
        inventoryRead.resolve()
        await releaseInventory.promise
        return active
      },
    }
    const calls: string[] = []
    const supervisor = new Supervisor(serializedStore, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => {
        calls.push("create")
        return "child-late"
      },
      prompt: async () => calls.push("prompt"),
      resume: async () => calls.push("resume"),
      cancelInbox: async () => {},
      interrupt: async () => calls.push("interrupt"),
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    const deleting = supervisor.handle({ type: "session.deleted", sessionID: "parent-a" })
    await inventoryRead.promise
    await supervisor.drain()
    releaseInventory.resolve()
    await deleting

    expect(calls).toEqual([])
    expect(await store.operation(batch.batch.operations[0].id)).toBeUndefined()
    await supervisor.close()
    expect(calls).toEqual([])
    await store.close()
  })

  test("interrupts a child whose binding fails during parent deletion", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["starting"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    const childCreating = Promise.withResolvers<void>()
    const releaseChild = Promise.withResolvers<void>()
    const operationLookupStarted = Promise.withResolvers<void>()
    const releaseOperationLookup = Promise.withResolvers<void>()
    const serializedStore = {
      ...store,
      async operationByChild(childID: string) {
        operationLookupStarted.resolve()
        await releaseOperationLookup.promise
        return store.operationByChild(childID)
      },
      async transition(...input: Parameters<typeof store.transition>) {
        if (input[3]?.childID === "child-unbound") throw new Error("child binding unavailable")
        return store.transition(...input)
      },
    }
    const calls: string[] = []
    const supervisor = new Supervisor(serializedStore, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => {
        calls.push("create")
        childCreating.resolve()
        await releaseChild.promise
        return "child-unbound"
      },
      prompt: async () => calls.push("prompt"),
      resume: async () => calls.push("resume"),
      cancelInbox: async () => {},
      interrupt: async () => calls.push("interrupt"),
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    const draining = supervisor.drain()
    await childCreating.promise
    const deleting = supervisor.handle({ type: "session.deleted", sessionID: "parent-a" })
    await operationLookupStarted.promise
    releaseChild.resolve()
    await draining
    releaseOperationLookup.resolve()
    await deleting

    expect(calls).toEqual(["create", "interrupt"])
    expect(await store.operation(batch.batch.operations[0].id)).toBeUndefined()
    await supervisor.close()
    expect(calls).toEqual(["create", "interrupt"])
    await store.close()
  })

  test("suppresses a loaded terminal outcome when its parent is deleted during delivery", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["failed"], 1))
    await store.transition(batch.batch.operations[0].id, ["queued"], "failed", {
      terminalAt: 2,
      reason: "setup failed",
    })
    const terminalLoaded = Promise.withResolvers<void>()
    const releaseTerminal = Promise.withResolvers<void>()
    const parentRemoved = Promise.withResolvers<void>()
    const serializedStore = {
      ...store,
      async pendingTerminals() {
        const pending = await store.pendingTerminals()
        terminalLoaded.resolve()
        await releaseTerminal.promise
        return pending
      },
      async removeParent(parentID: string) {
        await store.removeParent(parentID)
        parentRemoved.resolve()
      },
    }
    const delivered: string[] = []
    const supervisor = new Supervisor(serializedStore, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "child-1",
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [],
      synthetic: async (input) => delivered.push(input.id),
    })

    const delivery = supervisor.retryDeliveries()
    await terminalLoaded.promise
    const deleting = supervisor.handle({ type: "session.deleted", sessionID: "parent-a" })
    await parentRemoved.promise
    releaseTerminal.resolve()
    await Promise.all([delivery, deleting])

    expect(delivered).toEqual([])
    expect(await store.pendingTerminals()).toEqual([])
    await supervisor.close()
    await store.close()
  })

  test("purges descendants when a deleted Session is both a delegation child and parent", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const outer = await store.admit(request("outer", ["nested"], 1))
    const inner = await store.admit(request("nested", ["inner"], 2))
    await store.acknowledgeReceipt(outer.batch.id)
    await store.acknowledgeReceipt(inner.batch.id)
    const interrupted: string[] = []
    const supervisor = new Supervisor(store, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async (input) => (input.parentID === "outer" ? "nested" : "inner"),
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async (sessionID) => interrupted.push(sessionID),
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    await supervisor.drain()
    await supervisor.handle({ type: "session.execution.started", sessionID: "nested" })
    await supervisor.handle({ type: "session.execution.started", sessionID: "inner" })
    await supervisor.handle({ type: "session.deleted", sessionID: "nested" })

    expect(interrupted).toEqual(["inner"])
    expect(await store.operation(outer.batch.operations[0].id)).toMatchObject({
      state: "interrupted",
      reason: "child session deleted",
    })
    expect(await store.operation(inner.batch.operations[0].id)).toBeUndefined()
    await store.close()
  })

  test("migrates schema-2 queued operations without losing their admitted envelope", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const current = await open(options)
    const batch = await current.admit(request("parent-a", ["retained"], 1))
    await current.close()
    const database = new Database(options.store)
    database.exec(`
      ALTER TABLE delegation_operation RENAME TO delegation_operation_v3;
      CREATE TABLE delegation_operation (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES delegation_batch(id) ON DELETE CASCADE,
        operation_index INTEGER NOT NULL,
        operation_text TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state = 'queued'),
        UNIQUE(batch_id, operation_index)
      );
      INSERT INTO delegation_operation (id, batch_id, operation_index, operation_text, state)
      SELECT id, batch_id, operation_index, operation_text, state FROM delegation_operation_v3;
      DROP TABLE delegation_operation_v3;
      DROP TABLE delegation_terminal_report;
      DROP TABLE delegation_recovery;
      DROP TABLE delegation_control_receipt;
      DROP TABLE delegation_control;
      UPDATE delegation_meta SET value = '2' WHERE key = 'schema';
      PRAGMA user_version = 2;
    `)
    database.close()

    await initialize(options)
    const migrated = await open(options)
    expect(await migrated.operation(batch.batch.operations[0].id)).toMatchObject({
      parentID: "parent-a",
      text: "retained",
      state: "queued",
      promptAdmitted: false,
      cancellationRequested: false,
    })
    await migrated.close()
  })

  test("commits and delivers one immutable completed report with the final assistant text", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ['inspect <api> & "docs"'], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    const delivered: Array<Record<string, unknown>> = []
    const services: Services = {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "child-1",
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [
        {
          type: "assistant",
          completed: true,
          failed: false,
          content: [
            { type: "text", text: "final " },
            { type: "reasoning", text: "hidden" },
            { type: "text", text: "answer" },
          ],
        },
      ],
      synthetic: async (input) => delivered.push(input),
    }
    const supervisor = new Supervisor(store, 1, services)

    await supervisor.drain()
    await supervisor.handle({ type: "session.execution.succeeded", sessionID: "child-1" })
    await supervisor.handle({ type: "session.execution.failed", sessionID: "child-1", reason: "stale" })
    await supervisor.retryDeliveries()

    expect(delivered).toHaveLength(1)
    expect((await store.snapshot({ parentID: "parent-a" })).operations[0]).toMatchObject({
      state: "completed",
      terminalOutcome: {
        report: expect.stringContaining("final answer"),
        metadata: { kind: "terminal-outcome", state: "completed" },
      },
    })
    expect(delivered[0]).toEqual({
      sessionID: "parent-a",
      id:
        "msg_" +
        createHash("sha256").update(`delegation-terminal-v1\0parent-a\0${batch.batch.operations[0].id}`).digest("hex"),
      text: `<delegation batch="${batch.batch.id}" operation="inspect &lt;api&gt; &amp; &quot;docs&quot;" child="child-1" state="completed">\nfinal answer\n</delegation>`,
      description: 'inspect <api> & "docs"',
      metadata: {
        source: "delegation",
        kind: "terminal-outcome",
        version: 1,
        parentID: "parent-a",
        batchID: batch.batch.id,
        operationID: batch.batch.operations[0].id,
        childID: "child-1",
        operationIndex: 0,
        operationText: 'inspect <api> & "docs"',
        agent: "general",
        model: { providerID: "openai", modelID: "gpt-5" },
        state: "completed",
        reasonCode: "completed",
        time: { admitted: 1, permitClaimed: expect.any(Number), terminal: expect.any(Number) },
      },
      delivery: "steer",
      resume: true,
    })
    await supervisor.retryDeliveries()
    expect(delivered).toHaveLength(1)
    await store.close()
  })

  test("reports an ordinary interruption even when its reason says service restarted", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["one"], 1))

    await store.transition(batch.batch.operations[0].id, ["queued"], "interrupted", {
      terminalAt: 2,
      reason: "service restarted",
    })

    expect(await store.pendingTerminals()).toHaveLength(1)
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({ reasonCode: "user_interrupted" })
    await store.close()
  })

  test("starts receipt-gated work when background delivery acknowledges the receipt", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["queued"], 1))
    const started: string[] = []
    let fail = true
    const supervisor = new Supervisor(store, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async (input) => {
        started.push(input.title)
        return "child-queued"
      },
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {
        if (fail) throw new Error("parent unavailable")
      },
    })

    await supervisor.start()
    expect(started).toEqual([])
    fail = false
    await supervisor.retryDeliveries()

    expect(started).toEqual(["Delegation: queued"])
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({ state: "starting" })
    await supervisor.close()
    await store.close()
  })

  test("reconciles started work without rerunning it and gates queued work on the recovery notice", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const before = await open(options)
    const batch = await before.admit(request("parent-a", ["started", "queued", "terminal"], 1))
    await before.acknowledgeReceipt(batch.batch.id)
    await before.claimQueued(1, 2)
    await before.transition(batch.batch.operations[0].id, ["starting"], "running", {
      childID: "child-started",
      executionStartedAt: 3,
    })
    await before.transition(batch.batch.operations[2].id, ["queued"], "completed", { terminalAt: 3, outcome: "done" })
    await before.acknowledgeTerminal(batch.batch.operations[2].id)
    await before.close()

    const recovered = await open(options)
    const delivered: Array<Record<string, unknown>> = []
    const started: string[] = []
    let fail = true
    const supervisor = new Supervisor(recovered, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async (input) => {
        started.push(input.title)
        return "child-queued"
      },
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [],
      synthetic: async (input) => {
        delivered.push(input)
        if (fail) throw new Error("parent unavailable")
      },
    })

    await supervisor.start()
    expect(await recovered.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "interrupted",
      childID: "child-started",
      reason: "service restarted",
      recoveryEligible: true,
      recoveryPreviousState: "running",
    })
    expect(await recovered.claimQueued(1, 5)).toEqual([])
    fail = false
    await supervisor.retryDeliveries()
    const notice = delivered.at(-1)
    expect(notice).toMatchObject({
      sessionID: "parent-a",
      description: "Delegation recovered",
      delivery: "steer",
      resume: false,
      metadata: {
        source: "delegation",
        kind: "recovery-notice",
        parentID: "parent-a",
        interrupted: [
          {
            batchID: batch.batch.id,
            operationID: batch.batch.operations[0].id,
            childID: "child-started",
            previousState: "running",
            reason: "service restarted",
          },
        ],
        queued: { count: 1, receiptPendingCount: 0 },
      },
    })
    expect(started).toEqual(["Delegation: queued"])
    expect(await recovered.operation(batch.batch.operations[2].id)).toMatchObject({ state: "completed" })
    await supervisor.retryDeliveries()
    expect(delivered).toHaveLength(2)
    await supervisor.close()
    await recovered.close()
  })

  test("retries the same recovery episode after crashing before acknowledgement", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const before = await open(options)
    await before.admit(request("parent-a", ["queued"], 1))
    await before.close()

    const durable = new Map<string, string>()
    const attempts: Array<Parameters<Services["synthetic"]>[0]> = []
    const services: Services = {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "unused",
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [],
      synthetic: async (input) => {
        if (input.metadata.kind !== "recovery-notice") return
        attempts.push(input)
        const payload = JSON.stringify(input)
        const existing = durable.get(input.id)
        if (existing !== undefined && existing !== payload) throw new Error("synthetic identity conflict")
        if (existing === undefined) durable.set(input.id, payload)
        if (attempts.length === 1) throw new Error("crash after durable admission")
      },
    }
    const crashedStore = await open(options)
    const crashed = new Supervisor(crashedStore, 1, services)
    await crashed.start()
    expect(await crashedStore.pendingRecoveries()).toHaveLength(1)
    await crashed.close()
    await crashedStore.close()

    const restartedStore = await open(options)
    const restarted = new Supervisor(restartedStore, 1, services)
    await restarted.start()
    await restarted.retryDeliveries()

    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
    expect(durable).toHaveProperty("size", 1)
    expect(await restartedStore.pendingRecoveries()).toEqual([])
    await restarted.close()
    await restartedStore.close()

    const laterStore = await open(options)
    const later = new Supervisor(laterStore, 1, services)
    await later.start()

    expect(attempts).toHaveLength(3)
    expect(attempts[2]?.id).not.toBe(attempts[0]?.id)
    expect(durable).toHaveProperty("size", 2)
    await later.close()
    await laterStore.close()
  })

  test("delivers receipt, terminal, and recovery lanes independently while preserving lane order", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const before = await open(options)
    const terminalBatch = await before.admit(request("parent-a", ["first", "second"], 1))
    await before.transition(terminalBatch.batch.operations[0].id, ["queued"], "failed", {
      terminalAt: 2,
      reason: "first failed",
    })
    await before.transition(terminalBatch.batch.operations[1].id, ["queued"], "failed", {
      terminalAt: 3,
      reason: "second failed",
    })
    const queuedBatch = await before.admit(request("parent-a", ["queued"], 4))
    await before.close()

    const store = await open(options)
    const delivered: string[] = []
    let receiptsFail = true
    const supervisor = new Supervisor(store, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "child-queued",
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [],
      synthetic: async (input) => {
        const kind = String(input.metadata.kind)
        delivered.push(`${kind}:${input.description}`)
        if (kind === "admission-receipt" && receiptsFail) throw new Error("receipt unavailable")
      },
    })

    await supervisor.start()
    expect(delivered.filter((item) => item.startsWith("terminal-outcome"))).toEqual([
      "terminal-outcome:first",
      "terminal-outcome:second",
    ])
    expect(delivered).toContain("admission-receipt:Delegation admitted")
    expect(delivered).toContain("recovery-notice:Delegation recovered")
    expect(await store.claimQueued(1, 5)).toEqual([])

    receiptsFail = false
    await supervisor.retryDeliveries()
    expect(await store.operation(queuedBatch.batch.operations[0].id)).toMatchObject({
      state: "starting",
      childID: "child-queued",
    })
    await supervisor.close()
    await store.close()
  })

  test("persists synthetic identity conflicts and blocks later delivery in that lane", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite") })
    await initialize(options)
    const store = await open(options)
    await store.admit(request("parent-a", ["first"], 1))
    await store.admit(request("parent-a", ["second"], 2))
    let attempts = 0
    const supervisor = new Supervisor(store, 6, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "unused",
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {
        attempts++
        throw { _tag: "Session.SyntheticConflictError" }
      },
    })

    await supervisor.retryDeliveries()
    await supervisor.retryDeliveries()

    expect(attempts).toBe(1)
    expect((await store.snapshot({ parentID: "parent-a" })).delivery.admission).toEqual({
      pending: 1,
      conflicted: 1,
    })
    await supervisor.close()
    await store.close()
  })

  test("replays pending Control effects before receipts and interrupts active children on close", async () => {
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
    await store.commitControl({
      parentID: "parent-a",
      invocationID: "steer-1",
      canonical: "steer",
      action: { action: "steer", operationID: batch.batch.operations[0].id, text: "focus" },
      committedAt: 4,
    })
    const calls: string[] = []
    const supervisor = new Supervisor(store, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "unused",
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async (sessionID) => calls.push(`interrupt:${sessionID}`),
      steer: async (input) => calls.push(`steer:${input.sessionID}:${input.id}:${input.text}`),
      messages: async () => [],
      synthetic: async (input) => calls.push(`deliver:${String(input.metadata.kind)}`),
    })

    await supervisor.retryDeliveries()
    expect(calls[0]).toMatch(/^steer:child-a:msg_.*:focus$/)
    expect(calls[1]).toBe("deliver:control-receipt")
    expect(await store.pendingControls()).toEqual([])
    await supervisor.close()
    expect(calls.at(-1)).toBe("interrupt:child-a")
    await store.close()
  })

  test("replays a persisted steer without waking after startup reconciliation", async () => {
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
    await store.commitControl({
      parentID: "parent-a",
      invocationID: "steer-before-crash",
      canonical: "steer",
      action: { action: "steer", operationID: batch.batch.operations[0].id, text: "must not wake" },
      committedAt: 4,
    })
    const calls: string[] = []
    const supervisor = new Supervisor(store, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "unused",
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async (input) => calls.push(`steer:${input.resume}`),
      messages: async () => [],
      synthetic: async (input) => calls.push(String(input.metadata.kind)),
    })

    await supervisor.start()

    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({ state: "interrupted" })
    expect(calls).toContain("control-receipt")
    expect(calls).toContain("steer:false")
    await supervisor.close()
    await store.close()
  })

  test("does not let an in-flight child start escape shutdown", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["late child"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    const child = Promise.withResolvers<string>()
    const creating = Promise.withResolvers<void>()
    const calls: string[] = []
    const supervisor = new Supervisor(store, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => {
        creating.resolve()
        return child.promise
      },
      prompt: async () => calls.push("prompt"),
      resume: async () => calls.push("resume"),
      cancelInbox: async () => {},
      interrupt: async (sessionID) => calls.push(`interrupt:${sessionID}`),
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    const draining = supervisor.drain()
    await creating.promise
    const closing = supervisor.close()
    child.resolve("child-late")
    await Promise.all([draining, closing])

    expect(calls).toEqual(["interrupt:child-late"])
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "starting",
      childID: "child-late",
    })
    await store.close()
  })

  test("interrupts active children before joining stalled start work", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 2 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["active", "stalled"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    await store.claimQueued(1, 2)
    await store.transition(batch.batch.operations[0].id, ["starting"], "running", {
      childID: "child-active",
      executionStartedAt: 3,
    })
    const creating = Promise.withResolvers<void>()
    const child = Promise.withResolvers<string>()
    const interrupted = Promise.withResolvers<void>()
    const supervisor = new Supervisor(store, 2, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => {
        creating.resolve()
        return child.promise
      },
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async (sessionID) => {
        if (sessionID === "child-active") interrupted.resolve()
      },
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    const draining = supervisor.drain()
    await creating.promise
    const closing = supervisor.close()
    await interrupted.promise
    child.resolve("child-late")
    await Promise.all([draining, closing])
    await store.close()
  })

  test("retries final-message projection without requiring terminal event redelivery", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["one"], 1))
    await store.acknowledgeReceipt(batch.batch.id)
    let messagesFail = true
    const delivered: string[] = []
    const services: Services = {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "child-1",
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => {
        if (messagesFail) throw new Error("message projection unavailable")
        return [{ type: "assistant", completed: true, failed: false, content: [{ type: "text", text: "final" }] }]
      },
      synthetic: async (input) => delivered.push(input.text),
    }
    const supervisor = new Supervisor(store, 1, services)

    await supervisor.drain()
    await supervisor.handle({ type: "session.execution.succeeded", sessionID: "child-1" })

    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "starting",
      completionObservedAt: expect.any(Number),
    })
    expect(await store.pendingTerminals()).toEqual([])
    await supervisor.interrupt(batch.batch.operations[0].id)
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "starting",
      cancellationRequested: false,
      completionObservedAt: expect.any(Number),
    })
    await store.close()

    messagesFail = false
    const recovered = await open(options)
    const restarted = new Supervisor(recovered, 1, services)
    await restarted.start()
    expect(await recovered.operation(batch.batch.operations[0].id)).toMatchObject({ state: "completed" })
    expect(delivered.at(0)).toContain("\nfinal\n")
    await restarted.close()
    await recovered.close()
  })

  test("cancels retained starting inbox work before one-time startup reconciliation and delivery", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const before = await open(options)
    const batch = await before.admit(request("parent-a", ["starting"], 1))
    await before.acknowledgeReceipt(batch.batch.id)
    await before.claimQueued(1, 2)
    await before.transition(batch.batch.operations[0].id, ["starting"], "starting", {
      childID: "child-starting",
      promptID: "msg_pending",
      promptAdmitted: true,
    })
    await before.close()

    const store = await open(options)
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({ state: "starting" })
    const calls: string[] = []
    const supervisor = new Supervisor(store, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "unused",
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async (input) => {
        calls.push(`cancel:${input.sessionID}:${input.inboxID}`)
        throw new Error("already promoted")
      },
      interrupt: async (sessionID) => calls.push(`interrupt:${sessionID}`),
      steer: async () => {},
      messages: async () => [],
      synthetic: async (input) => calls.push(`deliver:${input.description}`),
    })

    await supervisor.start()
    await supervisor.start()

    expect(calls).toEqual([
      "cancel:child-starting:msg_pending",
      "interrupt:child-starting",
      "deliver:Delegation recovered",
    ])
    expect(await store.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "interrupted",
      recoveryPreviousState: "starting",
    })
    await supervisor.close()
    await store.close()
  })

  test("settles startup while durable delivery acknowledgement is stalled", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const store = await open(options)
    const batch = await store.admit(request("parent-a", ["queued"], 1))
    const delivery = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    const childStarted = Promise.withResolvers<void>()
    const children: string[] = []
    const supervisor = new Supervisor(store, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => {
        children.push("child-1")
        childStarted.resolve()
        return "child-1"
      },
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {
        entered.resolve()
        await delivery.promise
      },
    })

    const startup = supervisor.start()
    await entered.promise
    const settled = await Promise.race([startup.then(() => true), Bun.sleep(50).then(() => false)])

    expect(settled).toBe(true)
    expect(children).toEqual([])
    expect((await store.pendingReceipts()).map((intent) => intent.key)).toEqual([batch.batch.id])

    delivery.resolve()
    await startup
    await childStarted.promise
    expect(children).toEqual(["child-1"])
    expect(await store.pendingReceipts()).toEqual([])
    await supervisor.close()
    await store.close()
  })

  test("purges only definitely missing parents during startup", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const before = await open(options)
    const missing = await before.admit(request("parent-missing", ["gone"], 1))
    const uncertain = await before.admit(request("parent-uncertain", ["retained"], 2))
    await before.close()

    const store = await open(options)
    const supervisor = new Supervisor(store, 1, {
      parentExists: async (parentID) => {
        if (parentID === "parent-missing") return false
        throw new Error("session lookup unavailable")
      },
      validate: async () => {},
      createChild: async () => "unused",
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [],
      synthetic: async () => {},
    })

    await supervisor.start()
    await supervisor.retryDeliveries()

    expect(await store.operation(missing.batch.operations[0].id)).toBeUndefined()
    expect(await store.operation(uncertain.batch.operations[0].id)).toMatchObject({ state: "starting" })
    await supervisor.close()
    await store.close()
  })

  test("reconciles a durable synthetic admission after an unacknowledged crash and isolates parent lanes", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const before = await open(options)
    const first = await before.admit({ ...request("parent-a", ["one"], 1), invocationID: "first" })
    const second = await before.admit({ ...request("parent-a", ["two"], 2), invocationID: "second" })
    const other = await before.admit(request("parent-b", ["other"], 3))
    await before.close()

    const durable = new Map<string, string>()
    const admissions: string[] = []
    const attempts: string[] = []
    const services = {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async (input: { readonly parentID: string }) => `child-${input.parentID}`,
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [],
      synthetic: async (input: { readonly id: string; readonly text: string }) => {
        attempts.push(input.id)
        const existing = durable.get(input.id)
        if (existing !== undefined && existing !== input.text) throw new Error("synthetic identity conflict")
        if (existing === undefined) {
          durable.set(input.id, input.text)
          admissions.push(input.id)
        }
        if (input.id === first.receipt.id && attempts.filter((id) => id === input.id).length === 1)
          throw new Error("crash after durable admission")
      },
    }
    const crashedStore = await open(options)
    const otherReceiptAcknowledged = Promise.withResolvers<void>()
    const crashed = new Supervisor(
      {
        ...crashedStore,
        acknowledgeReceipt: async (batchID) => {
          await crashedStore.acknowledgeReceipt(batchID)
          if (batchID === other.batch.id) otherReceiptAcknowledged.resolve()
        },
      },
      1,
      services,
    )

    await crashed.start()
    await otherReceiptAcknowledged.promise
    expect(durable.has(first.receipt.id)).toBe(true)
    expect(attempts).not.toContain(second.receipt.id)
    expect(attempts).toContain(other.receipt.id)
    expect((await crashedStore.pendingReceipts()).map((intent) => intent.id)).toEqual([
      first.receipt.id,
      second.receipt.id,
    ])
    await crashed.close()
    await crashedStore.close()

    const restartedStore = await open(options)
    const restarted = new Supervisor(restartedStore, 1, services)
    await restarted.start()
    await restarted.retryDeliveries()

    expect([first.receipt.id, second.receipt.id, other.receipt.id].every((id) => durable.has(id))).toBe(true)
    expect(admissions.filter((id) => id === first.receipt.id)).toHaveLength(1)
    expect(attempts.filter((id) => id === first.receipt.id)).toHaveLength(2)
    expect(await restartedStore.pendingReceipts()).toEqual([])
    await restarted.close()
    await restartedStore.close()
  })

  test("migrates schema-3 active bindings into startup recovery", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 1 })
    await initialize(options)
    const current = await open(options)
    const batch = await current.admit(request("parent-a", ["active"], 1))
    await current.acknowledgeReceipt(batch.batch.id)
    await current.claimQueued(1, 2)
    await current.transition(batch.batch.operations[0].id, ["starting"], "running", {
      childID: "child-active",
      promptID: "msg_active",
      promptAdmitted: true,
      executionStartedAt: 3,
    })
    await current.close()
    const database = new Database(options.store)
    database.exec(`
      DROP TABLE delegation_terminal_report;
      DROP TABLE delegation_recovery;
      DROP TABLE delegation_control_receipt;
      DROP TABLE delegation_control;
      ALTER TABLE delegation_operation DROP COLUMN completion_observed_at;
      ALTER TABLE delegation_operation DROP COLUMN retry_of_operation_id;
      ALTER TABLE delegation_operation DROP COLUMN recovery_previous_state;
      ALTER TABLE delegation_operation DROP COLUMN recovery_id;
      UPDATE delegation_meta SET value = '3' WHERE key = 'schema';
      PRAGMA user_version = 3;
    `)
    database.close()

    await initialize(options)
    const migrated = await open(options)
    expect(await migrated.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "running",
      childID: "child-active",
      promptID: "msg_active",
      promptAdmitted: true,
      executionStartedAt: 3,
    })
    const delivered: Array<Record<string, unknown>> = []
    const supervisor = new Supervisor(migrated, 1, {
      parentExists: async () => true,
      validate: async () => {},
      createChild: async () => "unused",
      prompt: async () => {},
      resume: async () => {},
      cancelInbox: async () => {},
      interrupt: async () => {},
      steer: async () => {},
      messages: async () => [],
      synthetic: async (input) => delivered.push(input),
    })
    await supervisor.start()
    await supervisor.retryDeliveries()

    expect(await migrated.operation(batch.batch.operations[0].id)).toMatchObject({
      state: "interrupted",
      childID: "child-active",
      promptID: "msg_active",
      recoveryEligible: true,
      recoveryPreviousState: "running",
    })
    expect(delivered).toEqual([
      expect.objectContaining({
        sessionID: "parent-a",
        description: "Delegation recovered",
        delivery: "steer",
        resume: false,
        metadata: expect.objectContaining({
          kind: "recovery-notice",
          interrupted: [
            expect.objectContaining({
              operationID: batch.batch.operations[0].id,
              childID: "child-active",
              previousState: "running",
            }),
          ],
        }),
      }),
    ])
    expect(await migrated.pendingRecoveries()).toHaveLength(0)
    await supervisor.close()
    await migrated.close()
  })
})

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
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-delegation-supervision-"))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

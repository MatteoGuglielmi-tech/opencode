import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { initializeProfile } from "../src/distribution"
import { createSupervisionSynchronization } from "../src/synchronization"
import { open } from "../src/storage"
import { projectWorkspace } from "../src/supervision"

test("qualifies the complete marked mixed-state supervision scenario without clearing retained history", async () => {
  const marker = process.env.DELEGATION_ACCEPTANCE_MARKER ?? `delegation-acceptance-${randomUUID()}`
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-delegation-acceptance-"))
  const store = await open(await initializeProfile({ profile: directory }))

  try {
    const unrelated = await store.admit(request("ses_unrelated", ["unrelated retained history"], 1))
    await store.acknowledgeReceipt(unrelated.batch.id)
    await store.claimQueued(1, 2)
    await store.transition(unrelated.batch.operations[0].id, ["starting"], "running", {
      executionStartedAt: 3,
    })
    await store.transition(unrelated.batch.operations[0].id, ["running"], "completed", {
      executionEndedAt: 4,
      executionEndSource: "session_event",
      terminalAt: 5,
      reasonCode: "completed",
      outcome: "retained",
    })

    const recovered = await store.admit(request("ses_marked_a", [`${marker} recover one`, `${marker} recover two`], 10))
    await store.acknowledgeReceipt(recovered.batch.id)
    await store.claimQueued(2, 11)
    await Promise.all(
      recovered.batch.operations.map((operation, index) =>
        store.transition(operation.id, ["starting"], "running", {
          childID: `ses_recovered_${index + 1}`,
          executionStartedAt: 12 + index,
        }),
      ),
    )
    await store.startPermissionWait(recovered.batch.operations[0].id, 15)
    await store.reconcileStartup(20)
    await Promise.all(
      (await store.pendingRecoveries()).map((recovery) => store.acknowledgeRecovery(recovery.key, recovery.parentID)),
    )

    const terminal = await store.admit(request("ses_marked_b", [`${marker} terminal`], 30))
    await store.acknowledgeReceipt(terminal.batch.id)
    await store.claimQueued(1, 31)
    await store.transition(terminal.batch.operations[0].id, ["starting"], "running", {
      childID: "ses_terminal",
      executionStartedAt: 32,
    })
    await store.transition(terminal.batch.operations[0].id, ["running"], "completed", {
      executionEndedAt: 33,
      executionEndSource: "session_event",
      terminalAt: 34,
      reasonCode: "completed",
      outcome: "done",
    })

    const active = await store.admit(request("ses_marked_a", [`${marker} active`, `${marker} queued`], 40))
    await store.acknowledgeReceipt(active.batch.id)
    await store.claimQueued(1, 41)
    await store.transition(active.batch.operations[0].id, ["starting"], "running", {
      childID: "ses_active",
      executionStartedAt: 42,
    })

    const sessions = [
      session("ses_unrelated", "Unrelated retained parent", 2),
      session("ses_marked_a", `${marker} parent A`, 42),
      session("ses_marked_b", `${marker} parent B`, 34),
    ]
    const live = await projectWorkspace({
      store,
      health: { status: "healthy" },
      sessions,
      input: { generation: 1 },
      observedAt: 50,
    })
    if (live.type !== "workspace") throw new Error(`expected live acceptance workspace: ${JSON.stringify(live)}`)

    const markedA = live.parents.find((parent) => parent.session.id === "ses_marked_a")
    expect(live.parents.map((parent) => parent.session.id)).toEqual([
      "ses_marked_a",
      "ses_marked_b",
      "ses_unrelated",
    ])
    expect(live.parents.find((parent) => parent.session.id === "ses_unrelated")?.operations[0].text).toBe(
      "unrelated retained history",
    )
    expect(markedA?.batches).toHaveLength(2)
    expect(markedA?.operations.map((operation) => operation.presentationState)).toEqual([
      "running",
      "queued",
      "terminal",
      "terminal",
    ])
    expect(markedA?.operations.filter((operation) => operation.recovery?.eligible)).toHaveLength(2)
    expect(markedA?.operations.find((operation) => operation.id === recovered.batch.operations[0].id)).toMatchObject({
      timeline: {
        executionEndSource: "startup_reconciliation",
        permissionWaits: [{ startedAt: 15, endedAt: 20, closeReason: "service_restart" }],
      },
      recovery: { previousState: "waiting", eligible: true },
    })
    expect(live.parents.find((parent) => parent.session.id === "ses_marked_b")?.operations[0]).toMatchObject({
      presentationState: "terminal",
      outcome: { state: "completed" },
    })

    const secondClient = await store.admit(request("ses_marked_b", [`${marker} second-client arrival`], 55))
    await store.acknowledgeReceipt(secondClient.batch.id)
    const changed = await projectWorkspace({
      store,
      health: { status: "healthy" },
      sessions,
      input: { generation: 2 },
      observedAt: 56,
    })
    if (changed.type !== "workspace") throw new Error("expected changed acceptance workspace")
    expect(changed.parents.find((parent) => parent.session.id === "ses_marked_b")?.operations[0]).toMatchObject({
      id: secondClient.batch.operations[0].id,
      presentationState: "queued",
    })

    const degraded = await projectWorkspace({
      store,
      health: { status: "degraded", reason: "monitor_failed", detail: `${marker} degraded input` },
      sessions,
      input: { generation: 3 },
      observedAt: 60,
    })
    if (degraded.type !== "workspace") throw new Error("expected degraded acceptance workspace")

    const snapshots = [live, changed, new Error(`${marker} stale input`), degraded]
    const synchronized = createSupervisionSynchronization<string>({
      load: async () => {
        const next = snapshots.shift()
        if (next instanceof Error) throw next
        if (!next) throw new Error("acceptance snapshot exhausted")
        return next
      },
      permissions: async (childIDs) => new Map(childIDs.map((childID) => [childID, [`${marker} permission`]])),
      publish() {},
    })

    synchronized.start()
    await synchronized.idle()
    expect(synchronized.current()).toMatchObject({ freshness: "live", combined: { workspace: { observedAt: 50 } } })
    synchronized.request()
    await synchronized.idle()
    expect(synchronized.current()).toMatchObject({
      freshness: "live",
      combined: { workspace: { observedAt: 56, focus: live.focus } },
    })
    expect(
      synchronized
        .current()
        .combined?.workspace.parents.find((parent) => parent.session.id === "ses_marked_b")
        ?.operations.some((operation) => operation.id === secondClient.batch.operations[0].id),
    ).toBe(true)
    synchronized.request()
    await synchronized.idle()
    expect(synchronized.current()).toMatchObject({
      freshness: "stale",
      combined: { workspace: { observedAt: 56 } },
      failure: { code: "invalid_response", detail: `${marker} stale input` },
    })
    expect(synchronized.mutationsEnabled()).toBe(false)
    synchronized.request()
    await synchronized.idle()
    expect(synchronized.current()).toMatchObject({
      freshness: "degraded",
      combined: { workspace: { observedAt: 60, health: { status: "degraded" } } },
    })
    expect(synchronized.mutationsEnabled()).toBe(false)
    synchronized.stop()

    console.log(`acceptance marker: ${marker}`)
  } finally {
    await store.close()
    await rm(directory, { recursive: true, force: true })
  }
})

function request(parentID: string, operations: ReadonlyArray<string>, admittedAt: number) {
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

function session(id: string, title: string, updated: number) {
  return { id, title, archived: false, updated }
}

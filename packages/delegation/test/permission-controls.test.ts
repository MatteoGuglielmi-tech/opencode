import { describe, expect, test } from "bun:test"
import type { PermissionRequest } from "@opencode-ai/client"
import {
  createPermissionControls,
  permissionChoices,
  permissionDecisionsEnabled,
  permissionInspector,
  permissionRequestForSubmission,
} from "../src/permission-controls"
import type { ProjectedOperation } from "../src/supervision"

describe("Delegated permission controls", () => {
  test("preserves server order and offers Always allow only with a save scope", () => {
    const requests = [request("per_one"), request("per_two", ["shell:git status"])]

    expect(requests.flatMap((item) => permissionInspector(item))).toEqual([
      "Permission per_one: shell",
      "  git status",
      "  Choices: Allow once | Reject",
      "Permission per_two: shell",
      "  git status",
      "  Choices: Allow once | Always allow | Reject",
    ])
    expect(permissionChoices(requests[0])).toEqual(["once", "reject"])
    expect(permissionChoices(requests[1])).toEqual(["once", "always", "reject"])
  })

  test("allows overlapping requests to resolve independently with every reply", async () => {
    const calls: unknown[] = []
    let open = ["per_once", "per_always", "per_reject"]
    const controls = createPermissionControls({
      invoke: async (input) => {
        calls.push(input)
        open = open.filter((id) => id !== input.requestID)
      },
      reconcile: async () => {},
      exists: (_sessionID, requestID) => open.includes(requestID),
      notFound: () => false,
      publish() {},
    })

    const results = await Promise.all([
      controls.submit({ sessionID: "ses_child", requestID: "per_once", reply: "once" }),
      controls.submit({ sessionID: "ses_child", requestID: "per_always", reply: "always" }),
      controls.submit({ sessionID: "ses_child", requestID: "per_reject", reply: "reject", message: "Use read" }),
    ])

    expect(results).toEqual([
      { status: "applied", requestID: "per_once" },
      { status: "applied", requestID: "per_always" },
      { status: "applied", requestID: "per_reject" },
    ])
    expect(calls).toEqual([
      { sessionID: "ses_child", requestID: "per_once", reply: "once" },
      { sessionID: "ses_child", requestID: "per_always", reply: "always" },
      { sessionID: "ses_child", requestID: "per_reject", reply: "reject", message: "Use read" },
    ])
  })

  test("tracks pending state by request while other requests stay actionable", async () => {
    let finish = () => {}
    const controls = createPermissionControls({
      invoke: (input) =>
        input.requestID === "per_one"
          ? new Promise<void>((resolve) => {
              finish = resolve
            })
          : Promise.resolve(),
      reconcile: async () => {},
      exists: () => false,
      notFound: () => false,
      publish() {},
    })
    const first = controls.submit({ sessionID: "ses_child", requestID: "per_one", reply: "once" })
    await Promise.resolve()

    expect(controls.pending()).toMatchObject([{ requestID: "per_one", status: "submitting" }])
    expect(controls.isPending("per_one")).toBe(true)
    expect(controls.isPending("per_two")).toBe(false)
    expect(await controls.confirm()).toEqual([])
    expect(controls.isPending("per_one")).toBe(true)
    expect(await controls.submit({ sessionID: "ses_child", requestID: "per_two", reply: "once" })).toEqual({
      status: "applied",
      requestID: "per_two",
    })
    finish()
    await first
  })

  test("refreshes an expiry race and reports that no decision was applied", async () => {
    let reconciled = 0
    const expired = { _tag: "PermissionNotFoundError" }
    const controls = createPermissionControls({
      invoke: async () => {
        throw expired
      },
      reconcile: async () => {
        reconciled++
      },
      exists: () => false,
      notFound: (error) => error === expired,
      publish() {},
    })

    expect(await controls.submit({ sessionID: "ses_child", requestID: "per_old", reply: "once" })).toEqual({
      status: "expired",
      requestID: "per_old",
    })
    expect(reconciled).toBe(1)
    expect(controls.pending()).toEqual([])
  })

  test("reconciles uncertain transport by identity without replay and permits deliberate resubmission", async () => {
    let calls = 0
    let open = true
    const controls = createPermissionControls({
      invoke: async () => {
        calls++
        if (calls === 1) throw new Error("disconnected")
        open = false
      },
      reconcile: async () => {},
      exists: () => open,
      notFound: () => false,
      publish() {},
    })
    const input = { sessionID: "ses_child", requestID: "per_one", reply: "once" as const }

    expect(await controls.submit(input)).toEqual({ status: "uncertain", requestID: "per_one", detail: "disconnected" })
    expect(calls).toBe(1)
    expect(controls.pending()).toEqual([])
    expect(await controls.submit(input)).toEqual({ status: "applied", requestID: "per_one" })
    expect(calls).toBe(2)
  })

  test("retains uncertain reconciliation without replay until an atomic refresh resolves identity", async () => {
    let reconciles = 0
    let open = true
    let calls = 0
    const controls = createPermissionControls({
      invoke: async () => {
        calls++
        throw new Error("disconnected")
      },
      reconcile: async () => {
        reconciles++
        if (reconciles === 1) throw new Error("offline")
      },
      exists: () => open,
      notFound: () => false,
      publish() {},
    })

    expect(
      await controls.submit({ sessionID: "ses_child", requestID: "per_one", reply: "reject", message: "Stop" }),
    ).toMatchObject({ status: "uncertain", requestID: "per_one" })
    expect(controls.pending()).toMatchObject([{ requestID: "per_one", status: "reconciling" }])
    open = false
    expect(await controls.confirm()).toEqual([{ status: "resolved", requestID: "per_one" }])
    expect(calls).toBe(1)
    expect(controls.pending()).toEqual([])
  })

  test("does not start a second reconciliation while the first remains active", async () => {
    let reconciles = 0
    let finish = () => {}
    const controls = createPermissionControls({
      invoke: async () => {},
      reconcile: () =>
        new Promise<void>((resolve) => {
          reconciles++
          finish = resolve
        }),
      exists: () => false,
      notFound: () => false,
      publish() {},
    })

    const submitted = controls.submit({ sessionID: "ses_child", requestID: "per_one", reply: "once" })
    await Promise.resolve()
    await Promise.resolve()
    expect(controls.pending()).toMatchObject([{ requestID: "per_one", status: "reconciling" }])
    expect(await controls.confirm()).toEqual([])
    expect(reconciles).toBe(1)
    finish()
    expect(await submitted).toEqual({ status: "applied", requestID: "per_one" })
  })

  test("disables decisions for cancellation, terminal, stale, degraded, and unavailable operation state", () => {
    expect(permissionDecisionsEnabled(operation(), "live")).toBe(true)
    expect(permissionDecisionsEnabled(operation({ cancellationRequested: true }), "live")).toBe(false)
    expect(permissionDecisionsEnabled(operation(), "live", true)).toBe(false)
    expect(permissionDecisionsEnabled(operation({ presentationState: "terminal" }), "live")).toBe(false)
    expect(permissionDecisionsEnabled(operation(), "stale")).toBe(false)
    expect(permissionDecisionsEnabled(operation(), "degraded")).toBe(false)
    expect(permissionDecisionsEnabled(undefined, "live")).toBe(false)
  })

  test("revalidates the exact request, choice, and cancellation state before submission", () => {
    const selected = request("per_one", ["shell:git status"])
    expect(
      permissionRequestForSubmission({
        operation: operation(),
        freshness: "live",
        cancellationPending: false,
        requests: [selected],
        requestID: selected.id,
        reply: "always",
      }),
    ).toBe(selected)
    expect(
      permissionRequestForSubmission({
        operation: operation(),
        freshness: "live",
        cancellationPending: true,
        requests: [selected],
        requestID: selected.id,
        reply: "always",
      }),
    ).toBeUndefined()
    expect(
      permissionRequestForSubmission({
        operation: operation(),
        freshness: "live",
        cancellationPending: false,
        requests: [request("per_one")],
        requestID: selected.id,
        reply: "always",
      }),
    ).toBeUndefined()
  })
})

function request(id: string, save?: string[]): PermissionRequest {
  return { id, sessionID: "ses_child", action: "shell", resources: ["git status"], save }
}

function operation(extra: Partial<ProjectedOperation> = {}): ProjectedOperation {
  return {
    id: "dop_one",
    batchID: "dlg_batch",
    parentID: "ses_parent",
    index: 0,
    text: "work",
    internalState: "waiting",
    presentationState: "waiting",
    cancellationRequested: false,
    agent: "general",
    model: { providerID: "openai", modelID: "gpt-5" },
    childID: "ses_child",
    timeline: { admittedAt: 0, permissionWaits: [{ sequence: 0, startedAt: 1 }] },
    ...extra,
  }
}

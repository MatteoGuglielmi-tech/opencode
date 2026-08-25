import { describe, expect, test } from "bun:test"
import {
  batchCancellationCounts,
  createSupervisionControls,
  operationControls,
  recoveryControls,
  type SupervisionControlAction,
} from "../src/supervision-controls"
import type { ProjectedOperation } from "../src/supervision"

describe("Delegation supervision controls", () => {
  test("exposes cancellation and Steer only for authoritatively eligible operations", () => {
    expect(operationControls(operation("queued"))).toEqual({ cancel: true, steer: false })
    expect(operationControls(operation("starting"))).toEqual({ cancel: true, steer: false })
    expect(operationControls(operation("running", { childID: "ses_child" }))).toEqual({ cancel: true, steer: true })
    expect(operationControls(operation("waiting", { childID: "ses_child" }))).toEqual({ cancel: true, steer: true })
    expect(operationControls(operation("finalizing", { childID: "ses_child" }))).toEqual({
      cancel: false,
      steer: false,
    })
    expect(operationControls(operation("terminal", { childID: "ses_child" }))).toEqual({
      cancel: false,
      steer: false,
    })
    expect(operationControls(operation("running", { cancellationRequested: true, childID: "ses_child" }))).toEqual({
      cancel: false,
      steer: false,
    })
  })

  test("counts fresh batch cancellation scope and targets only non-terminal members", () => {
    const operations = [
      operation("running", { id: "dop_run" }),
      operation("waiting", { id: "dop_pending", cancellationRequested: true }),
      operation("finalizing", { id: "dop_finalizing" }),
      operation("terminal", { id: "dop_terminal" }),
    ]

    expect(batchCancellationCounts(operations)).toEqual({
      cancellable: 1,
      pending: 1,
      terminal: 1,
      targets: ["dop_run", "dop_pending", "dop_finalizing"],
    })
  })

  test("offers mutually exclusive recovery choices only while authoritative eligibility remains", () => {
    const eligible = operation("terminal", {
      recovery: { episodeID: "rcv_one", reconciledAt: 4, previousState: "running", eligible: true },
    })

    expect(recoveryControls(eligible)).toEqual({ retry: true, dismiss: true })
    expect(recoveryControls(eligible, true)).toEqual({ retry: false, dismiss: false })
    expect(
      recoveryControls({
        ...eligible,
        recovery: { ...eligible.recovery!, eligible: false },
      }),
    ).toEqual({ retry: false, dismiss: false })
    expect(recoveryControls(operation("terminal"))).toEqual({ retry: false, dismiss: false })
  })

  test("submits retry and dismiss as separate stable Control episodes", async () => {
    const calls: Array<{ parentID: string; invocationID: string; arguments: string }> = []
    const identities = ["ctl_retry", "ctl_dismiss"]
    const controls = createSupervisionControls({
      invocationID: () => identities.shift()!,
      invoke: async (input) => calls.push(input),
      reconcile: async () => {},
      publish() {},
    })

    expect(
      await controls.submit({
        action: { type: "retry", parentID: "ses_parent", operationID: "dop_retry" },
        operationIDs: ["dop_retry"],
      }),
    ).toEqual({ status: "committed", invocationID: "ctl_retry" })
    expect(
      await controls.submit({
        action: { type: "dismiss-recovery", parentID: "ses_parent", operationID: "dop_dismiss" },
        operationIDs: ["dop_dismiss"],
      }),
    ).toEqual({ status: "committed", invocationID: "ctl_dismiss" })
    expect(calls).toEqual([
      { parentID: "ses_parent", invocationID: "ctl_retry", arguments: "action=retry operation=dop_retry" },
      { parentID: "ses_parent", invocationID: "ctl_dismiss", arguments: "action=dismiss operation=dop_dismiss" },
    ])
  })

  test("keeps one retry identity through uncertain delivery and blocks Dismiss", async () => {
    const calls: string[] = []
    const controls = createSupervisionControls({
      invocationID: () => "ctl_retry",
      invoke: async (input) => {
        calls.push(input.invocationID)
        throw new Error("transport disconnected")
      },
      reconcile: async () => {},
      publish() {},
    })

    expect(
      await controls.submit({
        action: { type: "retry", parentID: "ses_parent", operationID: "dop_one" },
        operationIDs: ["dop_one"],
      }),
    ).toMatchObject({ status: "uncertain", invocationID: "ctl_retry" })
    expect(
      await controls.submit({
        action: { type: "dismiss-recovery", parentID: "ses_parent", operationID: "dop_one" },
        operationIDs: ["dop_one"],
      }),
    ).toEqual({ status: "blocked", invocationID: "ctl_retry" })
    expect(calls).toEqual(["ctl_retry", "ctl_retry"])
  })

  test("reuses one invocation identity after uncertain transport and marks only submitted targets", async () => {
    const calls: Array<{ parentID: string; invocationID: string; arguments: string }> = []
    const states: unknown[] = []
    let attempts = 0
    const controls = createSupervisionControls({
      invocationID: () => "ctl_stable",
      invoke: async (input) => {
        calls.push(input)
        if (attempts++ === 0) throw new Error("transport disconnected")
      },
      reconcile: async () => {},
      publish: (state) => states.push(state),
    })

    const result = await controls.submit({
      action: { type: "cancel-batch", parentID: "ses_parent", batchID: "dlg_batch" },
      operationIDs: ["dop_one", "dop_two"],
    })

    expect(result).toEqual({ status: "committed", invocationID: "ctl_stable" })
    expect(calls).toEqual([
      { parentID: "ses_parent", invocationID: "ctl_stable", arguments: "action=cancel batch=dlg_batch" },
      { parentID: "ses_parent", invocationID: "ctl_stable", arguments: "action=cancel batch=dlg_batch" },
    ])
    expect(states).toContainEqual([
      {
        invocationID: "ctl_stable",
        action: { type: "cancel-batch", parentID: "ses_parent", batchID: "dlg_batch" },
        operationIDs: ["dop_one", "dop_two"],
        status: "confirming",
      },
    ])
    expect(controls.pending()).toEqual([])
  })

  test("keeps unresolved Steer pending, blocks duplicate submission, and preserves its text", async () => {
    const controls = createSupervisionControls({
      invocationID: () => "ctl_steer",
      invoke: async () => {
        throw new Error("transport disconnected")
      },
      reconcile: async () => {},
      publish() {},
    })
    const action: SupervisionControlAction = {
      type: "steer",
      parentID: "ses_parent",
      operationID: "dop_one",
      text: "Keep this exact draft",
    }

    expect(await controls.submit({ action, operationIDs: ["dop_one"] })).toEqual({
      status: "uncertain",
      invocationID: "ctl_steer",
      detail: "transport disconnected",
    })
    expect(controls.pending()).toEqual([
      {
        invocationID: "ctl_steer",
        action,
        operationIDs: ["dop_one"],
        status: "confirming",
      },
    ])
    expect(await controls.submit({ action, operationIDs: ["dop_one"] })).toEqual({
      status: "blocked",
      invocationID: "ctl_steer",
    })
  })

  test("confirms an uncertain Control on a later reconciliation with the original identity", async () => {
    const calls: string[] = []
    let failures = 2
    const controls = createSupervisionControls({
      invocationID: () => "ctl_later",
      invoke: async (input) => {
        calls.push(input.invocationID)
        if (failures-- > 0) throw new Error("transport disconnected")
      },
      reconcile: async () => {},
      publish() {},
    })

    expect(
      await controls.submit({
        action: { type: "cancel-operation", parentID: "ses_parent", operationID: "dop_one" },
        operationIDs: ["dop_one"],
      }),
    ).toMatchObject({ status: "uncertain", invocationID: "ctl_later" })
    expect(await controls.confirm()).toEqual([{ status: "committed", invocationID: "ctl_later" }])
    expect(calls).toEqual(["ctl_later", "ctl_later", "ctl_later"])
    expect(controls.pending()).toEqual([])
  })

  test("retains a committed Control marker until authoritative reconciliation succeeds", async () => {
    let live = false
    const controls = createSupervisionControls({
      invocationID: () => "ctl_reconcile",
      invoke: async () => {},
      reconcile: async () => {
        if (!live) throw new Error("projection is stale")
      },
      publish() {},
    })

    expect(
      await controls.submit({
        action: { type: "cancel-operation", parentID: "ses_parent", operationID: "dop_one" },
        operationIDs: ["dop_one"],
      }),
    ).toMatchObject({ status: "uncertain", invocationID: "ctl_reconcile" })
    expect(controls.pending()).toMatchObject([{ invocationID: "ctl_reconcile", status: "confirming" }])
    live = true
    expect(await controls.confirm()).toEqual([{ status: "committed", invocationID: "ctl_reconcile" }])
    expect(controls.pending()).toEqual([])
  })

  test("reconciles an eligibility race without replacing the invocation identity", async () => {
    let reconciled = 0
    const calls: string[] = []
    const controls = createSupervisionControls({
      invocationID: () => "ctl_race",
      invoke: async (input) => {
        calls.push(input.invocationID)
        throw { _tag: "CommandEvaluationError", message: "[control_invalid] recovery eligibility was consumed" }
      },
      reconcile: async () => {
        reconciled++
      },
      publish() {},
    })

    expect(
      await controls.submit({
        action: { type: "retry", parentID: "ses_parent", operationID: "dop_one" },
        operationIDs: ["dop_one"],
      }),
    ).toEqual({
      status: "reconciled",
      invocationID: "ctl_race",
      detail: "[control_invalid] recovery eligibility was consumed",
    })
    expect(calls).toEqual(["ctl_race"])
    expect(reconciled).toBe(1)
    expect(controls.pending()).toEqual([])
  })

  test("retains a rejected Control only for reconciliation and never resubmits it", async () => {
    let live = false
    let invocations = 0
    const controls = createSupervisionControls({
      invocationID: () => "ctl_race",
      invoke: async () => {
        invocations++
        throw { _tag: "CommandEvaluationError", message: "[control_invalid] no longer cancellable" }
      },
      reconcile: async () => {
        if (!live) throw new Error("offline")
      },
      publish() {},
    })

    expect(
      await controls.submit({
        action: { type: "cancel-operation", parentID: "ses_parent", operationID: "dop_one" },
        operationIDs: ["dop_one"],
      }),
    ).toMatchObject({ status: "uncertain", invocationID: "ctl_race" })
    expect(controls.pending()).toMatchObject([{ invocationID: "ctl_race", status: "reconciling" }])
    live = true
    expect(await controls.confirm()).toMatchObject([{ status: "reconciled", invocationID: "ctl_race" }])
    expect(invocations).toBe(1)
  })

  test("treats invocation conflict as non-retryable and retains reportable diagnostics", async () => {
    let reconciled = 0
    const controls = createSupervisionControls({
      invocationID: () => "ctl_conflict",
      invoke: async () => {
        throw {
          _tag: "CommandEvaluationError",
          message: "[control_conflict] Delegation Control invocation ID was reused with different input",
        }
      },
      reconcile: async () => {
        reconciled++
      },
      publish() {},
    })

    expect(
      await controls.submit({
        action: { type: "cancel-operation", parentID: "ses_parent", operationID: "dop_one" },
        operationIDs: ["dop_one"],
      }),
    ).toEqual({
      status: "conflict",
      invocationID: "ctl_conflict",
      detail: "[control_conflict] Delegation Control invocation ID was reused with different input",
    })
    expect(reconciled).toBe(0)
    expect(controls.pending()).toEqual([])
  })
})

function operation(
  presentationState: ProjectedOperation["presentationState"],
  extra: Partial<ProjectedOperation> = {},
): ProjectedOperation {
  const internalState =
    presentationState === "terminal" ? "completed" : presentationState === "finalizing" ? "running" : presentationState
  return {
    id: "dop_one",
    batchID: "dlg_batch",
    parentID: "ses_parent",
    index: 0,
    text: "work",
    internalState,
    presentationState,
    cancellationRequested: false,
    agent: "general",
    model: { providerID: "openai", modelID: "gpt-5" },
    timeline: { admittedAt: 0, permissionWaits: [] },
    ...extra,
  }
}

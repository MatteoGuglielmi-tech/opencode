export * as DelegationSupervisionControls from "./supervision-controls.js"

import type { ProjectedOperation } from "./supervision.js"

export type SupervisionControlAction =
  | Readonly<{ type: "cancel-operation"; parentID: string; operationID: string }>
  | Readonly<{ type: "cancel-batch"; parentID: string; batchID: string }>
  | Readonly<{ type: "steer"; parentID: string; operationID: string; text: string }>

export type PendingSupervisionControl = Readonly<{
  invocationID: string
  action: SupervisionControlAction
  operationIDs: ReadonlyArray<string>
  status: "submitting" | "confirming" | "reconciling"
}>

export type SupervisionControlResult =
  | Readonly<{ status: "committed"; invocationID: string }>
  | Readonly<{ status: "blocked"; invocationID: string }>
  | Readonly<{
      status: "uncertain" | "reconciled" | "conflict" | "defect"
      invocationID: string
      detail: string
    }>

export function operationControls(operation: ProjectedOperation, pending = false) {
  const cancellable = ["queued", "starting", "running", "waiting"].includes(operation.presentationState)
  const active = operation.presentationState === "running" || operation.presentationState === "waiting"
  const blocked = pending || operation.cancellationRequested
  return {
    cancel: cancellable && !blocked,
    steer: active && operation.childID !== undefined && !blocked,
  }
}

export function batchCancellationCounts(operations: ReadonlyArray<ProjectedOperation>) {
  return {
    cancellable: operations.filter((operation) => operationControls(operation).cancel).length,
    pending: operations.filter(
      (operation) => operation.presentationState !== "terminal" && operation.cancellationRequested,
    ).length,
    terminal: operations.filter((operation) => operation.presentationState === "terminal").length,
    targets: operations
      .filter((operation) => operation.presentationState !== "terminal")
      .map((operation) => operation.id),
  }
}

export function createSupervisionControls(input: {
  readonly invoke: (input: {
    readonly parentID: string
    readonly invocationID: string
    readonly arguments: string
  }) => Promise<unknown>
  readonly reconcile: () => Promise<unknown>
  readonly publish: (pending: ReadonlyArray<PendingSupervisionControl>) => void
  readonly invocationID: () => string
}) {
  const pending = new Map<string, PendingSupervisionControl>()
  const attempting = new Set<string>()

  const update = (control: PendingSupervisionControl) => {
    pending.set(control.invocationID, control)
    input.publish([...pending.values()])
  }

  const clear = (control: PendingSupervisionControl) => {
    pending.delete(control.invocationID)
    input.publish([...pending.values()])
  }

  const invoke = (control: PendingSupervisionControl) =>
    input.invoke({
      parentID: control.action.parentID,
      invocationID: control.invocationID,
      arguments: argumentsFor(control.action),
    })

  const reconcile = () => input.reconcile().then(
    () => true,
    () => false,
  )

  const settle = async (control: PendingSupervisionControl, retry: boolean): Promise<SupervisionControlResult> => {
    const outcome = await invoke(control).then(
      () => ({ type: "committed" as const }),
      (cause) => {
        const detail = errorDetail(cause)
        return { type: classify(detail), detail }
      },
    )
    if (outcome.type === "conflict" || outcome.type === "defect") {
      clear(control)
      return { status: outcome.type, invocationID: control.invocationID, detail: outcome.detail }
    }
    if (outcome.type === "race") {
      if (await reconcile()) {
        clear(control)
        return { status: "reconciled", invocationID: control.invocationID, detail: outcome.detail }
      }
      update({ ...control, status: "reconciling" })
      return { status: "uncertain", invocationID: control.invocationID, detail: outcome.detail }
    }

    const confirming = { ...control, status: "confirming" as const }
    update(confirming)
    const reconciled = await reconcile()
    if (outcome.type === "committed" && reconciled) {
      clear(confirming)
      return { status: "committed", invocationID: confirming.invocationID }
    }
    if (!reconciled || !retry)
      return {
        status: "uncertain",
        invocationID: confirming.invocationID,
        detail: outcome.type === "uncertain" ? outcome.detail : "Awaiting authoritative reconciliation",
      }
    return settle(confirming, false)
  }

  return {
    async submit(request: {
      readonly action: SupervisionControlAction
      readonly operationIDs: ReadonlyArray<string>
    }): Promise<SupervisionControlResult> {
      const blocked = [...pending.values()].find((control) =>
        control.operationIDs.some((operationID) => request.operationIDs.includes(operationID)),
      )
      if (blocked) return { status: "blocked", invocationID: blocked.invocationID }
      const control = {
        invocationID: input.invocationID(),
        action: request.action,
        operationIDs: request.operationIDs,
        status: "submitting" as const,
      }
      update(control)
      attempting.add(control.invocationID)
      return settle(control, true).finally(() => attempting.delete(control.invocationID))
    },
    async confirm() {
      return Promise.all(
        [...pending.values()].flatMap((control) => {
          if (control.status === "submitting" || attempting.has(control.invocationID)) return []
          attempting.add(control.invocationID)
          if (control.status === "reconciling")
            return [
              reconcile().then((reconciled): SupervisionControlResult => {
                if (!reconciled)
                  return {
                    status: "uncertain",
                    invocationID: control.invocationID,
                    detail: "Awaiting authoritative reconciliation",
                  }
                clear(control)
                return {
                  status: "reconciled",
                  invocationID: control.invocationID,
                  detail: "Eligibility changed before the Control committed",
                }
              }).finally(() => attempting.delete(control.invocationID)),
            ]
          return [settle(control, false).finally(() => attempting.delete(control.invocationID))]
        }),
      )
    },
    pending: () => [...pending.values()],
    unresolved: () => pending.size > 0,
  }
}

function argumentsFor(action: SupervisionControlAction) {
  if (action.type === "cancel-operation") return `action=cancel operation=${action.operationID}`
  if (action.type === "cancel-batch") return `action=cancel batch=${action.batchID}`
  return `action=steer operation=${action.operationID} ${action.text}`
}

function classify(detail: string): "conflict" | "race" | "defect" | "uncertain" {
  if (detail.includes("[control_conflict]")) return "conflict"
  if (detail.includes("[control_invalid]")) return "race"
  if (detail.includes("[invalid_arguments]")) return "defect"
  return "uncertain"
}

function errorDetail(cause: unknown) {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string")
    return cause.message
  return String(cause)
}

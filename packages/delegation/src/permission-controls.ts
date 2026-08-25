export * as DelegationPermissionControls from "./permission-controls.js"

import type { PermissionReply, PermissionRequest } from "@opencode-ai/client"
import type { ProjectedOperation } from "./supervision.js"

export type PermissionControlInput = {
  readonly sessionID: string
  readonly requestID: string
  readonly reply: PermissionReply
  readonly message?: string
}

export type PendingPermissionControl = PermissionControlInput & {
  readonly status: "submitting" | "reconciling"
  readonly accepted: boolean
  readonly expired: boolean
  readonly detail?: string
}

export type PermissionControlResult = {
  readonly status: "applied" | "expired" | "resolved" | "uncertain" | "blocked"
  readonly requestID: string
  readonly detail?: string
}

export function permissionChoices(request: PermissionRequest): ReadonlyArray<PermissionReply> {
  return request.save?.length ? ["once", "always", "reject"] : ["once", "reject"]
}

export function permissionInspector(request: PermissionRequest, pending = false) {
  return [
    `Permission ${request.id}: ${request.action}${pending ? " (reply pending)" : ""}`,
    ...request.resources.map((resource) => `  ${resource}`),
    `  Choices: ${permissionChoices(request).map(permissionReplyLabel).join(" | ")}`,
  ]
}

export function permissionDecisionsEnabled(
  operation: ProjectedOperation | undefined,
  freshness: "loading" | "live" | "stale" | "degraded",
  cancellationPending = false,
) {
  return Boolean(
    operation &&
      freshness === "live" &&
      operation.presentationState !== "terminal" &&
      operation.childID &&
      !operation.cancellationRequested &&
      !cancellationPending,
  )
}

export function permissionRequestForSubmission(input: {
  readonly operation: ProjectedOperation | undefined
  readonly freshness: "loading" | "live" | "stale" | "degraded"
  readonly cancellationPending: boolean
  readonly requests: ReadonlyArray<PermissionRequest>
  readonly requestID: string
  readonly reply: PermissionReply
}) {
  if (!permissionDecisionsEnabled(input.operation, input.freshness, input.cancellationPending)) return
  const request = input.requests.find((candidate) => candidate.id === input.requestID)
  if (!request || !permissionChoices(request).includes(input.reply)) return
  return request
}

export function createPermissionControls(input: {
  readonly invoke: (input: PermissionControlInput) => Promise<void>
  readonly reconcile: () => Promise<void>
  readonly exists: (sessionID: string, requestID: string) => boolean
  readonly notFound: (error: unknown) => boolean
  readonly publish: (pending: ReadonlyArray<PendingPermissionControl>) => void
}) {
  let pending: ReadonlyArray<PendingPermissionControl> = []
  const reconciling = new Set<string>()

  const publish = (next: ReadonlyArray<PendingPermissionControl>) => {
    pending = next
    input.publish(next)
  }
  const remove = (requestID: string) => publish(pending.filter((item) => item.requestID !== requestID))
  const reconcile = async (control: PendingPermissionControl): Promise<PermissionControlResult> => {
    reconciling.add(control.requestID)
    publish(pending.map((item) => (item.requestID === control.requestID ? { ...item, status: "reconciling" } : item)))
    const result = await input.reconcile().then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    )
    reconciling.delete(control.requestID)
    if (!result.ok) return { status: "uncertain", requestID: control.requestID, detail: errorDetail(result.error) }
    remove(control.requestID)
    if (control.expired) return { status: "expired", requestID: control.requestID }
    if (input.exists(control.sessionID, control.requestID)) {
      return {
        status: "uncertain",
        requestID: control.requestID,
        detail: control.accepted ? "The request is still open after reply reconciliation" : controlDetail(control),
      }
    }
    return { status: control.accepted ? "applied" : "resolved", requestID: control.requestID }
  }

  return {
    async submit(control: PermissionControlInput): Promise<PermissionControlResult> {
      if (pending.some((item) => item.requestID === control.requestID)) {
        return { status: "blocked", requestID: control.requestID }
      }
      const submitted: PendingPermissionControl = {
        ...control,
        status: "submitting",
        accepted: false,
        expired: false,
      }
      publish([...pending, submitted])
      const result = await input.invoke(control).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      if (!result.ok) {
        const current = {
          ...submitted,
          status: "reconciling" as const,
          expired: input.notFound(result.error),
          detail: errorDetail(result.error),
        }
        publish(pending.map((item) => (item.requestID === control.requestID ? current : item)))
        return reconcile(current)
      }
      const accepted = { ...submitted, status: "reconciling" as const, accepted: true }
      publish(pending.map((item) => (item.requestID === control.requestID ? accepted : item)))
      return reconcile(accepted)
    },
    async confirm() {
      return Promise.all(
        pending
          .filter((control) => control.status === "reconciling" && !reconciling.has(control.requestID))
          .map((control) => reconcile(control)),
      )
    },
    pending: () => pending,
    isPending: (requestID: string) => pending.some((item) => item.requestID === requestID),
  }
}

export function permissionReplyLabel(reply: PermissionReply) {
  if (reply === "once") return "Allow once"
  if (reply === "always") return "Always allow"
  return "Reject"
}

function errorDetail(error: unknown) {
  return error instanceof Error ? error.message : "Permission reply outcome is uncertain"
}

function controlDetail(control: PendingPermissionControl) {
  return control.detail ?? "Permission reply outcome is uncertain"
}

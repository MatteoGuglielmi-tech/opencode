export * as DelegationSupervision from "./supervision.js"

import type { OpenCodeClient } from "@opencode-ai/client"
import { Effect, Schema } from "effect"
import type { Health } from "./runtime.js"
import type { OperationRecord, PermissionWait, Store, WorkspaceSnapshot } from "./storage.js"

export const QUERY = "supervision"
export const VERSION = "2"

export const WorkspaceInput = Schema.Struct({
  entrySessionID: Schema.optionalKey(Schema.String),
})
export type WorkspaceInput = typeof WorkspaceInput.Type

const SessionSummary = Schema.Struct({
  id: Schema.String,
  title: Schema.optionalKey(Schema.String),
  parentID: Schema.optionalKey(Schema.String),
  archived: Schema.Boolean,
  updated: Schema.Number,
})
export type SessionSummary = typeof SessionSummary.Type

const Counts = Schema.Struct({
  total: Schema.Number,
  queued: Schema.Number,
  starting: Schema.Number,
  running: Schema.Number,
  finalizing: Schema.Number,
  waiting: Schema.Number,
  completed: Schema.Number,
  failed: Schema.Number,
  interrupted: Schema.Number,
  cancellationRequested: Schema.Number,
  recoveryEligible: Schema.Number,
  actionable: Schema.Number,
  deliveryPending: Schema.Number,
  deliveryConflicted: Schema.Number,
})

const PermissionWait = Schema.Struct({
  sequence: Schema.Number,
  startedAt: Schema.Number,
  endedAt: Schema.optionalKey(Schema.Number),
  closeReason: Schema.optionalKey(Schema.Literals(["replied", "operation_concluded", "service_restart"])),
})

const Timeline = Schema.Struct({
  admittedAt: Schema.Number,
  permitClaimedAt: Schema.optionalKey(Schema.Number),
  executionStartedAt: Schema.optionalKey(Schema.Number),
  executionEndedAt: Schema.optionalKey(Schema.Number),
  executionEndSource: Schema.optionalKey(Schema.Literals(["session_event", "startup_reconciliation"])),
  concludedAt: Schema.optionalKey(Schema.Number),
  permissionWaits: Schema.Array(PermissionWait),
})

const TerminalReason = Schema.Struct({
  code: Schema.Literals([
    "completed",
    "execution_failed",
    "setup_failed",
    "cancelled_before_start",
    "user_interrupted",
    "child_deleted",
    "prompt_admission_uncertain",
    "service_restarted",
  ]),
  detail: Schema.optionalKey(Schema.String),
})

const ProjectedOperation = Schema.Struct({
  id: Schema.String,
  batchID: Schema.String,
  parentID: Schema.String,
  index: Schema.Number,
  text: Schema.String,
  internalState: Schema.Literals(["queued", "starting", "running", "waiting", "completed", "failed", "interrupted"]),
  presentationState: Schema.Literals(["queued", "starting", "running", "waiting", "finalizing", "terminal"]),
  agent: Schema.String,
  model: Schema.Struct({
    providerID: Schema.String,
    modelID: Schema.String,
    variant: Schema.optionalKey(Schema.String),
  }),
  childID: Schema.optionalKey(Schema.String),
  queuePosition: Schema.optionalKey(Schema.Number),
  queueBlocker: Schema.optionalKey(Schema.Literals(["admission_delivery", "capacity"])),
  timeline: Timeline,
  outcome: Schema.optionalKey(
    Schema.Struct({
      state: Schema.Literals(["completed", "failed", "interrupted"]),
      reason: TerminalReason,
    }),
  ),
  recovery: Schema.optionalKey(
    Schema.Struct({
      episodeID: Schema.String,
      reconciledAt: Schema.Number,
      previousState: Schema.Literals(["starting", "running", "waiting"]),
      eligible: Schema.Boolean,
    }),
  ),
  retryOfOperationID: Schema.optionalKey(Schema.String),
})
export type ProjectedOperation = typeof ProjectedOperation.Type

const BatchSummary = Schema.Struct({
  id: Schema.String,
  admittedAt: Schema.Number,
  startedAt: Schema.optionalKey(Schema.Number),
  concludedAt: Schema.optionalKey(Schema.Number),
  outcomes: Schema.Struct({ completed: Schema.Number, failed: Schema.Number, interrupted: Schema.Number }),
})

const ParentSummary = Schema.Struct({
  session: SessionSummary,
  counts: Counts,
  lastActivityAt: Schema.Number,
  newestActionableOperationID: Schema.optionalKey(Schema.String),
  newestOperationID: Schema.optionalKey(Schema.String),
  batches: Schema.Array(BatchSummary),
  operations: Schema.Array(ProjectedOperation),
})
export type ParentSummary = typeof ParentSummary.Type

const Health = Schema.Union([
  Schema.Struct({ status: Schema.Literal("healthy") }),
  Schema.Struct({
    status: Schema.Literal("degraded"),
    reason: Schema.String,
    detail: Schema.String,
  }),
])

const Focus = Schema.Struct({
  parentID: Schema.String,
  operationID: Schema.optionalKey(Schema.String),
})

const Workspace = Schema.Struct({
  type: Schema.Literal("workspace"),
  health: Health,
  observedAt: Schema.Number,
  parents: Schema.Array(ParentSummary),
  focus: Schema.optionalKey(Focus),
})

const Failure = Schema.Struct({
  type: Schema.Literal("failure"),
  code: Schema.Literals(["coordinator_unavailable", "projection_invalid"]),
  detail: Schema.String,
  health: Schema.optionalKey(
    Schema.Struct({ status: Schema.Literal("degraded"), reason: Schema.Literal("projection_invalid") }),
  ),
})

export const WorkspaceResult = Schema.Union([Workspace, Failure])
export type WorkspaceResult = typeof WorkspaceResult.Type

export type InitialFailure = {
  readonly code: "plugin_unavailable" | "unsupported_version" | "invalid_response"
  readonly detail?: string
}

export type Filters = {
  readonly search: string
  readonly actionableOnly: boolean
}

export type View =
  | { readonly type: "loading" }
  | { readonly type: "workspace-empty" }
  | { readonly type: "filtered-empty" }
  | { readonly type: "unsupported-version" }
  | { readonly type: "failure"; readonly code: string; readonly detail?: string }
  | { readonly type: "ready"; readonly parents: ReadonlyArray<ParentSummary> }

export function workspaceQuery(input: {
  readonly store: Store | undefined
  readonly health: () => Health
  readonly sessions: () => Effect.Effect<ReadonlyArray<SessionSummary>, unknown>
}) {
  return {
    version: VERSION,
    input: WorkspaceInput,
    output: WorkspaceResult,
    execute: (request: WorkspaceInput): Effect.Effect<WorkspaceResult> => {
      const store = input.store
      if (!store) {
        const health = input.health()
        return Effect.succeed({
          type: "failure" as const,
          code: "coordinator_unavailable" as const,
          detail: health.status === "degraded" ? health.detail : "Delegation coordinator is unavailable",
        })
      }
      return Effect.gen(function* () {
        const sessions = yield* input.sessions().pipe(Effect.orDie)
        return yield* Effect.promise(() =>
          projectWorkspace({ store, health: input.health(), sessions, input: request }),
        ).pipe(Effect.orDie)
      })
    },
  }
}

export async function projectWorkspace(input: {
  readonly store: Store
  readonly health: Health
  readonly sessions: ReadonlyArray<SessionSummary>
  readonly input: WorkspaceInput
  readonly observedAt?: number
}): Promise<WorkspaceResult> {
  try {
    await input.store.readable()
    const observedAt = input.observedAt ?? Date.now()
    const retained = new Map((await input.store.workspace()).parents.map((parent) => [parent.parentID, parent]))
    const parents = input.sessions
      .flatMap((session) => {
        const snapshot = retained.get(session.id)
        return snapshot ? [summarize(session, snapshot, observedAt)] : []
      })
      .toSorted(compareParents)
    const focus = resolveFocus(parents, retained, input.input.entrySessionID)
    return {
      type: "workspace",
      health: input.health,
      observedAt,
      parents,
      ...(focus ? { focus } : {}),
    }
  } catch (cause) {
    return {
      type: "failure",
      code: cause instanceof InvalidProjectionError ? "projection_invalid" : "coordinator_unavailable",
      detail: cause instanceof Error ? cause.message : String(cause),
      ...(cause instanceof InvalidProjectionError
        ? { health: { status: "degraded" as const, reason: "projection_invalid" as const } }
        : {}),
    }
  }
}

function resolveFocus(
  parents: ReadonlyArray<ParentSummary>,
  retained: ReadonlyMap<string, WorkspaceSnapshot["parents"][number]>,
  entrySessionID: string | undefined,
) {
  if (entrySessionID) {
    const childParent = parents.find((parent) =>
      retained.get(parent.session.id)?.operations.some((operation) => operation.childID === entrySessionID),
    )
    const child = childParent
      ? retained.get(childParent.session.id)?.operations.find((operation) => operation.childID === entrySessionID)
      : undefined
    if (childParent && child) return { parentID: childParent.session.id, operationID: child.id }
    const parent = parents.find((candidate) => candidate.session.id === entrySessionID)
    if (parent) return parentFocus(parent)
  }
  const fallback = parents.find((parent) => parent.counts.actionable > 0) ?? parents[0]
  if (fallback) return parentFocus(fallback)
}

function parentFocus(parent: ParentSummary) {
  const operationID = parent.newestActionableOperationID ?? parent.newestOperationID
  return { parentID: parent.session.id, ...(operationID ? { operationID } : {}) }
}

export async function loadSupervision(
  client: {
    readonly plugin: {
      readonly query: {
        readonly invoke: (
          input: Parameters<OpenCodeClient["plugin"]["query"]["invoke"]>[0],
        ) => Promise<{ readonly data: { readonly output: unknown } }>
      }
    }
  },
  entrySessionID: string | undefined,
): Promise<WorkspaceResult> {
  const response = await client.plugin.query.invoke({
    pluginID: "opencode.delegation",
    query: QUERY,
    version: VERSION,
    input: entrySessionID ? { entrySessionID } : {},
  })
  return Schema.decodeUnknownSync(WorkspaceResult)(response.data.output)
}

export function initialFailure(cause: unknown): InitialFailure {
  const tag = typeof cause === "object" && cause !== null && "_tag" in cause ? cause._tag : undefined
  const detail = cause instanceof Error ? cause.message : undefined
  if (tag === "PluginUnavailableError") return { code: "plugin_unavailable", ...(detail ? { detail } : {}) }
  if (tag === "PluginQueryUnavailableError") return { code: "unsupported_version", ...(detail ? { detail } : {}) }
  return { code: "invalid_response", ...(detail ? { detail } : {}) }
}

export function supervisionView(
  result: WorkspaceResult | undefined,
  failure: InitialFailure | undefined,
  filters: Filters,
): View {
  if (failure?.code === "unsupported_version") return { type: "unsupported-version" }
  if (failure) return { type: "failure", ...failure }
  if (!result) return { type: "loading" }
  if (result.type === "failure") return { type: "failure", code: result.code, detail: result.detail }
  if (result.parents.length === 0) return { type: "workspace-empty" }
  const search = filters.search.trim().toLowerCase()
  const parents = result.parents.filter((parent) => {
    if (filters.actionableOnly && parent.counts.actionable === 0) return false
    if (!search) return true
    return [parent.session.id, parent.session.title ?? "", parent.session.parentID ?? ""].some((value) =>
      value.toLowerCase().includes(search),
    )
  })
  if (parents.length === 0) return { type: "filtered-empty" }
  return { type: "ready", parents }
}

function summarize(
  session: SessionSummary,
  snapshot: WorkspaceSnapshot["parents"][number],
  observedAt: number,
): ParentSummary {
  const queuePositions = new Map(
    snapshot.operations
      .filter((operation) => operation.state === "queued")
      .map((operation, index) => [operation.id, index + 1]),
  )
  const operations = snapshot.operations.map((operation) =>
    projectOperation(operation, snapshot.receiptDelivery[operation.batchID], queuePositions.get(operation.id), observedAt),
  )
  const counts = {
    total: operations.length,
    queued: countProjected(operations, "queued"),
    starting: countProjected(operations, "starting"),
    running: countProjected(operations, "running"),
    finalizing: countProjected(operations, "finalizing"),
    waiting: countProjected(operations, "waiting"),
    completed: snapshot.operations.filter((operation) => operation.state === "completed").length,
    failed: snapshot.operations.filter((operation) => operation.state === "failed").length,
    interrupted: snapshot.operations.filter((operation) => operation.state === "interrupted").length,
    cancellationRequested: snapshot.operations.filter((operation) => operation.cancellationRequested).length,
    recoveryEligible: snapshot.operations.filter((operation) => operation.recoveryEligible).length,
    actionable: snapshot.operations.filter(actionable).length,
    deliveryPending: Object.values(snapshot.delivery).reduce((total, value) => total + value.pending, 0),
    deliveryConflicted: Object.values(snapshot.delivery).reduce((total, value) => total + value.conflicted, 0),
  }
  const activityOrder = snapshot.operations.toSorted(compareOperations)
  const actionableOperations = activityOrder.filter(actionable)
  return {
    session,
    counts,
    lastActivityAt: activity(activityOrder[0]) ?? session.updated,
    ...(actionableOperations[0] ? { newestActionableOperationID: actionableOperations[0].id } : {}),
    ...(activityOrder[0] ? { newestOperationID: activityOrder[0].id } : {}),
    batches: projectBatches(snapshot.operations),
    operations,
  }
}

function actionable(operation: OperationRecord) {
  return !["completed", "failed", "interrupted"].includes(operation.state) || operation.recoveryEligible
}

function countProjected(operations: ReadonlyArray<ProjectedOperation>, state: ProjectedOperation["presentationState"]) {
  return operations.filter((operation) => operation.presentationState === state).length
}

class InvalidProjectionError extends Error {
  constructor(operationID: string, detail: string) {
    super(`Delegation operation ${operationID} has an invalid timeline: ${detail}`)
  }
}

function projectOperation(
  operation: WorkspaceSnapshot["parents"][number]["operations"][number],
  receiptDelivery: "acknowledged" | "pending" | "conflicted" | undefined,
  queuePosition: number | undefined,
  observedAt: number,
): ProjectedOperation {
  validateTimeline(operation, observedAt)
  const terminalState = terminal(operation.state)
  const presentationState = terminalState
    ? "terminal"
    : operation.executionEndedAt !== undefined
      ? "finalizing"
      : operation.state === "waiting"
        ? "waiting"
        : operation.executionStartedAt !== undefined
          ? "running"
          : operation.permitClaimedAt !== undefined
            ? "starting"
            : "queued"
  return {
    id: operation.id,
    batchID: operation.batchID,
    parentID: operation.parentID,
    index: operation.index,
    text: operation.text,
    internalState: operation.state,
    presentationState,
    agent: operation.agent,
    model: operation.model,
    ...(operation.childID === undefined ? {} : { childID: operation.childID }),
    ...(queuePosition === undefined
      ? {}
      : {
          queuePosition,
          queueBlocker: receiptDelivery === "acknowledged" ? ("capacity" as const) : ("admission_delivery" as const),
        }),
    timeline: {
      admittedAt: operation.admittedAt,
      ...(operation.permitClaimedAt === undefined ? {} : { permitClaimedAt: operation.permitClaimedAt }),
      ...(operation.executionStartedAt === undefined ? {} : { executionStartedAt: operation.executionStartedAt }),
      ...(operation.executionEndedAt === undefined ? {} : { executionEndedAt: operation.executionEndedAt }),
      ...(operation.executionEndSource === undefined ? {} : { executionEndSource: operation.executionEndSource }),
      ...(operation.terminalAt === undefined ? {} : { concludedAt: operation.terminalAt }),
      permissionWaits: operation.permissionWaits,
    },
    ...(terminalState
      ? {
          outcome: {
            state: operation.state,
            reason: {
              code: operation.reasonCode!,
              ...(operation.reason === undefined ? {} : { detail: operation.reason }),
            },
          },
        }
      : {}),
    ...(operation.recoveryID === undefined ||
    operation.recoveryReconciledAt === undefined ||
    operation.recoveryPreviousState === undefined
      ? {}
      : {
          recovery: {
            episodeID: operation.recoveryID,
            reconciledAt: operation.recoveryReconciledAt,
            previousState: operation.recoveryPreviousState,
            eligible: operation.recoveryEligible,
          },
        }),
    ...(operation.retryOfOperationID === undefined ? {} : { retryOfOperationID: operation.retryOfOperationID }),
  }
}

function validateTimeline(
  operation: WorkspaceSnapshot["parents"][number]["operations"][number],
  observedAt: number,
) {
  const milestones = [
    operation.admittedAt,
    operation.permitClaimedAt,
    operation.executionStartedAt,
    operation.executionEndedAt,
    operation.terminalAt,
  ].filter((value): value is number => value !== undefined)
  if (milestones.some((value, index) => index > 0 && value < milestones[index - 1]))
    throw new InvalidProjectionError(operation.id, "milestones move backward")
  if ((operation.executionEndedAt === undefined) !== (operation.executionEndSource === undefined))
    throw new InvalidProjectionError(operation.id, "execution end and source must appear together")
  if (operation.executionStartedAt !== undefined && operation.permitClaimedAt === undefined)
    throw new InvalidProjectionError(operation.id, "execution start omits permit claim")
  if (operation.executionEndedAt !== undefined && operation.executionStartedAt === undefined)
    throw new InvalidProjectionError(operation.id, "execution end omits execution start")
  if (operation.state === "queued" && operation.permitClaimedAt !== undefined)
    throw new InvalidProjectionError(operation.id, "queued operation has a permit claim")
  if (!terminal(operation.state) && operation.state !== "queued" && operation.permitClaimedAt === undefined)
    throw new InvalidProjectionError(operation.id, "active operation omits permit claim")
  if (terminal(operation.state) && (operation.terminalAt === undefined || operation.reasonCode === undefined))
    throw new InvalidProjectionError(operation.id, "terminal operation omits conclusion or typed reason")
  if (!terminal(operation.state) && operation.terminalAt !== undefined)
    throw new InvalidProjectionError(operation.id, "active operation has a conclusion")
  if (operation.state === "completed" && operation.reasonCode !== "completed")
    throw new InvalidProjectionError(operation.id, "completed state has a non-completion reason")
  if (operation.state === "failed" && !["setup_failed", "execution_failed"].includes(operation.reasonCode ?? ""))
    throw new InvalidProjectionError(operation.id, "failed state has an incompatible reason")
  if (
    operation.state === "interrupted" &&
    ![
      "cancelled_before_start",
      "user_interrupted",
      "child_deleted",
      "prompt_admission_uncertain",
      "service_restarted",
    ].includes(operation.reasonCode ?? "")
  )
    throw new InvalidProjectionError(operation.id, "interrupted state has an incompatible reason")
  if (operation.reasonCode === "completed" && operation.executionEndedAt === undefined)
    throw new InvalidProjectionError(operation.id, "completed operation omits execution end")
  if (
    ["setup_failed", "cancelled_before_start", "prompt_admission_uncertain"].includes(operation.reasonCode ?? "") &&
    operation.executionStartedAt !== undefined
  )
    throw new InvalidProjectionError(operation.id, `${operation.reasonCode} cannot follow execution start`)
  if (operation.reasonCode === "execution_failed" && operation.executionEndedAt === undefined)
    throw new InvalidProjectionError(operation.id, "execution_failed operation omits execution end")
  if (
    ["user_interrupted", "child_deleted", "service_restarted"].includes(operation.reasonCode ?? "") &&
    operation.executionStartedAt !== undefined &&
    operation.executionEndedAt === undefined
  )
    throw new InvalidProjectionError(operation.id, "executed interruption omits execution end")
  validatePermissionWaits(operation.id, operation.permissionWaits, operation.terminalAt, observedAt)
}

function validatePermissionWaits(
  operationID: string,
  waits: ReadonlyArray<PermissionWait>,
  concludedAt: number | undefined,
  observedAt: number,
) {
  waits.forEach((wait, index) => {
    if (wait.sequence !== index + 1) throw new InvalidProjectionError(operationID, "permission wait sequence has a gap")
    if ((wait.endedAt === undefined) !== (wait.closeReason === undefined))
      throw new InvalidProjectionError(operationID, "permission wait endpoint and close reason must appear together")
    if (wait.endedAt !== undefined && wait.endedAt < wait.startedAt)
      throw new InvalidProjectionError(operationID, "permission wait ends before it starts")
    if (concludedAt !== undefined && (wait.endedAt === undefined || wait.endedAt > concludedAt))
      throw new InvalidProjectionError(operationID, "permission wait extends beyond conclusion")
    if (wait.endedAt === undefined && wait.startedAt > observedAt)
      throw new InvalidProjectionError(operationID, "open permission wait starts after observation")
    const previous = waits[index - 1]
    if (previous && (previous.endedAt === undefined || previous.endedAt > wait.startedAt))
      throw new InvalidProjectionError(operationID, "permission waits overlap")
  })
}

function projectBatches(operations: WorkspaceSnapshot["parents"][number]["operations"]) {
  const batches = new Map<string, typeof operations>()
  operations.forEach((operation) => batches.set(operation.batchID, [...(batches.get(operation.batchID) ?? []), operation]))
  return [...batches.entries()].map(([id, entries]) => {
    const permits = entries.flatMap((operation) =>
      operation.permitClaimedAt === undefined ? [] : [operation.permitClaimedAt],
    )
    const conclusions = entries.flatMap((operation) => (operation.terminalAt === undefined ? [] : [operation.terminalAt]))
    return {
      id,
      admittedAt: entries[0].admittedAt,
      ...(permits.length === 0 ? {} : { startedAt: Math.min(...permits) }),
      ...(conclusions.length !== entries.length ? {} : { concludedAt: Math.max(...conclusions) }),
      outcomes: {
        completed: entries.filter((operation) => operation.state === "completed").length,
        failed: entries.filter((operation) => operation.state === "failed").length,
        interrupted: entries.filter((operation) => operation.state === "interrupted").length,
      },
    }
  })
}

function terminal(state: OperationRecord["state"]): state is "completed" | "failed" | "interrupted" {
  return state === "completed" || state === "failed" || state === "interrupted"
}

function activity(operation: OperationRecord | undefined) {
  if (!operation) return undefined
  return (
    operation.terminalAt ??
    operation.completionObservedAt ??
    operation.executionStartedAt ??
    operation.permitClaimedAt ??
    operation.admittedAt
  )
}

function compareOperations(left: OperationRecord, right: OperationRecord) {
  const time = activity(right)! - activity(left)!
  if (time !== 0) return time
  return left.id.localeCompare(right.id)
}

function compareParents(left: ParentSummary, right: ParentSummary) {
  const actionableOrder = Number(right.counts.actionable > 0) - Number(left.counts.actionable > 0)
  if (actionableOrder !== 0) return actionableOrder
  const activityOrder = right.lastActivityAt - left.lastActivityAt
  if (activityOrder !== 0) return activityOrder
  return left.session.id.localeCompare(right.session.id)
}

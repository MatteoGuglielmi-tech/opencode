export * as DelegationSupervision from "./supervision.js"

import type { OpenCodeClient } from "@opencode-ai/client"
import { Effect, Schema } from "effect"
import type { Health } from "./runtime.js"
import type { OperationRecord, Store, WorkspaceSnapshot } from "./storage.js"

export const QUERY = "supervision"
export const VERSION = "1"

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

const ParentSummary = Schema.Struct({
  session: SessionSummary,
  counts: Counts,
  lastActivityAt: Schema.Number,
  newestActionableOperationID: Schema.optionalKey(Schema.String),
  newestOperationID: Schema.optionalKey(Schema.String),
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
  parents: Schema.Array(ParentSummary),
  focus: Schema.optionalKey(Focus),
})

const Failure = Schema.Struct({
  type: Schema.Literal("failure"),
  code: Schema.Literals(["coordinator_unavailable", "projection_invalid"]),
  detail: Schema.String,
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
    execute: (request: WorkspaceInput) => {
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
}): Promise<WorkspaceResult> {
  try {
    await input.store.readable()
    const retained = new Map((await input.store.workspace()).parents.map((parent) => [parent.parentID, parent]))
    const parents = input.sessions
      .flatMap((session) => {
        const snapshot = retained.get(session.id)
        return snapshot ? [summarize(session, snapshot)] : []
      })
      .toSorted(compareParents)
    const focus = resolveFocus(parents, retained, input.input.entrySessionID)
    return {
      type: "workspace",
      health: input.health,
      parents,
      ...(focus ? { focus } : {}),
    }
  } catch (cause) {
    return {
      type: "failure",
      code: "coordinator_unavailable",
      detail: cause instanceof Error ? cause.message : String(cause),
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

function summarize(session: SessionSummary, snapshot: WorkspaceSnapshot["parents"][number]): ParentSummary {
  const counts = {
    total: snapshot.operations.length,
    queued: count(snapshot.operations, "queued"),
    starting: count(snapshot.operations, "starting"),
    running: count(snapshot.operations, "running"),
    waiting: count(snapshot.operations, "waiting"),
    completed: count(snapshot.operations, "completed"),
    failed: count(snapshot.operations, "failed"),
    interrupted: count(snapshot.operations, "interrupted"),
    cancellationRequested: snapshot.operations.filter((operation) => operation.cancellationRequested).length,
    recoveryEligible: snapshot.operations.filter((operation) => operation.recoveryEligible).length,
    actionable: snapshot.operations.filter(actionable).length,
    deliveryPending: Object.values(snapshot.delivery).reduce((total, value) => total + value.pending, 0),
    deliveryConflicted: Object.values(snapshot.delivery).reduce((total, value) => total + value.conflicted, 0),
  }
  const operations = snapshot.operations.toSorted(compareOperations)
  const actionableOperations = operations.filter(actionable)
  return {
    session,
    counts,
    lastActivityAt: activity(operations[0]) ?? session.updated,
    ...(actionableOperations[0] ? { newestActionableOperationID: actionableOperations[0].id } : {}),
    ...(operations[0] ? { newestOperationID: operations[0].id } : {}),
  }
}

function actionable(operation: OperationRecord) {
  return !["completed", "failed", "interrupted"].includes(operation.state) || operation.recoveryEligible
}

function count(operations: ReadonlyArray<OperationRecord>, state: OperationRecord["state"]) {
  return operations.filter((operation) => operation.state === state).length
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

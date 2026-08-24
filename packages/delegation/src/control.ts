export * as DelegationControl from "./control.js"

import { createHash, randomUUID } from "node:crypto"
import { Effect } from "effect"
import type { Health } from "./runtime.js"
import { isSyntheticConflict, type ControlRecord, type OperationState, type Store } from "./storage.js"

const fields = new Set(["action", "batch", "operation", "state", "cursor", "limit"])

export class ControlError extends Error {
  readonly code = "invalid_arguments"
}

export class ControlReceiptPendingError extends Error {
  readonly code = "control_receipt_pending"

  constructor(
    readonly invocationID: string,
    options?: ErrorOptions,
  ) {
    super(`Delegation Control ${invocationID} committed, but its receipt is pending delivery`, options)
  }
}

export class CoordinatorUnavailableError extends Error {
  readonly code = "coordinator_unavailable"

  constructor(readonly health: Exclude<Health, { status: "healthy" }>) {
    super(`Delegation coordinator is unavailable: ${health.reason}: ${health.detail}`)
  }
}

export type Parsed =
  | Readonly<{
      action: "status"
      batchID?: string
      operationID?: string
      state?: OperationState
      cursor?: string
      limit: number
    }>
  | Readonly<{ action: "cancel"; batchID?: string; operationID?: string }>
  | Readonly<{ action: "steer"; operationID: string; text: string }>
  | Readonly<{ action: "retry" | "dismiss"; operationID: string }>

interface CommandInput {
  readonly sessionID: string
  readonly id?: string
  readonly arguments?: string
}

interface Services<Result> {
  readonly health: () => Health
  readonly cancel: (operationIDs: ReadonlyArray<string>) => Promise<unknown>
  readonly steer: (effect: NonNullable<ControlRecord["effect"]> & { kind: "steer" }) => Promise<unknown>
  readonly synthetic: (input: {
    readonly sessionID: string
    readonly id: string
    readonly text: string
    readonly description: string
    readonly metadata: Record<string, unknown>
    readonly delivery: "steer"
    readonly resume: false
  }) => Effect.Effect<Result, unknown>
}

export function execute<Result>(
  input: CommandInput,
  services: Services<Result>,
  store: Store,
  now: () => number = Date.now,
) {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({ try: () => parse(input.arguments ?? ""), catch: error })
    if (parsed.action === "status") {
      const health = services.health()
      if (health.status === "degraded")
        yield* Effect.tryPromise({
          try: () => store.readable(),
          catch: () => new CoordinatorUnavailableError(health),
        })
      const snapshot = yield* Effect.tryPromise({
        try: () =>
          store.snapshot({
            parentID: input.sessionID,
            ...(parsed.batchID === undefined ? {} : { batchID: parsed.batchID }),
            ...(parsed.operationID === undefined ? {} : { operationID: parsed.operationID }),
            ...(parsed.state === undefined ? {} : { state: parsed.state }),
            ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }),
            limit: parsed.limit,
          }),
        catch: error,
      })
      return yield* services.synthetic({
        sessionID: input.sessionID,
        id: deterministicID(`delegation-status-v1\0${input.sessionID}\0${input.id ?? randomUUID()}`),
        text: renderSnapshot(snapshot.operations.length, snapshot.nextCursor),
        description: "Delegation status",
        metadata: {
          source: "delegation",
          kind: "delegation-snapshot",
          version: 1,
          health,
          snapshot,
        },
        delivery: "steer",
        resume: false,
      })
    }

    const health = services.health()
    if (health.status === "degraded") return yield* Effect.fail(new CoordinatorUnavailableError(health))

    const invocationID = input.id ?? `ctl_${randomUUID().replaceAll("-", "")}`
    const control = yield* Effect.tryPromise({
      try: () =>
        store.commitControl({
          parentID: input.sessionID,
          invocationID,
          canonical: JSON.stringify(parsed),
          action: parsed,
          committedAt: now(),
        }),
      catch: error,
    })
    const effect = control.effect
    if (effect?.kind === "cancel")
      yield* Effect.tryPromise({ try: () => services.cancel(effect.operationIDs), catch: error })
    if (effect?.kind === "steer") yield* Effect.tryPromise({ try: () => services.steer(effect), catch: error })
    const ready = yield* Effect.tryPromise({
      try: () => store.controlReady(invocationID, input.sessionID),
      catch: error,
    })
    if (!ready) return yield* Effect.fail(new ControlReceiptPendingError(invocationID))
    const receipt = yield* services
      .synthetic({
        sessionID: input.sessionID,
        id: control.receipt.id,
        text: control.receipt.text,
        description: control.receipt.description,
        metadata: control.receipt.metadata,
        delivery: "steer",
        resume: false,
      })
      .pipe(
        Effect.tapError((cause) =>
          isSyntheticConflict(cause)
            ? Effect.promise(() => store.markDeliveryConflict("control", invocationID, input.sessionID))
            : Effect.void,
        ),
        Effect.mapError((cause) => new ControlReceiptPendingError(invocationID, { cause })),
      )
    yield* Effect.tryPromise({ try: () => store.acknowledgeControl(invocationID, input.sessionID), catch: error }).pipe(
      Effect.mapError((cause) => new ControlReceiptPendingError(invocationID, { cause })),
    )
    return receipt
  })
}

export function parse(input: string): Parsed {
  const values = new Map<string, string>()
  let offset = 0
  let trailing: string | undefined
  while (offset < input.length) {
    while (offset < input.length && /\s/.test(input[offset] ?? "")) offset++
    if (offset >= input.length) break
    if (values.get("action") === "steer" && values.has("operation")) {
      trailing = input.slice(offset).trim()
      break
    }
    const start = offset
    while (offset < input.length && /[a-zA-Z-]/.test(input[offset] ?? "")) offset++
    if (offset >= input.length || input[offset] !== "=") {
      trailing = input.slice(start).trim()
      break
    }
    const key = input.slice(start, offset)
    if (!fields.has(key)) throw new ControlError(`Unknown field: ${key}`)
    if (values.has(key)) throw new ControlError(`Duplicate field: ${key}`)
    const result = readValue(input, offset + 1)
    values.set(key, result.value)
    offset = result.offset
  }

  const action = values.get("action")
  if (action === "status") return status(values, trailing)
  if (action === "cancel") return cancel(values, trailing)
  if (action === "steer") return steer(values, trailing)
  if (action === "retry" || action === "dismiss") return recovery(action, values, trailing)
  throw new ControlError(action === undefined ? "Delegation control requires action" : `Unknown action: ${action}`)
}

function status(values: Map<string, string>, trailing: string | undefined): Parsed {
  rejectFields(values, ["action", "batch", "operation", "state", "cursor", "limit"])
  if (trailing) throw new ControlError("Status does not accept trailing text")
  if (values.has("batch") && values.has("operation"))
    throw new ControlError("Status cannot combine batch and operation filters")
  const state = values.get("state")
  if (state !== undefined && !isState(state)) throw new ControlError(`Unknown operation state: ${state}`)
  const limitValue = values.get("limit")
  const limit = limitValue === undefined ? 50 : Number(limitValue)
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new ControlError("Status limit must be between 1 and 200")
  const cursor = values.get("cursor")
  if (cursor !== undefined && !/^(0|[1-9]\d*):(0|[1-9]\d*)$/.test(cursor))
    throw new ControlError("Status cursor is invalid")
  return {
    action: "status",
    ...(values.get("batch") === undefined ? {} : { batchID: values.get("batch") }),
    ...(values.get("operation") === undefined ? {} : { operationID: values.get("operation") }),
    ...(state === undefined ? {} : { state }),
    ...(cursor === undefined ? {} : { cursor }),
    limit,
  }
}

function cancel(values: Map<string, string>, trailing: string | undefined): Parsed {
  rejectFields(values, ["action", "batch", "operation"])
  if (trailing) throw new ControlError("Cancel does not accept trailing text")
  const batchID = values.get("batch")
  const operationID = values.get("operation")
  if (batchID === undefined && operationID === undefined) throw new ControlError("Cancel requires batch or operation")
  if (batchID !== undefined && operationID !== undefined)
    throw new ControlError("Cancel requires exactly one batch or operation")
  return { action: "cancel", ...(batchID === undefined ? { operationID } : { batchID }) }
}

function steer(values: Map<string, string>, trailing: string | undefined): Parsed {
  rejectFields(values, ["action", "operation"])
  const operationID = values.get("operation")
  if (!operationID) throw new ControlError("Steer requires operation")
  if (!trailing) throw new ControlError("Steer requires trailing text")
  return { action: "steer", operationID, text: trailing }
}

function recovery(action: "retry" | "dismiss", values: Map<string, string>, trailing: string | undefined): Parsed {
  const operationID = values.get("operation")
  if (!operationID) throw new ControlError(`${action} requires operation`)
  rejectFields(values, ["action", "operation"])
  if (trailing) throw new ControlError(`${action} does not accept trailing text`)
  return { action, operationID }
}

function rejectFields(values: Map<string, string>, allowed: ReadonlyArray<string>) {
  const invalid = [...values.keys()].find((key) => !allowed.includes(key))
  if (invalid) throw new ControlError(`Field ${invalid} is not valid for this action`)
}

function isState(value: string): value is OperationState {
  return (
    value === "queued" ||
    value === "starting" ||
    value === "running" ||
    value === "waiting" ||
    value === "completed" ||
    value === "failed" ||
    value === "interrupted"
  )
}

function readValue(input: string, offset: number) {
  const quote = input[offset]
  if (quote !== '"' && quote !== "'") {
    const end = input.slice(offset).search(/\s/)
    const next = end === -1 ? input.length : offset + end
    return { value: input.slice(offset, next), offset: next }
  }
  let value = ""
  for (let index = offset + 1; index < input.length; index++) {
    const character = input[index] ?? ""
    if (character === "\\") {
      if (index + 1 >= input.length) break
      value += input[index + 1]
      index++
      continue
    }
    if (character !== quote) {
      value += character
      continue
    }
    const next = index + 1
    if (next < input.length && !/\s/.test(input[next] ?? ""))
      throw new ControlError("Expected whitespace after quoted field")
    return { value, offset: next }
  }
  throw new ControlError("Unterminated quote")
}

function deterministicID(value: string) {
  return "msg_" + createHash("sha256").update(value).digest("hex")
}

function renderSnapshot(count: number, cursor: string | undefined) {
  return `<delegation-status operations="${count}"${cursor === undefined ? "" : ` next-cursor="${cursor}"`} />`
}

function error(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause))
}

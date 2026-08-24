export * as DelegationAdmission from "./admission.js"

import { Effect } from "effect"
import type { AdmissionIdentity, Store } from "./storage.js"
import { isSyntheticConflict } from "./storage.js"

const fields = new Set(["agent", "model", "effort", "context", "task"])

export class AdmissionError extends Error {
  constructor(
    readonly code: "invalid_arguments" | "invocation_conflict",
    message: string,
  ) {
    super(message)
  }
}

export class ReceiptPendingError extends Error {
  readonly code = "receipt_pending"

  constructor(
    readonly batchID: string,
    options?: ErrorOptions,
  ) {
    super(`Delegation batch ${batchID} was admitted, but its receipt is pending delivery`, options)
  }
}

export interface Parsed {
  readonly agent?: string
  readonly model?: string
  readonly effort?: string
  readonly context?: string
  readonly operations: ReadonlyArray<string>
}

interface ModelRef {
  readonly providerID: string
  readonly id: string
  readonly variant?: string
}

interface AgentInfo {
  readonly id: string
  readonly name: string
  readonly mode: "subagent" | "primary" | "all"
  readonly model?: ModelRef
}

interface Inventory {
  readonly agents: ReadonlyArray<AgentInfo>
  readonly models: ReadonlyArray<{
    readonly providerID: string
    readonly id: string
    readonly variants: ReadonlyArray<string>
  }>
  readonly skills: ReadonlyArray<string>
}

interface Invocation {
  readonly parentAgent: string
  readonly parentModel?: ModelRef
  readonly files: ReadonlyArray<unknown>
  readonly agents: ReadonlyArray<{ readonly name: string }>
  readonly skills: ReadonlyArray<{ readonly id: string }>
}

interface CommandInput {
  readonly sessionID: string
  readonly id?: string
  readonly arguments?: string
  readonly agent?: string
  readonly model?: ModelRef
  readonly files?: ReadonlyArray<unknown>
  readonly agents?: ReadonlyArray<{ readonly name: string }>
  readonly skills?: ReadonlyArray<{ readonly id: string }>
}

interface Services<Result> {
  readonly parent: (sessionID: string) => Effect.Effect<{ readonly agent?: string; readonly model?: ModelRef }, unknown>
  readonly agents: () => Effect.Effect<ReadonlyArray<AgentInfo>, unknown>
  readonly models: () => Effect.Effect<Inventory["models"], unknown>
  readonly defaultModel: () => Effect.Effect<ModelRef | undefined, unknown>
  readonly skills: () => Effect.Effect<ReadonlyArray<{ readonly id: string }>, unknown>
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
    const parent = yield* services.parent(input.sessionID)
    const invocationID = input.id
    const existing =
      invocationID === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () => store.admissionIdentity(input.sessionID, invocationID),
            catch: error,
          })
    const fallback = existing === undefined ? yield* services.defaultModel() : undefined
    const invocation = {
      parentAgent: input.agent ?? parent.agent ?? "general",
      parentModel: input.model ?? parent.model ?? fallback,
      files: input.files ?? [],
      agents: input.agents ?? [],
      skills: input.skills ?? [],
    }
    const resolved = existing
      ? yield* Effect.try({ try: () => resolveRetry(parsed, invocation, existing), catch: error })
      : yield* Effect.gen(function* () {
          const agents = yield* services.agents()
          const models = yield* services.models()
          const skills = yield* services.skills()
          return yield* Effect.try({
            try: () => resolve(parsed, invocation, { agents, models, skills: skills.map((skill) => skill.id) }),
            catch: error,
          })
        })
    const canonical = JSON.stringify({ ...resolved, receipt: { delivery: "steer", resume: false } })
    const admission = yield* Effect.tryPromise({
      try: () =>
        store.admit({
          parentID: input.sessionID,
          ...(input.id === undefined ? {} : { invocationID: input.id }),
          canonical,
          ...resolved,
          admittedAt: now(),
        }),
      catch: error,
    })
    const ready = yield* Effect.tryPromise({ try: () => store.receiptReady(admission.batch.id), catch: error })
    if (!ready) return yield* Effect.fail(new ReceiptPendingError(admission.batch.id))
    const receipt = yield* services
      .synthetic({
        sessionID: input.sessionID,
        id: admission.receipt.id,
        text: admission.receipt.text,
        description: admission.receipt.description,
        metadata: admission.receipt.metadata,
        delivery: admission.receipt.delivery,
        resume: admission.receipt.resume,
      })
      .pipe(
        Effect.tapError((cause) =>
          isSyntheticConflict(cause)
            ? Effect.promise(() => store.markDeliveryConflict("admission", admission.batch.id, input.sessionID))
            : Effect.void,
        ),
        Effect.mapError((cause) => new ReceiptPendingError(admission.batch.id, { cause })),
      )
    yield* Effect.tryPromise({ try: () => store.acknowledgeReceipt(admission.batch.id), catch: error }).pipe(
      Effect.mapError((cause) => new ReceiptPendingError(admission.batch.id, { cause })),
    )
    return receipt
  })
}

function resolveRetry(parsed: Parsed, invocation: Invocation, admitted: AdmissionIdentity) {
  const selector = parsed.agent ?? "general"
  const agent = selector === "parent" ? invocation.parentAgent : selector
  const selected =
    parsed.model === undefined
      ? { providerID: admitted.model.providerID, id: admitted.model.modelID, variant: admitted.model.variant }
      : modelRef(parsed.model, invocation)
  const sameModel = admitted.model.providerID === selected.providerID && admitted.model.modelID === selected.id
  const variant = parsed.effort ?? (sameModel ? admitted.model.variant : selected.variant)
  const context = parsed.context?.trim()
  return {
    agent,
    model: {
      providerID: selected.providerID,
      modelID: selected.id,
      ...(variant === undefined ? {} : { variant }),
    },
    ...(context ? { context } : {}),
    files: invocation.files,
    agents: invocation.agents,
    skills: invocation.skills,
    operations: parsed.operations,
  }
}

export function resolve(parsed: Parsed, invocation: Invocation, inventory: Inventory) {
  const selector = parsed.agent ?? "general"
  const agentID = selector === "parent" ? invocation.parentAgent : selector
  const agent = inventory.agents.find((candidate) => candidate.id === agentID)
  if (!agent) throw new AdmissionError("invalid_arguments", `Agent not found: ${agentID}`)
  if (selector !== "parent" && agent.mode === "primary")
    throw new AdmissionError("invalid_arguments", `Agent is not subagent-compatible: ${agentID}`)

  const selected =
    parsed.model === undefined ? (agent.model ?? invocation.parentModel) : modelRef(parsed.model, invocation)
  if (!selected) throw new AdmissionError("invalid_arguments", "No effective model is available for Delegation")
  const model = inventory.models.find(
    (candidate) => candidate.providerID === selected.providerID && candidate.id === selected.id,
  )
  if (!model) throw new AdmissionError("invalid_arguments", `Model not found: ${selected.providerID}/${selected.id}`)
  const variant = parsed.effort ?? selected.variant
  if (variant !== undefined && !model.variants.includes(variant))
    throw new AdmissionError(
      "invalid_arguments",
      `Model variant not found: ${selected.providerID}/${selected.id}#${variant}`,
    )

  invocation.agents.forEach((reference) => {
    if (!inventory.agents.some((candidate) => candidate.id === reference.name || candidate.name === reference.name))
      throw new AdmissionError("invalid_arguments", `Agent reference not found: ${reference.name}`)
  })
  invocation.skills.forEach((reference) => {
    if (!inventory.skills.includes(reference.id))
      throw new AdmissionError("invalid_arguments", `Skill not found: ${reference.id}`)
  })
  const context = parsed.context?.trim()
  return {
    agent: agent.id,
    model: {
      providerID: model.providerID,
      modelID: model.id,
      ...(variant === undefined ? {} : { variant }),
    },
    ...(context ? { context } : {}),
    files: invocation.files,
    agents: invocation.agents,
    skills: invocation.skills,
    operations: parsed.operations,
  }
}

export function parse(input: string): Parsed {
  const values = new Map<string, Array<string>>()
  const length = input.length
  let offset = 0
  let trailing: string | undefined

  while (offset < length) {
    while (offset < length && /\s/.test(input[offset] ?? "")) offset++
    if (offset >= length) break

    const start = offset
    while (offset < length && /[a-zA-Z-]/.test(input[offset] ?? "")) offset++
    if (offset >= length || input[offset] !== "=") {
      const whitespace = input.slice(start).search(/\s/)
      const token = input.slice(start, whitespace === -1 ? undefined : start + whitespace)
      const separator = token.indexOf("=")
      if (separator !== -1) throw new AdmissionError("invalid_arguments", `Unknown field: ${token.slice(0, separator)}`)
      trailing = input.slice(start).trim()
      break
    }

    const key = input.slice(start, offset)
    if (!fields.has(key)) throw new AdmissionError("invalid_arguments", `Unknown field: ${key}`)
    offset++
    const result = readValue(input, offset)
    offset = result.offset
    const current = values.get(key) ?? []
    if (key !== "task" && current.length > 0) throw new AdmissionError("invalid_arguments", `Duplicate field: ${key}`)
    current.push(result.value)
    values.set(key, current)
  }

  const tasks = values.get("task") ?? []
  if (trailing !== undefined && tasks.length > 0)
    throw new AdmissionError("invalid_arguments", "Trailing text and task fields cannot be combined")
  const operations = trailing === undefined ? tasks : [trailing]
  if (operations.length === 0 || operations.some((value) => value.trim() === ""))
    throw new AdmissionError("invalid_arguments", "Delegation requires at least one operation")

  return {
    ...single(values, "agent"),
    ...single(values, "model"),
    ...single(values, "effort"),
    ...single(values, "context"),
    operations,
  }
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
      throw new AdmissionError("invalid_arguments", "Expected whitespace after quoted field")
    return { value, offset: next }
  }
  throw new AdmissionError("invalid_arguments", "Unterminated quote")
}

function modelRef(value: string, invocation: Invocation): ModelRef {
  const separator = value.indexOf("/")
  if (separator === -1) {
    if (!invocation.parentModel)
      throw new AdmissionError("invalid_arguments", `Short model ID requires an effective parent provider: ${value}`)
    if (!value) throw new AdmissionError("invalid_arguments", "Model ID cannot be empty")
    const variant = invocation.parentModel.id === value ? invocation.parentModel.variant : undefined
    return {
      providerID: invocation.parentModel.providerID,
      id: value,
      ...(variant === undefined ? {} : { variant }),
    }
  }
  const providerID = value.slice(0, separator)
  const id = value.slice(separator + 1)
  if (!providerID || !id || id.includes("/"))
    throw new AdmissionError("invalid_arguments", `Invalid model reference: ${value}`)
  const variant =
    invocation.parentModel?.providerID === providerID && invocation.parentModel.id === id
      ? invocation.parentModel.variant
      : undefined
  return { providerID, id, ...(variant === undefined ? {} : { variant }) }
}

function single(values: Map<string, Array<string>>, key: "agent" | "model" | "effort" | "context") {
  const value = values.get(key)?.[0]
  return value === undefined ? {} : { [key]: value }
}

function error(cause: unknown) {
  return cause instanceof Error ? cause : new Error(String(cause))
}

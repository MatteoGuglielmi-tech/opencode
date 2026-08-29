export * as DelegationSupervisor from "./supervisor.js"

import { createHash } from "node:crypto"
import {
  isSyntheticConflict,
  type ControlRecord,
  type DeliveryIntent,
  type DeliveryKind,
  type OperationRecord,
  type OperationState,
  type Store,
} from "./storage.js"

export interface Services {
  readonly parentExists: (parentID: string) => Promise<boolean>
  readonly validate: (operation: OperationRecord) => Promise<unknown>
  readonly createChild: (input: {
    readonly parentID: string
    readonly title: string
    readonly agent: string
    readonly model: OperationRecord["model"]
  }) => Promise<string>
  readonly prompt: (input: {
    readonly sessionID: string
    readonly id: string
    readonly text: string
    readonly files: OperationRecord["files"]
    readonly agents: OperationRecord["agents"]
    readonly skills: OperationRecord["skills"]
    readonly metadata: Record<string, unknown>
    readonly resume: false
  }) => Promise<unknown>
  readonly resume: (sessionID: string) => Promise<unknown>
  readonly cancelInbox: (input: { readonly sessionID: string; readonly inboxID: string }) => Promise<unknown>
  readonly interrupt: (sessionID: string) => Promise<unknown>
  readonly steer: (input: {
    readonly sessionID: string
    readonly id?: string
    readonly text: string
    readonly resume?: false
  }) => Promise<unknown>
  readonly messages: (sessionID: string) => Promise<
    ReadonlyArray<{
      readonly type: "assistant"
      readonly completed: boolean
      readonly failed: boolean
      readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>
    }>
  >
  readonly synthetic: (input: {
    readonly sessionID: string
    readonly id: string
    readonly text: string
    readonly description: string
    readonly metadata: Record<string, unknown>
    readonly delivery: "steer"
    readonly resume: boolean
  }) => Promise<unknown>
  readonly deliveryError?: (cause: unknown, intent?: DeliveryIntent) => void
}

export type SupervisorEvent =
  | { readonly type: "session.execution.started"; readonly sessionID: string }
  | { readonly type: "session.execution.succeeded"; readonly sessionID: string }
  | { readonly type: "session.execution.failed"; readonly sessionID: string; readonly reason?: string }
  | { readonly type: "session.execution.interrupted"; readonly sessionID: string; readonly reason?: string }
  | { readonly type: "permission.asked"; readonly sessionID: string; readonly requestID: string }
  | { readonly type: "permission.replied"; readonly sessionID: string; readonly requestID: string }
  | { readonly type: "session.deleted"; readonly sessionID: string }

export class DefinitePromptError extends Error {}

export function classifyPromptFailure(cause: unknown) {
  if (
    typeof cause === "object" &&
    cause !== null &&
    "_tag" in cause &&
    (cause._tag === "Session.NotFoundError" ||
      cause._tag === "Session.PromptConflictError" ||
      cause._tag === "Session.AttachmentError" ||
      cause._tag === "Session.SkillNotFoundError")
  )
    return new DefinitePromptError(cause instanceof Error ? cause.message : "Prompt admission failed", { cause })
  return cause
}

export class Supervisor {
  readonly #permissions = new Map<string, Set<string>>()
  readonly #resolvedPermissions = new Map<string, Set<string>>()
  readonly #children = new Set<string>()
  readonly #starts = new Set<Promise<void>>()
  readonly #operations = new Map<string, Promise<unknown>>()
  readonly #deletingParents = new Set<string>()
  #retry?: ReturnType<typeof setInterval>
  #delivery?: Promise<void>
  #deliveryQueued = false
  #startup?: Promise<void>
  #closed = false

  constructor(
    readonly store: Store,
    readonly concurrency: number,
    readonly services: Services,
    readonly now: () => number = Date.now,
  ) {}

  async start() {
    this.#startup ??= this.#reconcileStartup()
    await this.#startup
    if (!this.#retry) {
      this.#retry = setInterval(
        () => void this.retryDeliveries().catch((cause) => this.services.deliveryError?.(cause)),
        1_000,
      )
      this.#retry.unref()
    }
    void this.retryDeliveries().catch((cause) => this.services.deliveryError?.(cause))
    await this.drain()
  }

  async #reconcileStartup() {
    await this.#retryCompletions(false)
    const startup = await this.store.startupState()
    const missing = new Set(
      (
        await Promise.all(
          startup.parents.map(async (parentID) => ({
            parentID,
            exists: await this.services.parentExists(parentID).catch((cause) => {
              this.services.deliveryError?.(cause)
              return true
            }),
          })),
        )
      )
        .filter((parent) => !parent.exists)
        .map((parent) => parent.parentID),
    )
    await Promise.all(
      startup.active
        .flatMap((operation) =>
          missing.has(operation.parentID) && operation.childID !== undefined ? [operation.childID] : [],
        )
        .map((childID) => this.services.interrupt(childID).catch(() => {})),
    )
    await Promise.all([...missing].map((parentID) => this.store.removeParent(parentID)))
    await Promise.all(
      startup.active
        .flatMap((operation) =>
          !missing.has(operation.parentID) &&
          operation.completionObservedAt === undefined &&
          operation.state === "starting" &&
          operation.childID !== undefined &&
          operation.promptID !== undefined
            ? [{ childID: operation.childID, promptID: operation.promptID }]
            : [],
        )
        .map((operation) =>
          this.services
            .cancelInbox({ sessionID: operation.childID, inboxID: operation.promptID })
            .catch(() => this.services.interrupt(operation.childID)),
        ),
    )
    await this.store.reconcileStartup(this.now())
  }

  async retryDeliveries() {
    if (this.#startup) await this.#startup
    if (this.#closed) return
    if (this.#delivery) {
      this.#deliveryQueued = true
      return this.#delivery
    }
    const delivery = (async () => {
      do {
        this.#deliveryQueued = false
        await this.store.check()
        await this.#retryCompletions()
        const controls = await this.store.pendingControlRecords()
        const byControl = new Map(controls.map((control) => [control.receipt.key, control]))
        const acknowledged = await Promise.all([
          this.#deliver(this.store.pendingReceipts(), (intent) => this.store.acknowledgeReceipt(intent.key)),
          this.#deliver(this.store.pendingTerminals(), (intent) => this.store.acknowledgeTerminal(intent.key)),
          this.#deliver(this.store.pendingRecoveries(), (intent) =>
            this.store.acknowledgeRecovery(intent.key, intent.parentID),
          ),
          this.#deliver(
            Promise.resolve(controls.map((control) => control.receipt)),
            (intent) => this.store.acknowledgeControl(intent.key, intent.parentID),
            (intent) => this.applyControl(byControl.get(intent.key)?.effect),
          ),
        ])
        if (acknowledged[0] || acknowledged[2]) await this.drain()
      } while (this.#deliveryQueued && !this.#closed)
    })()
    this.#delivery = delivery
    await delivery.finally(() => {
      if (this.#delivery === delivery) this.#delivery = undefined
    })
  }

  async drain() {
    if (this.#startup) await this.#startup
    await this.store.check()
    while (!this.#closed) {
      const operations = await this.store.claimQueued(this.concurrency, this.now())
      if (operations.length === 0) return
      await Promise.all(
        operations.map((operation) => {
          const start = this.#enqueue(operation.id, () => this.#start(operation)).then((ready) => {
            if (ready === undefined) return Promise.resolve()
            return this.#enqueue(operation.id, () => this.#resume(operation.id, ready))
          })
          this.#starts.add(start)
          start.then(
            () => this.#starts.delete(start),
            () => this.#starts.delete(start),
          )
          return start
        }),
      )
    }
  }

  async handle(event: SupervisorEvent) {
    if (this.#startup) await this.#startup
    if (event.type === "session.deleted") this.#deletingParents.add(event.sessionID)
    const operation = await this.store.operationByChild(event.sessionID)
    if (event.type === "session.deleted") {
      await Promise.all(
        (await this.store.activeByParent(event.sessionID)).map((active) =>
          this.#enqueue(active.id, async () => {
            const current = await this.store.operation(active.id)
            if (!current?.childID) return
            await this.services.interrupt(current.childID).catch(() => {})
            this.#children.delete(current.childID)
          }),
        ),
      )
      await this.store.removeParent(event.sessionID)
      if (this.#delivery) await this.#delivery
      this.#deletingParents.delete(event.sessionID)
      if (!operation) return
    }
    if (!operation) return
    await this.#enqueue(operation.id, () => this.#handleOperation(operation.id, event))
  }

  async #handleOperation(operationID: string, event: SupervisorEvent) {
    const operation = await this.store.operation(operationID)
    if (!operation || terminal(operation.state)) return
    if (operation.completionObservedAt !== undefined) {
      if (!operation.childID || !(await this.#complete(operation.id, operation.childID))) return
      await this.retryDeliveries()
      await this.drain()
      return
    }
    if (event.type === "permission.asked") {
      if (this.#resolvedPermissions.get(operation.id)?.has(event.requestID)) return
      const permissions = this.#permissions.get(operation.id) ?? new Set<string>()
      const startsPermissionWait = permissions.size === 0
      permissions.add(event.requestID)
      this.#permissions.set(operation.id, permissions)
      if (startsPermissionWait) await this.store.startPermissionWait(operation.id, this.now())
      return
    }
    if (event.type === "permission.replied") {
      const resolved = this.#resolvedPermissions.get(operation.id) ?? new Set<string>()
      resolved.add(event.requestID)
      this.#resolvedPermissions.set(operation.id, resolved)
      const permissions = this.#permissions.get(operation.id)
      if (!permissions?.delete(event.requestID)) return
      if (permissions.size > 0) return
      this.#permissions.delete(operation.id)
      await this.store.endPermissionWait(operation.id, this.now(), "replied")
      return
    }
    if (event.type === "session.execution.started") {
      if (operation.executionStartedAt !== undefined) return
      const executionStartedAt = this.now()
      await this.store.transition(operation.id, ["starting", "running"], "running", { executionStartedAt })
      if (operation.state === "waiting")
        await this.store.transition(operation.id, ["waiting"], "waiting", { executionStartedAt })
      return
    }
    const outcome = terminalEvent(event)
    if (!outcome) return
    if (outcome.state === "completed" && operation.childID) {
      const executionEndedAt = this.now()
      await this.store.transition(operation.id, ["starting", "running", "waiting"], operation.state, {
        completionObservedAt: executionEndedAt,
        ...(operation.executionStartedAt === undefined
          ? {}
          : { executionEndedAt, executionEndSource: "session_event" as const }),
      })
      if (!(await this.#complete(operation.id, operation.childID))) return
      await this.retryDeliveries()
      await this.drain()
      return
    }
    this.#permissions.delete(operation.id)
    this.#resolvedPermissions.delete(operation.id)
    this.#children.delete(event.sessionID)
    const terminalAt = this.now()
    await this.store.transition(operation.id, ["starting", "running", "waiting"], outcome.state, {
      terminalAt,
      ...(operation.executionStartedAt === undefined
        ? {}
        : { executionEndedAt: terminalAt, executionEndSource: "session_event" as const }),
      reason: outcome.reason,
      reasonCode: outcome.reasonCode,
    })
    await this.retryDeliveries()
    await this.drain()
  }

  async interrupt(operationID: string) {
    await this.#enqueue(operationID, async () => {
      const request = await this.store.requestCancellation(operationID, this.now())
      if (!request.requested) return
      await this.#applyCancellation(operationID, request.operation)
    })
  }

  async applyControl(effect: ControlRecord["effect"]) {
    if (effect?.kind === "cancel") {
      await Promise.all(
        effect.operationIDs.map((operationID) =>
          this.#enqueue(operationID, () => this.#applyCancellation(operationID)),
        ),
      )
      return
    }
    if (effect?.kind === "steer") {
      await this.#enqueue(effect.operationID, async () => {
        const operation = await this.store.operation(effect.operationID)
        if (
          !operation ||
          operation.completionObservedAt !== undefined ||
          (operation.state !== "running" &&
            operation.state !== "waiting" &&
            !(
              operation.state === "interrupted" &&
              operation.recoveryEligible &&
              operation.reason === "service restarted"
            )) ||
          operation.childID !== effect.childID
        )
          return
        await this.services.steer({ sessionID: effect.childID, id: effect.messageID, text: effect.text, resume: false })
      })
    }
  }

  async #applyCancellation(operationID: string, current?: OperationRecord) {
    const operation = current ?? (await this.store.operation(operationID))
    if (
      !operation ||
      terminal(operation.state) ||
      operation.completionObservedAt !== undefined ||
      operation.state === "queued"
    ) {
      await this.drain()
      return
    }
    if (operation.state === "starting") {
      if (!operation.promptAdmitted || !operation.childID || !operation.promptID) return
      const childID = operation.childID
      await this.services
        .cancelInbox({ sessionID: childID, inboxID: operation.promptID })
        .catch(() => this.services.interrupt(childID))
      const changed = await this.store.transition(operation.id, ["starting"], "interrupted", {
        terminalAt: this.now(),
        reason: "cancelled before start",
        reasonCode: "cancelled_before_start",
      })
      if (changed) this.#children.delete(childID)
      await this.drain()
      return
    }
    if (operation.childID) await this.services.interrupt(operation.childID)
  }

  async interruptBatch(batchID: string) {
    await Promise.all((await this.store.operationsByBatch(batchID)).map((operation) => this.interrupt(operation.id)))
  }

  async steer(operationID: string, text: string) {
    await this.#enqueue(operationID, async () => {
      const operation = await this.store.operation(operationID)
      if (
        !operation ||
        operation.completionObservedAt !== undefined ||
        (operation.state !== "running" && operation.state !== "waiting") ||
        !operation.childID
      )
        throw new Error("Delegation operation is not running")
      await this.services.steer({ sessionID: operation.childID, text })
    })
  }

  async close() {
    this.#closed = true
    if (this.#retry) clearInterval(this.#retry)
    const interrupted = new Set<string>()
    await this.#interruptActiveChildren(interrupted)
    await Promise.allSettled(this.#starts)
    await this.#interruptActiveChildren(interrupted)
    if (this.#delivery) await this.#delivery
  }

  async #interruptActiveChildren(interrupted: Set<string>) {
    const active = await this.store.startupState().catch((cause) => {
      this.services.deliveryError?.(cause)
      return { parents: [], active: [] }
    })
    const children = new Set([
      ...this.#children,
      ...active.active.flatMap((operation) => (operation.childID === undefined ? [] : [operation.childID])),
    ])
    await Promise.all(
      [...children]
        .filter((childID) => !interrupted.has(childID))
        .map(async (childID) => {
          interrupted.add(childID)
          await this.services.interrupt(childID).catch(() => {})
        }),
    )
    this.#children.clear()
  }

  async #deliver(
    pending: Promise<ReadonlyArray<DeliveryIntent>>,
    acknowledge: (intent: DeliveryIntent) => Promise<void>,
    before: (intent: DeliveryIntent) => Promise<unknown> = async () => {},
  ) {
    const groups = new Map<string, DeliveryIntent[]>()
    const acknowledged: string[] = []
    ;(await pending).forEach((intent) => groups.set(intent.parentID, [...(groups.get(intent.parentID) ?? []), intent]))
    await Promise.all(
      [...groups.values()].map((intents) =>
        intents.reduce(
          (previous, intent) =>
            previous.then(async (ready) => {
              if (!ready || this.#closed || intent.conflicted || this.#deletingParents.has(intent.parentID)) return false
              return before(intent)
                .then(() => {
                  if (this.#deletingParents.has(intent.parentID)) return false
                  return this.services
                    .synthetic({
                      sessionID: intent.parentID,
                      id: intent.id,
                      text: intent.text,
                      description: intent.description,
                      metadata: intent.metadata,
                      delivery: intent.delivery,
                      resume: intent.resume,
                    })
                    .then(() => true)
                })
                .then(async (delivered) => {
                  if (!delivered) return false
                  await acknowledge(intent)
                  acknowledged.push(intent.key)
                  return true
                })
                .catch(async (cause) => {
                  if (isSyntheticConflict(cause))
                    await this.store
                      .markDeliveryConflict(deliveryKind(intent), intent.key, intent.parentID)
                      .catch((failure) => this.services.deliveryError?.(failure, intent))
                  this.services.deliveryError?.(cause, intent)
                  return false
                })
            }),
          Promise.resolve(true),
        ),
      ),
    )
    return acknowledged.length > 0
  }

  async #finalResponse(childID: string) {
    const assistant = (await this.services.messages(childID)).find((message) => message.completed && !message.failed)
    const text = assistant?.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
    return text || "Child completed without a final response."
  }

  async #retryCompletions(schedule = true) {
    const completed = await Promise.all(
      (await this.store.pendingCompletions()).flatMap((operation) => {
        if (!operation.childID) return []
        const childID = operation.childID
        return [this.#enqueue(operation.id, () => this.#complete(operation.id, childID))]
      }),
    )
    if (schedule && completed.some(Boolean)) await this.drain()
  }

  async #complete(operationID: string, childID: string) {
    const operation = await this.store.operation(operationID)
    if (!operation || terminal(operation.state) || operation.completionObservedAt === undefined) return false
    const output = await this.#finalResponse(childID).catch((cause) => {
      this.services.deliveryError?.(cause)
      return undefined
    })
    if (output === undefined) return false
    const changed = await this.store.transition(operation.id, ["starting", "running", "waiting"], "completed", {
      terminalAt: this.now(),
      reasonCode: "completed",
      outcome: output,
    })
    if (!changed) return false
    this.#permissions.delete(operation.id)
    this.#resolvedPermissions.delete(operation.id)
    this.#children.delete(childID)
    return true
  }

  #enqueue<T>(key: string, task: () => Promise<T>) {
    const pending = (this.#operations.get(key) ?? Promise.resolve()).catch(() => {}).then(task)
    this.#operations.set(key, pending)
    return pending.finally(() => {
      if (this.#operations.get(key) === pending) this.#operations.delete(key)
    })
  }

  async #start(operation: OperationRecord) {
    if (this.#deletingParents.has(operation.parentID)) return undefined
    let createdChildID: string | undefined
    try {
      await this.services.validate(operation)
      const childID = await this.services.createChild({
        parentID: operation.parentID,
        title: `Delegation: ${operation.text.slice(0, 80)}`,
        agent: operation.agent,
        model: operation.model,
      })
      createdChildID = childID
      this.#children.add(childID)
      await this.store.transition(operation.id, ["starting"], "starting", { childID })
      if (this.#closed) return undefined
      const bound = await this.store.operation(operation.id)
      if (!bound || bound.cancellationRequested) {
        const changed = await this.store.transition(operation.id, ["starting"], "interrupted", {
          terminalAt: this.now(),
          reason: "cancelled before start",
          reasonCode: "cancelled_before_start",
        })
        if (changed) this.#children.delete(childID)
        return undefined
      }
      const promptID = deterministicPromptID(operation.id)
      await this.store.transition(operation.id, ["starting"], "starting", { promptID })
      const acknowledged = await this.services
        .prompt({
          sessionID: childID,
          id: promptID,
          text: renderPrompt(operation),
          files: operation.files,
          agents: operation.agents,
          skills: operation.skills,
          metadata: { source: "delegation", batchID: operation.batchID, operationID: operation.id },
          resume: false,
        })
        .then(
          () => true,
          async (cause) => {
            if (cause instanceof DefinitePromptError) {
              const changed = await this.store.transition(operation.id, ["starting"], "failed", {
                terminalAt: this.now(),
                reason: cause.message,
                reasonCode: "setup_failed",
              })
              if (changed) this.#children.delete(childID)
              return false
            }
            await this.services
              .cancelInbox({ sessionID: childID, inboxID: promptID })
              .catch(() => this.services.interrupt(childID).catch(() => {}))
            const changed = await this.store.transition(operation.id, ["starting"], "interrupted", {
              terminalAt: this.now(),
              reason: "prompt admission acknowledgement uncertain",
              reasonCode: "prompt_admission_uncertain",
            })
            if (changed) this.#children.delete(childID)
            return false
          },
        )
      if (!acknowledged) return undefined
      await this.store.transition(operation.id, ["starting"], "starting", { promptAdmitted: true })
      if (this.#closed) return undefined
      return childID
    } catch (cause) {
      if (createdChildID && this.#deletingParents.has(operation.parentID)) {
        await this.services.interrupt(createdChildID).catch(() => {})
        this.#children.delete(createdChildID)
        return undefined
      }
      const childID = (await this.store.operation(operation.id))?.childID ?? createdChildID
      const changed = await this.store.transition(operation.id, ["starting"], "failed", {
        terminalAt: this.now(),
        reason: cause instanceof Error ? cause.message : String(cause),
        reasonCode: "setup_failed",
      })
      if (changed && childID) this.#children.delete(childID)
      return undefined
    }
  }

  async #resume(operationID: string, childID: string) {
    const operation = await this.store.operation(operationID)
    if (!operation || terminal(operation.state) || this.#deletingParents.has(operation.parentID)) return
    if (operation.cancellationRequested) {
      await this.#applyCancellation(operationID, operation)
      return
    }
    await this.services.resume(childID)
  }
}

function deliveryKind(intent: DeliveryIntent): DeliveryKind {
  if (intent.metadata.kind === "admission-receipt") return "admission"
  if (intent.metadata.kind === "terminal-outcome") return "terminal"
  if (intent.metadata.kind === "recovery-notice") return "recovery"
  return "control"
}

function deterministicPromptID(operationID: string) {
  return "msg_" + createHash("sha256").update(`delegation-operation-v1\0${operationID}`).digest("hex")
}

function renderPrompt(operation: OperationRecord) {
  return operation.context
    ? `<delegation-context>${operation.context}</delegation-context>\n\n${operation.text}`
    : operation.text
}

function terminal(state: OperationState) {
  return state === "completed" || state === "failed" || state === "interrupted"
}

function terminalEvent(event: SupervisorEvent) {
  if (event.type === "session.execution.succeeded") return { state: "completed" as const }
  if (event.type === "session.execution.failed")
    return { state: "failed" as const, reason: event.reason ?? "child failed", reasonCode: "execution_failed" as const }
  if (event.type === "session.execution.interrupted")
    return {
      state: "interrupted" as const,
      reason: event.reason ?? "child interrupted",
      reasonCode: "user_interrupted" as const,
    }
  if (event.type === "session.deleted")
    return { state: "interrupted" as const, reason: "child session deleted", reasonCode: "child_deleted" as const }
  return undefined
}

import { Plugin } from "@opencode-ai/plugin/effect"
import { Agent, Model, Provider, Session, SessionMessage } from "@opencode-ai/schema"
import { DateTime, Effect, Stream } from "effect"
import { DelegationAdmission } from "./admission.js"
import { decode } from "./config.js"
import { DelegationControl } from "./control.js"
import { acquire, degrade, supervise, type Lease } from "./runtime.js"
import { isStorageFailure, storageFailureCause } from "./storage.js"
import { classifyPromptFailure, Supervisor } from "./supervisor.js"
import { workspaceQuery } from "./supervision.js"

export default Plugin.define({
  id: "opencode.delegation",
  effect: Effect.fn("DelegationPlugin.activate")(function* (context) {
    const lease: Lease = yield* Effect.acquireRelease(
      Effect.promise(() => acquire(decode(context.options))),
      (lease) => Effect.promise(() => lease.close()),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Delegation plugin activation is degraded", { cause }).pipe(
          Effect.as({
            health: { status: "degraded" as const, reason: "invalid_options" as const, detail: String(cause) },
            close: async () => {},
          }),
        ),
      ),
    )
    const candidate =
      "runtime" in lease
        ? new Supervisor(lease.runtime.store, lease.runtime.options.concurrency, {
            parentExists: (parentID) =>
              Effect.runPromise(
                context.session.get({ sessionID: Session.ID.make(parentID) }).pipe(
                  Effect.as(true),
                  Effect.catchIf(
                    (cause): cause is { readonly _tag: "Session.NotFoundError" } =>
                      typeof cause === "object" &&
                      cause !== null &&
                      "_tag" in cause &&
                      cause._tag === "Session.NotFoundError",
                    () => Effect.succeed(false),
                  ),
                ),
              ),
            validate: (operation) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  const parent = yield* context.session.get({ sessionID: Session.ID.make(operation.parentID) })
                  const location = {
                    directory: parent.location.directory,
                    ...(parent.location.workspaceID === undefined ? {} : { workspace: parent.location.workspaceID }),
                  }
                  const inventory = yield* Effect.all({
                    agents: context.agent.list({ location }).pipe(Effect.map((result) => result.data)),
                    models: context.catalog.model.list({ location }).pipe(Effect.map((result) => result.data)),
                    skills: context.skill.list({ location }).pipe(Effect.map((result) => result.data)),
                  })
                  if (!inventory.agents.some((agent) => agent.id === operation.agent))
                    return yield* Effect.fail(new Error(`Admitted agent disappeared: ${operation.agent}`))
                  const model = inventory.models.find(
                    (model) => model.providerID === operation.model.providerID && model.id === operation.model.modelID,
                  )
                  if (!model)
                    return yield* Effect.fail(
                      new Error(`Admitted model disappeared: ${operation.model.providerID}/${operation.model.modelID}`),
                    )
                  if (
                    operation.model.variant !== undefined &&
                    !model.variants.some((variant) => variant.id === operation.model.variant)
                  )
                    return yield* Effect.fail(
                      new Error(`Admitted model variant disappeared: ${operation.model.variant}`),
                    )
                  const agent = operation.agents.find(
                    (reference) =>
                      !inventory.agents.some(
                        (candidate) => candidate.id === reference.name || candidate.name === reference.name,
                      ),
                  )
                  if (agent) return yield* Effect.fail(new Error(`Admitted agent reference disappeared: ${agent.name}`))
                  const skill = operation.skills.find(
                    (reference) => !inventory.skills.some((candidate) => candidate.id === reference.id),
                  )
                  if (skill) return yield* Effect.fail(new Error(`Admitted skill disappeared: ${skill.id}`))
                  return undefined
                }),
              ),
            createChild: (input) =>
              Effect.runPromise(
                context.session
                  .createChild({
                    parentID: Session.ID.make(input.parentID),
                    title: input.title,
                    agent: Agent.ID.make(input.agent),
                    model: Model.Ref.make({
                      providerID: Provider.ID.make(input.model.providerID),
                      id: Model.ID.make(input.model.modelID),
                      ...(input.model.variant === undefined
                        ? {}
                        : { variant: Model.VariantID.make(input.model.variant) }),
                    }),
                  })
                  .pipe(Effect.map((session) => session.id)),
              ),
            prompt: (input) =>
              Effect.runPromise(
                context.session
                  .prompt({
                    ...input,
                    sessionID: Session.ID.make(input.sessionID),
                    id: SessionMessage.ID.make(input.id),
                  })
                  .pipe(Effect.mapError(classifyPromptFailure)),
              ),
            resume: (sessionID) => Effect.runPromise(context.session.resume({ sessionID: Session.ID.make(sessionID) })),
            cancelInbox: (input) =>
              Effect.runPromise(
                context.session.inbox.cancel({
                  sessionID: Session.ID.make(input.sessionID),
                  inboxID: SessionMessage.ID.make(input.inboxID),
                }),
              ),
            interrupt: (sessionID) =>
              Effect.runPromise(context.session.interrupt({ sessionID: Session.ID.make(sessionID) })),
            steer: (input) =>
              Effect.runPromise(
                context.session.prompt({
                  sessionID: Session.ID.make(input.sessionID),
                  ...(input.id === undefined ? {} : { id: SessionMessage.ID.make(input.id) }),
                  text: input.text,
                  ...(input.resume === undefined ? {} : { resume: input.resume }),
                }),
              ),
            messages: (sessionID) =>
              Effect.runPromise(
                context.session.messages({ sessionID: Session.ID.make(sessionID), order: "desc", limit: 20 }).pipe(
                  Effect.map((messages) =>
                    messages.flatMap((message) =>
                      message.type === "assistant"
                        ? [
                            {
                              type: message.type,
                              completed: message.time.completed !== undefined,
                              failed: message.error !== undefined,
                              content: message.content,
                            },
                          ]
                        : [],
                    ),
                  ),
                ),
              ),
            synthetic: (input) =>
              Effect.runPromise(
                context.session.synthetic({
                  ...input,
                  sessionID: Session.ID.make(input.sessionID),
                  id: SessionMessage.ID.make(input.id),
                }),
              ),
            deliveryError: (cause, intent) => {
              const failure = storageFailureCause(cause)
              void Promise.all([
                Effect.runPromise(
                  Effect.logError("Delegation delivery failed", {
                    cause,
                    ...(intent === undefined ? {} : { parentID: intent.parentID, messageID: intent.id }),
                  }),
                ),
                ...(failure && "runtime" in lease ? [degrade(lease.runtime, failure.code, failure.message)] : []),
              ])
            },
          })
        : undefined
    const startup =
      candidate && "runtime" in lease ? (lease.runtime.supervision?.supervisor ?? candidate).start() : undefined
    const supervisor =
      candidate && "runtime" in lease
        ? supervise(
            lease.runtime,
            candidate,
            context.event.subscribe().pipe(
              Stream.runForEach((event) => {
                if (event.type === "permission.asked")
                  return Effect.promise(() =>
                    candidate.handle({
                      type: event.type,
                      sessionID: event.data.sessionID,
                      requestID: event.data.id,
                    }),
                  )
                if (event.type === "permission.replied")
                  return Effect.promise(() =>
                    candidate.handle({
                      type: event.type,
                      sessionID: event.data.sessionID,
                      requestID: event.data.requestID,
                    }),
                  )
                if (
                  event.type === "session.execution.started" ||
                  event.type === "session.execution.succeeded" ||
                  event.type === "session.execution.failed" ||
                  event.type === "session.execution.interrupted" ||
                  event.type === "session.deleted"
                )
                  return Effect.promise(() =>
                    candidate.handle({
                      type: event.type,
                      sessionID: event.data.sessionID,
                      ...(event.type === "session.execution.interrupted" ? { reason: event.data.reason } : {}),
                      ...(event.type === "session.execution.failed" ? { reason: event.data.error.message } : {}),
                    }),
                  )
                return Effect.void
              }),
            ),
          )
        : undefined
    if (startup && "runtime" in lease)
      yield* Effect.promise(() =>
        startup.catch((cause) =>
          degrade(
            lease.runtime,
            isStorageFailure(cause) ? cause.code : "startup_failed",
            cause instanceof Error ? cause.message : String(cause),
          ),
        ),
      )
    yield* context.plugin.query.register(
      "supervision",
      workspaceQuery({
        store: "runtime" in lease ? lease.runtime.store : lease.store,
        health: () => lease.health,
        sessions: () =>
          context.session.list().pipe(
            Effect.map((sessions) =>
              sessions.data.map((session) => ({
                id: session.id,
                ...(session.title === undefined ? {} : { title: session.title }),
                ...(session.parentID === undefined ? {} : { parentID: session.parentID }),
                archived: session.time.archived !== undefined,
                updated: DateTime.toEpochMillis(session.time.updated),
              })),
            ),
          ),
      }),
    )
    yield* context.command.register("delegate", (input) => {
      if (!("runtime" in lease) || lease.runtime.health.status === "degraded") {
        const health = "runtime" in lease ? lease.runtime.health : lease.health
        if (health.status === "healthy") return Effect.die("unreachable healthy Delegation runtime")
        return Effect.fail(new DelegationControl.CoordinatorUnavailableError(health))
      }
      return DelegationAdmission.execute(
        input,
        {
          parent: () => context.session.get({ sessionID: input.sessionID }),
          agents: () => context.agent.list().pipe(Effect.map((result) => result.data)),
          models: () =>
            context.catalog.model.list().pipe(
              Effect.map((result) =>
                result.data.map((model) => ({
                  providerID: model.providerID,
                  id: model.id,
                  variants: model.variants.map((variant) => variant.id),
                })),
              ),
            ),
          defaultModel: () =>
            context.catalog.model
              .default()
              .pipe(
                Effect.map((result) =>
                  result.data === undefined ? undefined : { providerID: result.data.providerID, id: result.data.id },
                ),
              ),
          skills: () => context.skill.list().pipe(Effect.map((result) => result.data)),
          synthetic: (receipt) =>
            context.session.synthetic({
              ...receipt,
              sessionID: input.sessionID,
              id: SessionMessage.ID.make(receipt.id),
            }),
        },
        lease.runtime.store,
      ).pipe(
        Effect.tap(() => Effect.promise(() => supervisor?.drain() ?? Promise.resolve())),
        Effect.tapError((cause) =>
          Effect.promise(async () => {
            const failure = storageFailureCause(cause)
            if (failure) await degrade(lease.runtime, failure.code, failure.message)
          }),
        ),
      )
    })
    yield* context.command.register("delegation", (input) => {
      const store = "runtime" in lease ? lease.runtime.store : lease.store
      if (store === undefined) {
        if (lease.health.status === "healthy") return Effect.die("unreachable healthy Delegation runtime")
        return Effect.fail(new DelegationControl.CoordinatorUnavailableError(lease.health))
      }
      return DelegationControl.execute(
        input,
        {
          health: () => lease.health,
          cancel: (operationIDs) => supervisor?.applyControl({ kind: "cancel", operationIDs }) ?? Promise.resolve(),
          steer: (effect) => supervisor?.applyControl(effect) ?? Promise.resolve(),
          synthetic: (receipt) =>
            context.session.synthetic({
              ...receipt,
              sessionID: input.sessionID,
              id: SessionMessage.ID.make(receipt.id),
            }),
        },
        store,
      ).pipe(
        Effect.tap(() =>
          Effect.promise(() => supervisor?.retryDeliveries().then(() => supervisor.drain()) ?? Promise.resolve()),
        ),
        Effect.tapError((cause) =>
          Effect.promise(async () => {
            const failure = storageFailureCause(cause)
            if (failure && "runtime" in lease) await degrade(lease.runtime, failure.code, failure.message)
          }),
        ),
      )
    }, { discoverable: false })
    if (lease.health.status === "degraded")
      yield* Effect.logError("Delegation coordinator is unavailable", lease.health)
  }),
})

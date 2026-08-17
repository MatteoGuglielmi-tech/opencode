import { describe, expect } from "bun:test"
import { Effect, Layer, LayerMap } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { Agent } from "@opencode-ai/core/agent"
import { Bus } from "@opencode-ai/core/bus"
import { Command } from "@opencode-ai/core/command"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Session } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { LocationServiceMap } from "@opencode-ai/core/location-service-map"
import type { LocationServices } from "@opencode-ai/core/location-services"
import { Model } from "@opencode-ai/core/model"
import { Provider } from "@opencode-ai/core/provider"
import { LayerNode } from "@opencode-ai/util/effect/layer-node"
import { testEffect } from "./lib/effect"

const sessionID = Session.ID.make("ses_command_test")
const wakes: Session.ID[] = []
let session: Session.Interface
let executor: "user" | "synthetic" | undefined
let executed: Command.ExecutionInput | undefined
let metadataReads = 0
let evaluations = 0

const command = Command.Service.of({
  reload: () => Effect.void,
  transform: () => Effect.die("unused command.transform"),
  register: () => Effect.die("unused command.register"),
  list: () => Effect.succeed([]),
  get: (name) =>
    Effect.sync(() => {
      metadataReads++
      return name === "fallback" ? Command.Info.make({ name, template: "ignored" }) : undefined
    }),
  evaluate: (input) =>
    Effect.suspend(() => {
      evaluations++
      if (input.arguments === "fail")
        return Effect.fail(new Command.EvaluationError({ command: input.name, message: "evaluation failed" }))
      return Effect.succeed({ text: `evaluated: ${input.arguments}` })
    }),
  execute: (input) => {
    executed = input
    if (executor === "user")
      return session
        .prompt({
          id: input.id,
          sessionID: input.sessionID,
          text: "user result",
          delivery: input.delivery,
          resume: false,
        })
        .pipe(Effect.orDie)
    if (executor === "synthetic")
      return session
        .synthetic({
          id: input.id,
          sessionID: input.sessionID,
          text: "synthetic result",
          delivery: input.delivery,
          resume: false,
        })
        .pipe(Effect.orDie)
    return Effect.succeed(undefined)
  },
})

const locations = Layer.effect(
  LocationServiceMap.Service,
  LayerMap.make(() => Layer.succeed(Command.Service, command) as unknown as Layer.Layer<LocationServices>),
)
const execution = Layer.succeed(
  SessionExecution.Service,
  SessionExecution.Service.of({
    active: Effect.succeed(new Set()),
    resume: () => Effect.void,
    interrupt: () => Effect.void,
    wake: (id) => Effect.sync(() => wakes.push(id)),
    awaitIdle: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, Bus.node, SessionProjector.node, SessionStore.node, Session.node]),
    [
      [Bus.node, Bus.configured({ persist: true })],
      [SessionExecution.node, execution],
      [LocationServiceMap.node, locations],
    ],
  ),
)

const setup = Effect.gen(function* () {
  const database = yield* Database.Service
  yield* database.db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* database.db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "test",
      directory: "/project",
      title: "test",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  session = yield* Session.Service
  executor = undefined
  executed = undefined
  metadataReads = 0
  evaluations = 0
  wakes.length = 0
})

describe("Session.command", () => {
  it.effect("dispatches executable-only commands before metadata and returns either durable result", () =>
    Effect.gen(function* () {
      yield* setup
      const input = {
        sessionID,
        id: SessionMessage.ID.make("msg_command_synthetic"),
        command: "executable-only",
        arguments: "--exact value",
        agent: Agent.ID.make("reviewer"),
        model: Model.Ref.make({
          id: Model.ID.make("claude"),
          providerID: Provider.ID.make("anthropic"),
          variant: Model.VariantID.make("high"),
        }),
        delivery: "queue" as const,
        resume: true,
      }
      executor = "synthetic"
      const synthetic = yield* session.command(input)

      expect(synthetic.type).toBe("synthetic")
      expect(executed).toBe(input)
      expect(metadataReads).toBe(0)
      expect(evaluations).toBe(0)
      expect(wakes).toEqual([])
      expect((yield* session.get(sessionID)).agent).toBeUndefined()
      expect((yield* session.get(sessionID)).model).toBeUndefined()

      executor = "user"
      const user = yield* session.command({
        ...input,
        id: SessionMessage.ID.make("msg_command_user"),
      })
      expect(user.type).toBe("user")
      expect(wakes).toEqual([])
    }),
  )

  it.effect("preserves metadata and template fallback when no executor is active", () =>
    Effect.gen(function* () {
      yield* setup
      const result = yield* session.command({
        sessionID,
        id: SessionMessage.ID.make("msg_command_fallback"),
        command: "fallback",
        arguments: "ordinary",
        resume: false,
      })

      expect(result.type).toBe("user")
      expect(result.payload.text).toBe("evaluated: ordinary")
      expect(metadataReads).toBe(1)
      expect(evaluations).toBe(1)
      expect(wakes).toEqual([])
    }),
  )

  it.effect("preserves fallback evaluation errors", () =>
    Effect.gen(function* () {
      yield* setup
      expect(
        yield* session.command({ sessionID, command: "fallback", arguments: "fail", resume: false }).pipe(Effect.flip),
      ).toEqual(new Command.EvaluationError({ command: "fallback", message: "evaluation failed" }))
    }),
  )
})

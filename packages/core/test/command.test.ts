import { describe, expect } from "bun:test"
import { DateTime, Effect, Exit, Fiber } from "effect"
import { Command } from "@opencode-ai/core/command"
import { Config } from "@opencode-ai/core/config"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Location } from "@opencode-ai/core/location"
import { MCP } from "@opencode-ai/core/mcp/index"
import { Model } from "@opencode-ai/core/model"
import { Provider } from "@opencode-ai/core/provider"
import { Agent } from "@opencode-ai/core/agent"
import { Session } from "@opencode-ai/core/session"
import { SessionInbox } from "@opencode-ai/core/session/inbox"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Skill } from "@opencode-ai/core/skill"
import { emptyConfigLayer, emptyMcpLayer, testLocationLayer } from "./fixture/mcp"
import { testEffect } from "./lib/effect"

const it = testEffect(
  AppNodeBuilder.build(Command.node, [
    [MCP.node, emptyMcpLayer],
    [Config.node, emptyConfigLayer],
    [Location.node, testLocationLayer],
  ]),
)

describe("Command", () => {
  const input: Command.ExecutionInput = {
    sessionID: Session.ID.make("ses_command"),
    id: SessionMessage.ID.make("msg_command"),
    command: "execute",
    arguments: "--exact value",
    agent: Agent.ID.make("reviewer"),
    model: {
      id: Model.ID.make("claude"),
      providerID: Provider.ID.make("anthropic"),
      variant: Model.VariantID.make("high"),
    },
    files: [{ uri: "file:///tmp/example.ts", name: "example.ts" }],
    agents: [{ name: "reviewer", mention: { start: 0, end: 9, text: "@reviewer" } }],
    skills: [{ id: Skill.ID.make("testing"), mention: { start: 10, end: 18, text: "@testing" } }],
    delivery: "queue",
    resume: false,
  }
  const output = SessionInbox.Synthetic.make({
    id: SessionMessage.ID.make("msg_result"),
    sessionID: input.sessionID,
    timeCreated: DateTime.makeUnsafe(0),
    type: "synthetic",
    payload: { text: "executed" },
    delivery: "queue",
  })

  it.effect("applies command transforms and preserves later overrides", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* command.transform((editor) => {
        editor.update("review", (command) => {
          command.template = "First"
          command.description = "Review code"
        })
        editor.update("review", (command) => {
          command.template = "Second"
          command.model = {
            id: Model.ID.make("claude"),
            providerID: Provider.ID.make("anthropic"),
            variant: Model.VariantID.make("high"),
          }
        })
      })

      expect(yield* command.get("review")).toEqual(
        Command.Info.make({
          name: "review",
          template: "Second",
          description: "Review code",
          model: {
            id: Model.ID.make("claude"),
            providerID: Provider.ID.make("anthropic"),
            variant: Model.VariantID.make("high"),
          },
        }),
      )
      expect(yield* command.list()).toEqual([
        Command.Info.make({
          name: "review",
          template: "Second",
          description: "Review code",
          model: {
            id: Model.ID.make("claude"),
            providerID: Provider.ID.make("anthropic"),
            variant: Model.VariantID.make("high"),
          },
        }),
      ])
    }),
  )

  it.effect("evaluates command template shell blocks", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* command.transform((editor) => {
        editor.update("review", (command) => {
          command.template = "Output: !`echo command-output`"
        })
      })

      expect((yield* command.evaluate({ name: "review" })).text.replace(/\r?\n$/, "")).toEqual("Output: command-output")
    }),
  )

  it.effect("runs scoped executors with the exact invocation", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      expect(yield* command.execute(input)).toBeUndefined()
      let seen: Command.ExecutionInput | undefined
      yield* command.register("execute", (value) =>
        Effect.sync(() => {
          seen = value
          return output
        }),
      )

      expect(yield* command.execute(input)).toEqual(output)
      expect(seen).toBe(input)
    }),
  )

  it.effect("lists scoped executors for command clients", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      const registration = yield* command.register("execute", () => Effect.succeed(output))

      expect(yield* command.list()).toContainEqual({ name: "execute", template: "" })
      yield* registration.dispose
      expect(yield* command.list()).not.toContainEqual({ name: "execute", template: "" })
    }),
  )

  it.effect("rejects duplicates without replacing the active executor", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* command.register("execute", () => Effect.succeed(output))
      const duplicate = yield* command.register("execute", () => Effect.die("replacement")).pipe(Effect.exit)

      expect(Exit.isFailure(duplicate)).toBe(true)
      expect(yield* command.execute(input)).toEqual(output)
    }),
  )

  it.effect("disposes registrations manually and with their scope", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* Effect.scoped(
        Effect.gen(function* () {
          const registration = yield* command.register("execute", () => Effect.succeed(output))
          expect(yield* command.execute(input)).toEqual(output)
          yield* registration.dispose
          yield* registration.dispose
          expect(yield* command.execute(input)).toBeUndefined()
          yield* command.register("execute", () => Effect.succeed(output))
        }),
      )
      expect(yield* command.execute(input)).toBeUndefined()
    }),
  )

  it.effect("maps executor failures to command evaluation errors", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      yield* command.register("execute", () => Effect.fail(new Error("execution failed")))

      expect(yield* command.execute(input).pipe(Effect.flip)).toEqual(
        new Command.EvaluationError({ command: "execute", message: "execution failed" }),
      )
    }),
  )

  it.effect("interrupts Effect executors with the request fiber", () =>
    Effect.gen(function* () {
      const command = yield* Command.Service
      let startedResolve: () => void = () => {}
      const started = new Promise<void>((resolve) => (startedResolve = resolve))
      let interrupted = false
      yield* command.register("execute", () =>
        Effect.sync(startedResolve).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => (interrupted = true))),
        ),
      )
      const fiber = yield* command.execute(input).pipe(Effect.forkScoped)
      yield* Effect.promise(() => started)
      yield* Fiber.interrupt(fiber)

      expect(interrupted).toBe(true)
    }),
  )
})

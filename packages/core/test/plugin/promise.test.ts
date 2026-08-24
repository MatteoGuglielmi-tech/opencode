import { describe, expect } from "bun:test"
import { Message, SystemPart } from "@opencode-ai/ai"
import { DateTime, Effect, Fiber, Schema } from "effect"
import { Agent } from "@opencode-ai/core/agent"
import { Catalog } from "@opencode-ai/core/catalog"
import { Command } from "@opencode-ai/core/command"
import { Model } from "@opencode-ai/core/model"
import { Plugin } from "@opencode-ai/core/plugin"
import { PluginHooks } from "@opencode-ai/core/plugin/hooks"
import { PluginHost } from "@opencode-ai/core/plugin/host"
import { PluginPromise } from "@opencode-ai/core/plugin/promise"
import { WebSearch } from "@opencode-ai/core/websearch"
import { Session } from "@opencode-ai/core/session"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionInbox } from "@opencode-ai/core/session/inbox"
import { Skill } from "@opencode-ai/core/skill"
import { Tool } from "@opencode-ai/core/tool"
import { Provider } from "@opencode-ai/core/provider"
import { define } from "@opencode-ai/plugin/promise/plugin"
import type { Context as PromisePluginContext } from "@opencode-ai/plugin/promise/plugin"
import type { Context as EffectPluginContext } from "@opencode-ai/plugin/effect/plugin"
import type { SessionHooks } from "@opencode-ai/plugin/effect/session"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"
import { host as testHost } from "./host"

const it = testEffect(PluginTestLayer)

const assertCreateChildTypes = (promise: PromisePluginContext, effect: EffectPluginContext) => {
  const parentID = Session.ID.create()
  void promise.session.createChild({ parentID })
  void effect.session.createChild({ parentID })
  // @ts-expect-error parentID is required.
  void promise.session.createChild({})
  // @ts-expect-error child IDs are host-selected.
  void effect.session.createChild({ parentID, id: Session.ID.create() })
  // @ts-expect-error child Locations are inherited from the parent.
  void promise.session.createChild({ parentID, location: { directory: "/other" } })
  // @ts-expect-error child permissions come from the selected agent.
  void effect.session.createChild({ parentID, permissions: [] })
  // @ts-expect-error child permission overrides are not accepted.
  void promise.session.createChild({ parentID, permissionOverrides: [] })
}
void assertCreateChildTypes

describe("fromPromise", () => {
  it.effect("forwards trusted child creation without reinterpretation", () =>
    Effect.gen(function* () {
      let seen: unknown
      const host = testHost({
        session: {
          createChild: (input) => {
            seen = input
            return Effect.fail(new Error("expected test failure"))
          },
        },
      })
      const input = {
        parentID: Session.ID.make("ses_parent"),
        title: "Delegated child",
        agent: Agent.ID.make("reviewer"),
        model: Model.Ref.make({
          id: Model.ID.make("claude"),
          providerID: Provider.ID.make("anthropic"),
          variant: Model.VariantID.make("high"),
        }),
      }

      yield* PluginPromise.fromPromise(
        define({
          id: "promise-session-child",
          setup: async (ctx) => {
            await ctx.session.createChild(input).catch(() => undefined)
          },
        }),
      ).effect(host)

      expect(seen).toEqual({
        parentID: Session.ID.make(input.parentID),
        title: input.title,
        agent: Agent.ID.make(input.agent),
        model: Model.Ref.make({
          id: Model.ID.make(input.model.id),
          providerID: Provider.ID.make(input.model.providerID),
          variant: input.model.variant === undefined ? undefined : Model.VariantID.make(input.model.variant),
        }),
      })
    }),
  )

  it.effect("registers executable commands and preserves invocation and output", () =>
    Effect.gen(function* () {
      let executor: Command.Executor | undefined
      let disposed = false
      const host = testHost({
        command: {
          register: (_name, execute) =>
            Effect.sync(() => {
              executor = execute
              return { dispose: Effect.sync(() => (disposed = true)) }
            }),
        },
      })
      let registration: { readonly dispose: () => Promise<void> } | undefined
      let seen: unknown
      yield* PluginPromise.fromPromise(
        define({
          id: "promise-command",
          setup: async (ctx) => {
            registration = await ctx.command.register("execute", async (input, context) => {
              seen = { input, signal: context.signal }
              return {
                id: "msg_result",
                sessionID: input.sessionID,
                timeCreated: 0,
                type: "synthetic",
                payload: { text: "executed" },
                delivery: "queue",
              }
            })
          },
        }),
      ).effect(host)
      const input: Command.ExecutionInput = {
        sessionID: Session.ID.make("ses_command"),
        id: SessionMessage.ID.make("msg_command"),
        command: "execute",
        arguments: "--exact value",
        agent: Agent.ID.make("reviewer"),
        model: Model.Ref.make({
          id: Model.ID.make("claude"),
          providerID: Provider.ID.make("anthropic"),
          variant: Model.VariantID.make("high"),
        }),
        files: [{ uri: "file:///tmp/example.ts", name: "example.ts" }],
        agents: [{ name: "reviewer" }],
        skills: [{ id: Skill.ID.make("testing") }],
        delivery: "queue",
        resume: false,
      }
      const activeRegistration = registration
      if (!executor || !activeRegistration) return yield* Effect.die("command registration missing")

      expect(yield* executor(input)).toEqual(
        SessionInbox.Synthetic.make({
          id: SessionMessage.ID.make("msg_result"),
          sessionID: input.sessionID,
          timeCreated: DateTime.makeUnsafe(0),
          type: "synthetic",
          payload: { text: "executed" },
          delivery: "queue",
        }),
      )
      expect(seen).toEqual({ input, signal: expect.any(AbortSignal) })
      yield* Effect.promise(() => activeRegistration.dispose())
      expect(disposed).toBe(true)
    }),
  )

  it.effect("aborts Promise command handlers when execution is interrupted", () =>
    Effect.gen(function* () {
      let executor: Command.Executor | undefined
      let signal: AbortSignal | undefined
      let startedResolve: () => void = () => {}
      const started = new Promise<void>((resolve) => (startedResolve = resolve))
      const host = testHost({
        command: {
          register: (_name, execute) =>
            Effect.sync(() => {
              executor = execute
              return { dispose: Effect.void }
            }),
        },
      })
      yield* PluginPromise.fromPromise(
        define({
          id: "promise-command-cancellation",
          setup: async (ctx) => {
            await ctx.command.register("wait", async (_input, context) => {
              signal = context.signal
              startedResolve()
              await new Promise<void>((resolve) =>
                context.signal.addEventListener("abort", () => resolve(), { once: true }),
              )
              throw new Error("aborted")
            })
          },
        }),
      ).effect(host)
      if (!executor) return yield* Effect.die("command registration missing")
      const fiber = yield* executor({ sessionID: Session.ID.make("ses_command"), command: "wait" }).pipe(
        Effect.forkScoped,
      )
      yield* Effect.promise(() => started)
      yield* Fiber.interrupt(fiber)

      expect(signal?.aborted).toBe(true)
    }),
  )

  it.effect("forwards transient session generation", () =>
    Effect.gen(function* () {
      const host = testHost({
        session: {
          generate: (input) => Effect.succeed({ text: `${input.sessionID}: ${input.prompt}` }),
        },
      })

      yield* PluginPromise.fromPromise(
        define({
          id: "promise-session-generate",
          setup: async (ctx) => {
            expect(await ctx.session.generate({ sessionID: "ses_generate", prompt: "Summarize" })).toEqual({
              text: "ses_generate: Summarize",
            })
          },
        }),
      ).effect(host)
    }),
  )

  it.effect("forwards session message reads", () =>
    Effect.gen(function* () {
      let seen: unknown
      const host = testHost({
        session: {
          messages: (input) => {
            seen = input
            return Effect.succeed([])
          },
        },
      })

      yield* PluginPromise.fromPromise(
        define({
          id: "promise-session-messages",
          setup: async (ctx) => {
            expect(await ctx.session.messages({ sessionID: "ses_session", order: "desc", limit: 1 })).toEqual([])
          },
        }),
      ).effect(host)
      expect(seen).toEqual({ sessionID: "ses_session", order: "desc", limit: 1 })
    }),
  )

  it.effect("forwards synthetic session input", () =>
    Effect.gen(function* () {
      const input = {
        sessionID: "ses_synthetic",
        id: "msg_synthetic",
        text: "Background work completed",
        description: null,
        metadata: { shellID: "shell_1" },
        delivery: null,
        resume: null,
      }
      let seen: unknown
      const host = testHost({
        session: {
          synthetic: (value) => {
            seen = value
            return Effect.succeed(
              SessionInbox.Synthetic.make({
                id: SessionMessage.ID.make(input.id),
                sessionID: Session.ID.make(input.sessionID),
                timeCreated: DateTime.makeUnsafe(0),
                type: "synthetic",
                payload: {
                  text: input.text,
                  metadata: input.metadata,
                },
                delivery: "queue",
              }),
            )
          },
        },
      })

      yield* PluginPromise.fromPromise(
        define({
          id: "promise-session-synthetic",
          setup: async (ctx) => {
            await ctx.session.synthetic(input)
          },
        }),
      ).effect(host)

      expect(seen).toEqual({
        ...input,
        description: undefined,
        delivery: undefined,
        resume: undefined,
      })
    }),
  )

  it.effect("forwards standard client reads", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      const seen: string[] = []
      const promisePlugin = define({
        id: "promise-client-reads",
        setup: async (ctx) => {
          const results = await Promise.all([
            ctx.agent.list(),
            ctx.catalog.provider.list(),
            ctx.catalog.model.list(),
            ctx.command.list(),
            ctx.integration.list(),
            ctx.plugin.list(),
            ctx.reference.list(),
            ctx.skill.list(),
          ])
          seen.push(...results.map((result) => result.location.directory))
        },
      })

      yield* PluginPromise.fromPromise(promisePlugin).effect(host)

      expect(seen).toHaveLength(8)
      expect(new Set(seen).size).toBe(1)
    }),
  )

  it.effect("forwards direct agent and model list reads", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const catalog = yield* Catalog.Service
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      yield* agents.transform((draft) =>
        draft.update(Agent.ID.make("reviewer"), (agent) => {
          agent.description = "Reviews code"
        }),
      )
      yield* catalog.transform((draft) =>
        draft.model.update(Provider.ID.make("test"), Model.ID.make("alias"), (model) => {
          model.modelID = Model.ID.make("gpt-5")
        }),
      )

      yield* PluginPromise.fromPromise(
        define({
          id: "promise-direct-reads",
          setup: async (ctx) => {
            expect((await ctx.agent.get({ agentID: Agent.ID.make("reviewer") })).data).toMatchObject({
              description: "Reviews code",
            })
            await expect(ctx.agent.get({ agentID: Agent.ID.make("missing") })).rejects.toThrow(
              "Agent not found: missing",
            )
            const models = (await ctx.catalog.model.list()).data
            expect(models.find((model) => model.providerID === "test" && model.id === "alias")).toMatchObject({
              modelID: "gpt-5",
            })
            expect(models.find((model) => model.providerID === "test" && model.id === "missing")).toBeUndefined()
          },
        }),
      ).effect(host)
    }),
  )

  it.effect("loads a promise plugin and registers a transform hook", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)

      const promisePlugin = define({
        id: "promise-example",
        setup: async (ctx) => {
          expect(ctx.options.mode).toBe("strict")
          await ctx.agent.transform((draft) => {
            draft.update("reviewer", (item) => {
              item.description = "Reviews code"
              item.mode = "subagent"
            })
          })
        },
      })

      const adapted = PluginPromise.fromPromise(promisePlugin)
      yield* adapted.effect({ ...host, options: { mode: "strict" } })

      expect(yield* agents.get(Agent.ID.make("reviewer"))).toMatchObject({
        description: "Reviews code",
        mode: "subagent",
      })
    }),
  )

  it.effect("forwards session context hooks", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const hooks = yield* PluginHooks.Service
      const host = yield* PluginHost.make(plugin)
      yield* PluginPromise.fromPromise(
        define({
          id: "promise-session-context",
          setup: async (ctx) => {
            await ctx.session.hook("context", (event) => {
              event.system.push(SystemPart.make("Promise hook"))
              delete event.tools.echo
            })
          },
        }),
      ).effect(host)
      const event: SessionHooks["context"] = {
        sessionID: Session.ID.make("ses_promise_session_context"),
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("model") }),
        system: [SystemPart.make("Initial")],
        messages: [Message.user("Hello")],
        tools: { echo: { description: "Echo", input: { type: "object" } } },
      }

      yield* hooks.trigger("session", "context", event)

      expect(event.system.map((part) => part.text)).toEqual(["Initial", "Promise hook"])
      expect(event.tools).toEqual({})
    }),
  )

  it.effect("adapts promise session HTTP request and response hooks", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const hooks = yield* PluginHooks.Service
      const host = yield* PluginHost.make(plugin)
      yield* PluginPromise.fromPromise(
        define({
          id: "promise-session-http",
          setup: async (ctx) => {
            await ctx.session.hook("http.request", (event) => {
              event.request = new Request("https://provider.test/changed", event.request)
              event.request.headers.set("x-hook", "promise")
            })
            await ctx.session.hook("http.response", async (event) => {
              event.response = new Response(`${await event.response.text()}-response`, {
                status: event.response.status,
              })
            })
          },
        }),
      ).effect(host)
      const context = {
        sessionID: Session.ID.make("ses_promise_session_http"),
        agent: Agent.ID.make("build"),
        model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("model") }),
      }

      const request = yield* hooks.trigger("session", "http.request", {
        ...context,
        request: new Request("https://provider.test", { method: "POST", body: "payload" }),
      })
      const response = yield* hooks.trigger("session", "http.response", {
        ...context,
        request: request.request,
        response: new Response(request.request.headers.get("x-hook") ?? "missing"),
      })

      expect(request.request.url).toBe("https://provider.test/changed")
      expect(yield* Effect.promise(() => response.response.text())).toBe("promise-response")
    }),
  )

  it.effect("disposes a hook registration on request", () =>
    Effect.gen(function* () {
      const agents = yield* Agent.Service
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)

      const promisePlugin = define({
        id: "promise-dispose",
        setup: async (ctx) => {
          const registration = await ctx.agent.transform((draft) => {
            draft.update("temp", (item) => {
              item.description = "temporary"
            })
          })
          await registration.dispose()
        },
      })

      const adapted = PluginPromise.fromPromise(promisePlugin)
      yield* adapted.effect(host)

      expect(yield* agents.get(Agent.ID.make("temp"))).toBeUndefined()
    }),
  )

  it.effect("registers a standalone web search provider", () =>
    Effect.gen(function* () {
      const websearch = yield* WebSearch.Service
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      const promisePlugin = define({
        id: "promise-websearch",
        setup: async (ctx) => {
          await ctx.websearch.transform((draft) => {
            draft.add({
              id: "promise-websearch",
              name: "Promise Web Search",
              execute: async (input) => [{ url: "https://example.com", content: `promise: ${input.query}`, time: {} }],
            })
          })
        },
      })

      yield* PluginPromise.fromPromise(promisePlugin).effect(host)
      expect(yield* websearch.providers()).toContainEqual({
        id: WebSearch.ID.make("promise-websearch"),
        name: "Promise Web Search",
      })
      expect(yield* websearch.query({ query: "effect", providerID: WebSearch.ID.make("promise-websearch") })).toEqual(
        new WebSearch.Response({
          providerID: WebSearch.ID.make("promise-websearch"),
          results: [{ url: "https://example.com", content: "promise: effect", time: {} }],
        }),
      )
    }),
  )

  it.effect("runs the setup cleanup when the plugin scope closes", () =>
    Effect.gen(function* () {
      const plugin = yield* Plugin.Service
      const host = yield* PluginHost.make(plugin)
      const events: string[] = []
      const promisePlugin = define({
        id: "promise-cleanup",
        setup: async () => {
          events.push("setup")
          return async () => {
            await Promise.resolve()
            events.push("cleanup")
          }
        },
      })

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* PluginPromise.fromPromise(promisePlugin).effect(host)
          expect(events).toEqual(["setup"])
        }),
      )

      expect(events).toEqual(["setup", "cleanup"])
    }),
  )

  it.effect("constructs plain Promise tool definitions in the host", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const registry = yield* Tool.Service
      const host = yield* PluginHost.make(plugins)
      const progress: Tool.Metadata[] = []
      const promisePlugin = define({
        id: "promise-tool",
        setup: async (ctx) => {
          await ctx.tool.transform((tools) => {
            tools.add({
              name: "hello",
              options: { codemode: false },
              description: "Hello",
              input: Schema.Struct({ name: Schema.String }),
              output: Schema.String,
              execute: async ({ name }, context) => {
                await context.progress({ phase: "greeting" })
                return { output: `Hello, ${name}!` }
              },
            })
          })
        },
      })

      yield* PluginPromise.fromPromise(promisePlugin).effect(host)

      const toolSet = yield* registry.snapshot()
      expect(toolSet.definitions).toContainEqual(expect.objectContaining({ name: "hello", description: "Hello" }))
      expect(
        yield* toolSet.execute({
          sessionID: Session.ID.make("ses_promise_tool"),
          agent: Agent.ID.make("build"),
          messageID: SessionMessage.ID.make("msg_promise_tool"),
          progress: (update) => Effect.sync(() => progress.push(update)),
          call: { type: "tool-call", id: "call_promise_tool", name: "hello", input: { name: "world" } },
        }),
      ).toMatchObject({
        output: "Hello, world!",
        content: [{ type: "text", text: "Hello, world!" }],
      })
      expect(progress).toEqual([{ phase: "greeting" }])
    }),
  )

  it.effect("returns content-only plugin results through Code Mode", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const registry = yield* Tool.Service
      const host = yield* PluginHost.make(plugins)
      const promisePlugin = define({
        id: "content-only-tool",
        setup: async (ctx) => {
          await ctx.tool.transform((tools) => {
            tools.add({
              name: "demo_status",
              description: "Returns a status string",
              input: Schema.Struct({}),
              execute: async () => ({ content: [{ type: "text", text: "hello" }] }),
              options: { codemode: true },
            })
          })
        },
      })

      yield* PluginPromise.fromPromise(promisePlugin).effect(host)

      const toolSet = yield* registry.snapshot()
      const throughCodeMode = yield* toolSet.execute({
        sessionID: Session.ID.make("ses_content_only_tool"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_content_only_tool"),
        call: {
          type: "tool-call",
          id: "call_content_only_tool",
          name: "execute",
          input: { code: "return await tools.demo_status({})" },
        },
      })
      expect(throughCodeMode).toMatchObject({
        output: { output: "hello", toolCalls: [{ tool: "demo_status", status: "completed" }] },
        content: [{ type: "text", text: "hello" }],
      })
    }),
  )
})

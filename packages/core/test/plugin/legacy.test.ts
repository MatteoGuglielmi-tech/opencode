import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Plugin } from "@opencode/core/plugin"
import { PluginHooks } from "@opencode/core/plugin/hooks"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { PluginLegacy } from "../../src/plugin/legacy"
import { testEffect } from "../lib/effect"
import { PluginTestLayer } from "./fixture"

const it = testEffect(PluginTestLayer)

describe("PluginLegacy.fromModule", () => {
  test("accepts a classic named-export module (cbm shape)", () => {
    const mod = { CodebaseMemory: async () => ({ "tool.execute.after": async () => {} }) }
    const plugin = PluginLegacy.fromModule(mod, { target: "/home/u/.config/opencode/plugins/cbm-augment.ts" })
    expect(plugin).toBeDefined()
    expect(plugin!.id.startsWith("legacy:cbm-augment-")).toBe(true)
  })

  test("accepts a { id, server } default and keeps its id", () => {
    const mod = { default: { id: "herdr.opencode", server: async () => ({}) } }
    const plugin = PluginLegacy.fromModule(mod, { target: "/tmp/herdr-agent-state.js" })
    expect(plugin!.id).toBe("herdr.opencode")
  })

  test("is deterministic for the same target", () => {
    const mod = { X: async () => ({}) }
    const a = PluginLegacy.fromModule(mod, { target: "/tmp/a.ts" })!
    const b = PluginLegacy.fromModule(mod, { target: "/tmp/a.ts" })!
    expect(a.id).toBe(b.id)
  })

  test("returns undefined for a module with no factory exports", () => {
    expect(PluginLegacy.fromModule({ version: "1" }, { target: "/tmp/x.ts" })).toBeUndefined()
  })
})

describe("PluginLegacy hook bridge", () => {
  it.effect("appends v1 augmentation into tool.execute.after result.content", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const hooks = yield* PluginHooks.Service
      const mod = {
        Cbm: async () => ({
          "tool.execute.after": async (_input: unknown, output: { output: string }) => {
            output.output += "\nEXTRA"
          },
        }),
      }
      const legacy = PluginLegacy.fromModule(mod, { target: "/tmp/cbm-augment.ts" })!
      yield* plugins.activate([{ ...legacy, revision: "1" }])

      const event = {
        tool: "grep",
        sessionID: Session.ID.make("ses_legacy"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_legacy"),
        id: Tool.CallID.make("call_legacy"),
        input: {},
        status: "completed" as const,
        result: { content: "line", metadata: { matches: 1 } },
      }
      yield* hooks.trigger("tool", "execute.after", event)
      expect(event.result.content).toBe("line\nEXTRA")
    }),
  )

  it.effect("exposes tool args on the v1 output (cbm access pattern)", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const hooks = yield* PluginHooks.Service
      const mod = {
        Cbm: async () => ({
          "tool.execute.after": async (
            _input: unknown,
            output: { output: string; args?: { pattern?: string } },
          ) => {
            output.output += `\nPATTERN:${output.args?.pattern}`
          },
        }),
      }
      const legacy = PluginLegacy.fromModule(mod, { target: "/tmp/cbm-augment.ts" })!
      yield* plugins.activate([{ ...legacy, revision: "1" }])

      const event = {
        tool: "grep",
        sessionID: Session.ID.make("ses_legacy"),
        agent: Agent.ID.make("build"),
        messageID: SessionMessage.ID.make("msg_legacy"),
        id: Tool.CallID.make("call_legacy"),
        input: { pattern: "session" },
        status: "completed" as const,
        result: { content: "line", metadata: { matches: 1 } },
      }
      yield* hooks.trigger("tool", "execute.after", event)
      expect(event.result.content).toContain("session")
    }),
  )

  it.effect("logs and skips unsupported hooks without throwing", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const mod = { P: async () => ({ "chat.params": async () => {} }) }
      const legacy = PluginLegacy.fromModule(mod, { target: "/tmp/p.ts" })!
      yield* plugins.activate([{ ...legacy, revision: "1" }])
      expect(legacy.id.startsWith("legacy:p-")).toBe(true)
      expect((yield* plugins.list())[0]?.state.status).toBe("active")
    }),
  )
})

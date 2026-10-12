import { describe, expect, test } from "bun:test"
import { PluginLegacy } from "../../src/plugin/legacy"

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

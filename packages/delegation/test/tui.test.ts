import { describe, expect, test } from "bun:test"
import type { Context, KeymapLayer, Page, Route } from "@opencode-ai/plugin/tui/context"
import TuiPlugin, { openSupervision, returnFromSupervision } from "../src/tui"

describe("Delegation supervision TUI entry", () => {
  test("registers one page and one shared palette and slash command", () => {
    const harness = setup({ type: "session", sessionID: "ses_origin" })

    expect(harness.page?.name).toBe("supervision")
    expect(harness.command).toMatchObject({
      id: "delegation.supervision.open",
      palette: true,
      slash: { name: "delegations" },
    })
    harness.command?.run()
    expect(harness.navigated).toEqual({
      type: "plugin",
      name: "supervision",
      data: {
        entrySessionID: "ses_origin",
        returnRoute: { type: "session", sessionID: "ses_origin" },
      },
    })
  })

  test("re-entry preserves the original return route and current page state", () => {
    const route: Route = {
      type: "plugin",
      id: "opencode.delegation",
      name: "supervision",
      data: {
        entrySessionID: "ses_origin",
        returnRoute: { type: "home" },
      },
    }
    expect(openSupervision(route)).toBeUndefined()
  })

  test("captures an exact independent plugin return route", () => {
    const route: Route = {
      type: "plugin",
      id: "other.plugin",
      name: "details",
      data: { nested: { value: 1 } },
    }
    const destination = openSupervision(route)
    expect(destination).toEqual({
      type: "plugin",
      name: "supervision",
      data: { returnRoute: route },
    })
    if (destination?.type !== "plugin") throw new Error("expected plugin destination")
    expect(destination.data?.returnRoute).not.toBe(route)
  })

  test("returns to the captured route and falls home when a Session disappeared", () => {
    const route: Route = {
      type: "plugin",
      id: "opencode.delegation",
      name: "supervision",
      data: { returnRoute: { type: "session", sessionID: "ses_origin" } },
    }
    expect(returnFromSupervision(route, () => true)).toEqual({ type: "session", sessionID: "ses_origin" })
    expect(returnFromSupervision(route, () => false)).toEqual({ type: "home" })
  })
})

function setup(route: Route) {
  let page: Page | undefined
  let layer: KeymapLayer | undefined
  let navigated: unknown
  const context = {
    keymap: {
      layer: (input: () => KeymapLayer) => {
        layer = input()
      },
    },
    ui: {
      dialog: { clear() {} },
      router: {
        register: (input: Page) => {
          page = input
          return () => {}
        },
        current: () => route,
        navigate: (input: unknown) => {
          navigated = input
        },
      },
    },
  } as unknown as Context
  void TuiPlugin.setup(context)
  return {
    get page() {
      return page
    },
    get command() {
      return layer?.commands?.[0]
    },
    get navigated() {
      return navigated
    },
  }
}

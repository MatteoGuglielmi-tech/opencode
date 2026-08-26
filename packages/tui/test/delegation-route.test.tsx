import { expect, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { TextareaRenderable, type Renderable } from "@opentui/core"
import { Effect, FileSystem } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/util/global"
import path from "node:path"
import { createEventStream, createFetch, directory, json } from "./fixture/tui-client"

test("external Delegation command opens its query-backed page", async () => {
  const setup = await createTestRenderer({ width: 120, height: 30, useThread: false, kittyKeyboard: true })
  setup.renderer.start()
  const ready = Promise.withResolvers<void>()
  const events = createEventStream()
  const location = { directory, project: { id: "project", directory, canonical: directory } }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/location") return json(location)
    if (url.pathname === "/api/command") {
      return json({ location, data: [{ name: "delegate", template: "", description: "Delegate work" }] })
    }
    if (url.pathname === "/api/plugin/opencode.delegation/query/supervision") {
      if (url.searchParams.get("location[directory]") !== directory) {
        return json(
          {
            kind: "plugin_unavailable",
            pluginID: "opencode.delegation",
            message: "Plugin is unavailable: opencode.delegation",
          },
          { status: 404 },
        )
      }
      return json({
        location,
        data: {
          version: "2",
          output: {
            type: "workspace",
            generation: 1,
            health: { status: "healthy" },
            observedAt: 10,
            parents: [
              {
                session: { id: "ses_parent", title: "Parent", archived: false, updated: 10 },
                counts: {
                  total: 1,
                  queued: 0,
                  starting: 0,
                  running: 0,
                  finalizing: 0,
                  waiting: 0,
                  completed: 1,
                  failed: 0,
                  interrupted: 0,
                  cancellationRequested: 0,
                  recoveryEligible: 0,
                  actionable: 0,
                  deliveryPending: 0,
                  deliveryConflicted: 0,
                },
                lastActivityAt: 10,
                newestOperationID: "dop_retained",
                batches: [
                  {
                    id: "dlg_batch",
                    admittedAt: 1,
                    concludedAt: 10,
                    outcomes: { completed: 1, failed: 0, interrupted: 0 },
                  },
                ],
                operations: [
                  {
                    id: "dop_retained",
                    batchID: "dlg_batch",
                    parentID: "ses_parent",
                    index: 0,
                    text: "retained operation",
                    internalState: "completed",
                    presentationState: "terminal",
                    cancellationRequested: false,
                    agent: "general",
                    model: { providerID: "openai", modelID: "gpt-5" },
                    timeline: { admittedAt: 1, concludedAt: 10, permissionWaits: [] },
                    outcome: { state: "completed", reason: { code: "completed" } },
                  },
                ],
              },
            ],
          },
        },
      })
    }
    return undefined
  }, events)
  const server = Bun.serve({ port: 0, fetch: (request) => calls.fetch(request) })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        app: { name: "test", version: "test", channel: "test" },
        server: { endpoint: { url: server.url.toString() } },
        config: {
          get: async () => ({
            animations: false,
            plugins: [path.resolve(import.meta.dir, "../../delegation/src/tui.tsx")],
          }),
          update: async () => ({}),
        },
        packages: { resolve: async () => undefined },
        args: {},
        terminalHandoff: async () => ({ renderer: setup.renderer, mode: "dark", complete: ready.resolve }),
        log: () => {},
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node)), Effect.provide(FileSystem.layerNoop({}))),
    )
    await ready.promise
    await setup.waitForFrame((frame) => frame.includes("commands"))

    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitForFrame((frame) => frame.includes("Commands"))
    await setup.mockInput.typeText("Open Delegation supervision")
    setup.mockInput.pressEnter()

    expect(await setup.waitForFrame((value) => value.includes("retained operation"), { maxPasses: 100 })).toContain(
      "Delegation supervision",
    )

    setup.mockInput.pressEscape()
    await setup.waitForFrame((value) => value.includes("Ask anything"))
    await setup.mockInput.typeText("/del")
    expect(
      await setup.waitForFrame((value) => value.includes("/delegate") && value.includes("/delegations"), {
        maxPasses: 100,
      }),
    ).toContain("Delegate work")
    setup.mockInput.pressEnter()
    await setup.renderOnce()
    expect(findTextarea(setup.renderer.root)?.extmarks.getAtOffset(1)).not.toHaveLength(0)
    setup.mockInput.pressKey("u", { ctrl: true })
    await setup.mockInput.typeText("/delegations")
    setup.mockInput.pressEnter()
    await setup.waitForFrame((value) => value.includes("retained operation"), { maxPasses: 100 })

    setup.renderer.destroy()
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    await server.stop()
  }
})

function findTextarea(root: Renderable): TextareaRenderable | undefined {
  if (root instanceof TextareaRenderable) return root
  return root.getChildren().map(findTextarea).find(Boolean)
}

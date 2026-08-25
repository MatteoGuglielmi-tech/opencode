import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect, Schema } from "effect"
import { testRender } from "@opentui/solid"
import type { Context, KeymapLayer, Page, Route } from "@opencode-ai/plugin/tui/context"
import { initializeProfile } from "../src/distribution"
import type { PresentationMemory } from "../src/presentation"
import { open } from "../src/storage"
import TuiPlugin from "../src/tui"
import {
  mergeHistoryPage,
  reconcileHistoryRefresh,
  loadSupervision,
  projectWorkspace,
  supervisionView,
  WorkspaceInput,
  type WorkspaceResult,
  workspaceQuery,
} from "../src/supervision"

describe("Delegation supervision workspace", () => {
  test("discovers retained Location parents and orders actionable work first", async () => {
    await using fixture = await workspace()

    const result = await projectWorkspace({
      store: fixture.store,
      health: { status: "healthy" },
      sessions: fixture.sessions,
      input: {},
    })

    expect(result).toMatchObject({
      type: "workspace",
      health: { status: "healthy" },
      parents: [
        {
          session: { id: "ses_parent", title: "Parent" },
          counts: { total: 2, queued: 2, actionable: 2 },
        },
        {
          session: { id: "ses_nested", parentID: "ses_outer", archived: true },
          counts: { total: 1, completed: 1, actionable: 0 },
        },
      ],
      focus: { parentID: "ses_parent" },
    })
    if (result.type !== "workspace") throw new Error("expected workspace")
    expect(result.parents.map((parent) => parent.session.id)).toEqual(["ses_parent", "ses_nested"])
    expect(result.parents.some((parent) => parent.session.id === "ses_deleted")).toBe(false)
    expect(result.parents.some((parent) => parent.session.id === "ses_cross_location")).toBe(false)
  })

  test("focuses a retained child origin before canonical workspace order", async () => {
    await using fixture = await workspace()

    const result = await projectWorkspace({
      store: fixture.store,
      health: { status: "healthy" },
      sessions: fixture.sessions,
      input: { entrySessionID: "ses_child" },
    })

    expect(result).toMatchObject({
      type: "workspace",
      focus: { parentID: "ses_nested", operationID: fixture.nestedOperationID },
    })
    expect(
      await projectWorkspace({
        store: fixture.store,
        health: { status: "healthy" },
        sessions: fixture.sessions,
        input: { entrySessionID: "ses_nested" },
      }),
    ).toMatchObject({ focus: { parentID: "ses_nested", operationID: fixture.nestedOperationID } })
    expect(
      await projectWorkspace({
        store: fixture.store,
        health: { status: "healthy" },
        sessions: fixture.sessions,
        input: { entrySessionID: "ses_unknown" },
      }),
    ).toMatchObject({ focus: { parentID: "ses_parent" } })
  })

  test("orders equal groups by newest retained activity and stable parent ID", async () => {
    await using fixture = await workspace()
    const additions = [
      { id: "ses_zeta", admittedAt: 25, terminalAt: 30 },
      { id: "ses_alpha", admittedAt: 25, terminalAt: 30 },
      { id: "ses_recent", admittedAt: 35, terminalAt: 40 },
    ]
    await additions.reduce(
      (previous, addition) =>
        previous.then(async () => {
          const admitted = await fixture.store.admit(request(addition.id, [addition.id], addition.admittedAt))
          await fixture.store.acknowledgeReceipt(admitted.batch.id)
          await fixture.store.claimQueued(1, addition.admittedAt + 1)
          await fixture.store.transition(admitted.batch.operations[0].id, ["starting"], "running", {
            executionStartedAt: addition.admittedAt + 2,
          })
          await fixture.store.transition(admitted.batch.operations[0].id, ["running"], "completed", {
            executionEndedAt: addition.terminalAt - 1,
            executionEndSource: "session_event",
            terminalAt: addition.terminalAt,
            reasonCode: "completed",
          })
          fixture.sessions.push(session(addition.id, addition.id, addition.terminalAt))
        }),
      Promise.resolve(),
    )

    const result = await projectWorkspace({
      store: fixture.store,
      health: { status: "healthy" },
      sessions: fixture.sessions,
      input: {},
    })

    if (result.type !== "workspace") throw new Error("expected workspace")
    expect(result.parents.map((parent) => parent.session.id)).toEqual([
      "ses_parent",
      "ses_recent",
      "ses_alpha",
      "ses_nested",
      "ses_zeta",
    ])
  })

  test("maps query output and typed initial failures into externally testable page states", async () => {
    await using fixture = await workspace()
    const definition = workspaceQuery({
      store: fixture.store,
      health: () => ({ status: "healthy" }),
      sessions: () => Effect.succeed(fixture.sessions),
    })
    const output = await Effect.runPromise(definition.execute({}))
    const query = client(output)
    expect(await loadSupervision(query.client, undefined)).toEqual(output)
    expect(query.input).toEqual({
      pluginID: "opencode.delegation",
      query: "supervision",
      version: "2",
      input: {},
    })
    expect(supervisionView(undefined, undefined, { search: "", actionableOnly: false })).toEqual({ type: "loading" })
    const empty: WorkspaceResult = {
      type: "workspace",
      generation: 0,
      health: { status: "healthy" },
      observedAt: 1,
      parents: [],
    }
    expect(supervisionView(empty, undefined, { search: "", actionableOnly: false })).toEqual({
      type: "workspace-empty",
    })
    expect(
      supervisionView(
        { type: "workspace", generation: 0, health: { status: "healthy" }, observedAt: 1, parents: [parentSummary] },
        undefined,
        { search: "missing", actionableOnly: false },
      ),
    ).toEqual({ type: "filtered-empty" })
    expect(supervisionView(undefined, { code: "unsupported_version" }, { search: "", actionableOnly: false })).toEqual({
      type: "unsupported-version",
    })
    expect(
      supervisionView(
        undefined,
        { code: "plugin_unavailable", detail: "missing" },
        { search: "", actionableOnly: false },
      ),
    ).toEqual({ type: "failure", code: "plugin_unavailable", detail: "missing" })
  })

  test("filters tasks and identifiers without changing canonical operation order", () => {
    const result: WorkspaceResult = {
      type: "workspace",
      generation: 1,
      health: { status: "healthy" },
      observedAt: 1,
      parents: [
        {
          ...parentSummary,
          operations: [
            operationSummary("dop_first", "compile docs", "completed"),
            operationSummary("dop_second", "deploy api", "queued"),
          ],
        },
      ],
    }

    expect(supervisionView(result, undefined, { search: "dop_second", actionableOnly: false })).toMatchObject({
      type: "ready",
      parents: [{ operations: [{ id: "dop_second" }] }],
    })
    expect(supervisionView(result, undefined, { search: "", actionableOnly: true })).toMatchObject({
      type: "ready",
      parents: [{ operations: [{ id: "dop_second" }] }],
    })
    expect(
      (
        supervisionView(result, undefined, { search: "", actionableOnly: false }) as { parents: typeof result.parents }
      ).parents[0].operations.map((operation) => operation.id),
    ).toEqual(["dop_first", "dop_second"])
  })

  test("appends only a current older page without duplicates or anchor movement", () => {
    const current: Extract<WorkspaceResult, { type: "workspace" }> = {
      type: "workspace",
      generation: 7,
      health: { status: "healthy" },
      observedAt: 1,
      focus: { parentID: "ses_parent", operationID: "dop_first" },
      parents: [
        {
          ...parentSummary,
          nextCursor: "cursor-1",
          operations: [operationSummary("dop_first", "first", "queued")],
        },
      ],
    }
    const page = {
      type: "history-page" as const,
      generation: 7,
      observedAt: 2,
      parentID: "ses_parent",
      cursor: "cursor-1",
      operations: [
        operationSummary("dop_first", "first changed", "queued"),
        operationSummary("dop_older", "older", "completed"),
      ],
      batches: [],
    }

    const merged = mergeHistoryPage(current, page)
    expect(merged.focus).toEqual(current.focus)
    expect(merged.parents[0].operations.map((operation) => operation.id)).toEqual(["dop_first", "dop_older"])
    expect(merged.parents[0].operations[0].text).toBe("first changed")
    expect(mergeHistoryPage(current, { ...page, generation: 6 })).toBe(current)
    expect(mergeHistoryPage(current, { ...page, cursor: "stale" })).toBe(current)
  })

  test("pages parents independently and refreshes the expanded loaded depth", async () => {
    await using fixture = await workspace()
    const first = await projectWorkspace({
      store: fixture.store,
      health: { status: "healthy" },
      sessions: fixture.sessions,
      input: {
        generation: 4,
        history: [
          { parentID: "ses_parent", limit: 1 },
          { parentID: "ses_nested", limit: 1 },
        ],
      },
      observedAt: 50,
    })
    if (first.type !== "workspace") throw new Error("expected workspace")
    const parent = first.parents.find((candidate) => candidate.session.id === "ses_parent")
    const nested = first.parents.find((candidate) => candidate.session.id === "ses_nested")
    expect(parent?.operations).toHaveLength(1)
    expect(nested?.operations).toHaveLength(1)
    expect(parent?.nextCursor).toBeString()

    const page = await projectWorkspace({
      store: fixture.store,
      health: { status: "healthy" },
      sessions: fixture.sessions,
      input: {
        generation: 4,
        page: { parentID: "ses_parent", cursor: parent!.nextCursor!, limit: 1 },
      },
      observedAt: 51,
    })
    if (page.type !== "history-page") throw new Error("expected history page")
    const expanded = mergeHistoryPage(first, page)
    expect(expanded.parents.find((candidate) => candidate.session.id === "ses_parent")?.operations).toHaveLength(2)
    expect(expanded.parents.find((candidate) => candidate.session.id === "ses_nested")?.operations).toHaveLength(1)

    await fixture.store.transition(parent!.operations[0].id, ["queued"], "interrupted", {
      terminalAt: 52,
      reasonCode: "cancelled_before_start",
    })
    await fixture.store.admit(request("ses_parent", ["concurrent newer"], 52))
    const refreshed = await projectWorkspace({
      store: fixture.store,
      health: { status: "healthy" },
      sessions: fixture.sessions,
      input: {
        generation: 5,
        history: expanded.parents.map((candidate) => ({
          parentID: candidate.session.id,
          limit: candidate.operations.length,
          ...(candidate.session.id === "ses_parent" ? { operationID: parent!.operations[0].id } : {}),
        })),
      },
      observedAt: 53,
    })
    if (refreshed.type !== "workspace") throw new Error("expected refreshed workspace")
    expect(refreshed.parents.find((candidate) => candidate.session.id === "ses_parent")?.operations).toHaveLength(2)
    expect(
      refreshed.parents
        .find((candidate) => candidate.session.id === "ses_parent")
        ?.operations.find((operation) => operation.id === parent!.operations[0].id)?.presentationState,
    ).toBe("terminal")
  })

  test("keeps valid inspection focus and falls back to the nearest surviving operation", () => {
    const previous: Extract<WorkspaceResult, { type: "workspace" }> = {
      type: "workspace",
      generation: 1,
      health: { status: "healthy" },
      observedAt: 1,
      focus: { parentID: "ses_parent", operationID: "dop_second" },
      parents: [
        {
          ...parentSummary,
          operations: [
            operationSummary("dop_first", "first", "queued"),
            operationSummary("dop_second", "second", "queued"),
            operationSummary("dop_third", "third", "queued"),
          ],
        },
      ],
    }
    const next = {
      ...previous,
      generation: 2,
      focus: { parentID: "ses_parent", operationID: "dop_first" },
      parents: [
        {
          ...parentSummary,
          operations: [
            operationSummary("dop_first", "first", "queued"),
            operationSummary("dop_third", "third", "queued"),
          ],
        },
      ],
    }

    expect(reconcileHistoryRefresh(previous, next).focus).toEqual({
      parentID: "ses_parent",
      operationID: "dop_third",
    })
    expect(
      reconcileHistoryRefresh({ ...previous, focus: { parentID: "ses_parent", operationID: "dop_first" } }, next).focus,
    ).toEqual({ parentID: "ses_parent", operationID: "dop_first" })
  })

  test("renders the registered page from the package query without a Session command or coordinator store", async () => {
    await using fixture = await workspace()
    const definition = workspaceQuery({
      store: fixture.store,
      health: () => ({ status: "healthy" }),
      sessions: () => Effect.succeed(fixture.sessions),
    })
    let page: Page | undefined
    let route: Route = { type: "home" }
    const calls: unknown[] = []
    const memory: PresentationMemory = { locations: {} }
    const layers: KeymapLayer[] = []
    const context = {
      location: { directory: "/repo" },
      renderer: { terminalWidth: 80, on() {}, off() {} },
      storage: { memory: () => [memory, (update: (draft: typeof memory) => void) => update(memory)] },
      client: {
        plugin: {
          query: {
            invoke: async (input: { input: unknown }) => {
              calls.push(input)
              return {
                location: {
                  directory: "/repo",
                  project: { id: "project", directory: "/repo", canonical: "/repo" },
                },
                data: {
                  version: "2",
                  output: await Effect.runPromise(
                    definition.execute(Schema.decodeUnknownSync(WorkspaceInput)(input.input)),
                  ),
                },
              }
            },
          },
        },
      },
      data: {
        listen: () => () => {},
        session: {
          get: () => undefined,
          permission: { sync: async () => {}, list: () => [] },
        },
        location: { default: () => ({ directory: "/repo" }) },
      },
      theme: {
        text: {
          default: "#ffffff",
          subdued: "#888888",
          feedback: { warning: { default: "#ffff00" }, error: { default: "#ff0000" } },
        },
      },
      keymap: { layer: (input: () => KeymapLayer) => layers.push(input()) },
      ui: {
        dialog: { clear() {}, prompt: async () => "nested" },
        toast: { show() {} },
        tabs: { open: () => false },
        router: {
          register: (input: Page) => {
            page = input
            return () => {}
          },
          current: () => route,
          exists: () => true,
          navigate: (input: Route) => {
            route = input
          },
        },
      },
    } as unknown as Context
    void TuiPlugin.setup(context)
    route = { type: "plugin", id: "opencode.delegation", name: "supervision", data: { returnRoute: route } }
    if (!page) throw new Error("expected registered supervision page")
    const render = page.render
    const app = await testRender(() => render({ data: route.type === "plugin" ? route.data : undefined }), {
      width: 80,
      height: 20,
    })
    try {
      const medium = await app.waitForFrame(
        (frame) => frame.includes("Parent: Parent") && frame.includes("2 actionable / 2 retained"),
      )
      expect(medium).toContain("Timeline")
      expect(medium).toContain("Inspector")
      expect(medium).not.toContain("Parents\n")
      expect(calls).toEqual([
        {
          pluginID: "opencode.delegation",
          query: "supervision",
          version: "2",
          input: {},
        },
      ])
      const commands = new Map(layers.flatMap((layer) => layer.commands ?? []).map((command) => [command.id, command]))
      await app.mockMouse.click(3, 7)
      await app.waitForFrame((frame) => frame.includes("index 0"))
      await app.mockMouse.click(3, 10)
      await app.waitForFrame((frame) => frame.includes("index 1"))
      commands.get("delegation.supervision.navigation.previous")?.run()
      await app.waitForFrame((frame) => frame.includes("index 0"))
      commands.get("delegation.supervision.navigation.next")?.run()
      await app.waitForFrame((frame) => frame.includes("index 1"))
      commands.get("delegation.supervision.scroll.page-down")?.run()
      commands.get("delegation.supervision.scroll.page-up")?.run()
      const search = layers
        .flatMap((layer) => layer.commands ?? [])
        .find((command) => command.id === "delegation.supervision.filter.search")
      await search?.run()
      await app.waitForFrame((frame) => frame.includes("Search: nested"))

      expect([...commands.keys()]).toEqual(
        expect.arrayContaining([
          "delegation.supervision.refresh",
          "delegation.supervision.permission.reply",
          "delegation.supervision.operation.cancel",
          "delegation.supervision.batch.cancel",
          "delegation.supervision.operation.steer",
          "delegation.supervision.operation.retry",
          "delegation.supervision.recovery.dismiss",
          "delegation.supervision.retry.view",
          "delegation.supervision.filter.search",
          "delegation.supervision.history.older",
          "delegation.supervision.filter.actionable",
          "delegation.supervision.scroll.page-up",
          "delegation.supervision.scroll.page-down",
        ]),
      )
      commands.get("delegation.supervision.focus.next")?.run()
      await app.waitForFrame((frame) => frame.includes("┃"))
      commands.get("delegation.supervision.navigation.right")?.run()
      expect(memory.locations['["/repo",null]']?.paneSizes.medium.inspector).toBe(34)

      app.resize(79, 24)
      const narrow = await app.waitForFrame((frame) => frame.includes("Parents") && !frame.includes("Inspector"))
      expect(narrow).not.toContain("│")
      commands.get("delegation.supervision.child.open")?.run()
      await app.waitForFrame((frame) => frame.includes("Timeline") && !frame.includes("Inspector"))
      commands.get("delegation.supervision.child.open")?.run()
      await app.waitForFrame((frame) => frame.includes("Inspector") && frame.includes("Operation"))
      commands.get("delegation.supervision.back")?.run()
      await app.waitForFrame((frame) => frame.includes("Timeline") && !frame.includes("Inspector"))

      for (const [width, height, expected] of [
        [120, 30, ["Parents", "Timeline", "Inspector"]],
        [119, 30, ["Parent:", "Timeline", "Inspector"]],
        [140, 40, ["Parents", "Timeline", "Inspector"]],
        [100, 30, ["Parent:", "Timeline", "Inspector"]],
      ] as const) {
        app.resize(width, height)
        const frame = await app.waitForFrame((value) => expected.every((label) => value.includes(label)))
        expect(frame.split("\n")).toHaveLength(height + 1)
      }
      const separatorX = app
        .captureCharFrame()
        .split("\n")
        .find((line) => line.includes("Timeline") && line.includes("│"))!
        .indexOf("│")
      await app.mockMouse.click(separatorX, 4)
      await app.waitForFrame((frame) => frame.includes("┃"))
      await app.mockMouse.drag(separatorX, 4, separatorX - 5, 4)
      await app.renderOnce()
      expect(memory.locations['["/repo",null]']?.paneSizes.medium.inspector).toBe(39)

      app.resize(140, 40)
      const wideFrame = await app.waitForFrame(
        (frame) => frame.includes("Parents") && frame.includes("Timeline") && frame.includes("Inspector"),
      )
      const wideRows = wideFrame.split("\n")
      const wideY = wideRows.findIndex((line) => line.includes("Parents") && line.includes("Timeline"))
      const parentsSeparatorX = wideRows[wideY].indexOf("│")
      await app.mockMouse.drag(parentsSeparatorX, wideY, parentsSeparatorX + 3, wideY)
      await app.renderOnce()
      expect(memory.locations['["/repo",null]']?.paneSizes.wide.parents).toBe(27)
      expect(memory.locations['["/repo",null]']?.paneSizes.medium.inspector).toBe(39)

      app.resize(70, 24)
      await app.waitForFrame((frame) => frame.includes("Timeline") && !frame.includes("Inspector"))
      app.resize(50, 16)
      const minimum = await app.waitForFrame((frame) => frame.includes("Timeline") && frame.includes("nested [terminal]"))
      expect(minimum.split("\n")).toHaveLength(17)
    } finally {
      app.renderer.destroy()
    }

    void TuiPlugin.setup(context)
    if (!page) throw new Error("expected reloaded supervision page")
    const reloaded = page
    const restored = await testRender(
      () => reloaded.render({ data: route.type === "plugin" ? route.data : undefined }),
      {
        width: 80,
        height: 20,
      },
    )
    try {
      await restored.waitForFrame((frame) => frame.includes("Search: nested"))
    } finally {
      restored.renderer.destroy()
    }
  })
})

async function workspace() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-delegation-workspace-"))
  const options = await initializeProfile({ profile: directory })
  const store = await open(options)
  await store.admit(request("ses_parent", ["first", "second"], 10))
  const nested = await store.admit(request("ses_nested", ["nested"], 20))
  const nestedOperationID = nested.batch.operations[0].id
  await store.acknowledgeReceipt(nested.batch.id)
  await store.claimQueued(1, 21)
  await store.transition(nestedOperationID, ["starting"], "running", {
    childID: "ses_child",
    executionStartedAt: 22,
  })
  await store.transition(nestedOperationID, ["running"], "completed", {
    executionEndedAt: 23,
    executionEndSource: "session_event",
    terminalAt: 30,
    reasonCode: "completed",
  })
  await store.admit(request("ses_deleted", ["deleted"], 40))
  await store.admit(request("ses_cross_location", ["cross"], 50))
  return {
    store,
    nestedOperationID,
    sessions: [
      session("ses_parent", "Parent", 11),
      session("ses_nested", "Nested", 31, { parentID: "ses_outer", archived: true }),
    ],
    async [Symbol.asyncDispose]() {
      await store.close()
      await rm(directory, { recursive: true, force: true })
    },
  }
}

function request(parentID: string, operations: string[], admittedAt: number) {
  return {
    parentID,
    canonical: `${parentID}-${admittedAt}`,
    agent: "general",
    model: { providerID: "openai", modelID: "gpt-5" },
    files: [],
    agents: [],
    skills: [],
    operations,
    admittedAt,
  }
}

function session(id: string, title: string, updated: number, options: { parentID?: string; archived?: boolean } = {}) {
  return {
    id,
    title,
    ...(options.parentID ? { parentID: options.parentID } : {}),
    archived: options.archived ?? false,
    updated,
  }
}

function client(output: WorkspaceResult) {
  let input: unknown
  return {
    get input() {
      return input
    },
    client: {
      plugin: {
        query: {
          invoke: async (value: unknown) => {
            input = value
            return {
              location: {
                directory: "/repo",
                project: { id: "project", directory: "/repo", canonical: "/repo" },
              },
              data: { version: "2", output },
            }
          },
        },
      },
    },
  }
}

const parentSummary = {
  session: { id: "ses_parent", title: "Parent", archived: false, updated: 1 },
  counts: {
    total: 1,
    queued: 1,
    starting: 0,
    running: 0,
    finalizing: 0,
    waiting: 0,
    completed: 0,
    failed: 0,
    interrupted: 0,
    cancellationRequested: 0,
    recoveryEligible: 0,
    actionable: 1,
    deliveryPending: 0,
    deliveryConflicted: 0,
  },
  lastActivityAt: 1,
  newestActionableOperationID: "dop_one",
  newestOperationID: "dop_one",
  batches: [],
  operations: [],
}

function operationSummary(id: string, text: string, state: "queued" | "completed") {
  return {
    id,
    batchID: "dlg_batch",
    parentID: "ses_parent",
    index: id === "dop_first" ? 0 : 1,
    text,
    internalState: state,
    presentationState: state === "queued" ? ("queued" as const) : ("terminal" as const),
    cancellationRequested: false,
    agent: "general",
    model: { providerID: "openai", modelID: "gpt-5" },
    timeline: { admittedAt: 1, permissionWaits: [] },
    ...(state === "completed"
      ? { outcome: { state: "completed" as const, reason: { code: "completed" as const } } }
      : {}),
  }
}

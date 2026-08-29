import { expect, test } from "bun:test"
import {
  createHerdrReporter,
  deriveHerdrSnapshot,
  runHerdrCommand,
  startHerdrReporting,
  type HerdrProjection,
} from "../src/herdr"
import { createRoot, createSignal } from "solid-js"

const env = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p2",
  HERDR_SOCKET_PATH: "/tmp/herdr.sock",
  HERDR_BIN_PATH: "/usr/local/bin/herdr",
}

test.each([
  [{ ...env, HERDR_ENV: "0" }],
  [{ ...env, HERDR_PANE_ID: "" }],
  [{ ...env, HERDR_SOCKET_PATH: "" }],
  [{ ...env, HERDR_BIN_PATH: "" }],
  [{ ...env, HERDR_PANE_ID: "w1:p2\ninvalid" }],
])("reporting stays disabled for incomplete or malformed Herdr environments", (input) => {
  expect(createHerdrReporter(input)).toBeUndefined()
})

test("reports Session identity before authoritative lifecycle state through the official source", async () => {
  const commands: string[][] = []
  const reporter = createHerdrReporter(env, {
    now: () => 1_000,
    run: async (command) => void commands.push(command),
  })!

  await reporter.update({ state: "working", sessionID: "ses_root" })

  expect(commands).toEqual([
    [
      "/usr/local/bin/herdr",
      "pane",
      "report-agent-session",
      "w1:p2",
      "--source",
      "herdr:opencode",
      "--agent",
      "opencode",
      "--seq",
      "1000001",
      "--agent-session-id",
      "ses_root",
      "--session-start-source",
      "select",
    ],
    [
      "/usr/local/bin/herdr",
      "pane",
      "report-agent",
      "w1:p2",
      "--source",
      "herdr:opencode",
      "--agent",
      "opencode",
      "--state",
      "working",
      "--seq",
      "1000002",
      "--agent-session-id",
      "ses_root",
    ],
  ])
})

test("deduplicates reports and clears Session identity when the pane leaves a Session", async () => {
  const commands: string[][] = []
  const reporter = createHerdrReporter(env, {
    now: () => 2_000,
    run: async (command) => void commands.push(command),
  })!

  await reporter.update({ state: "idle", sessionID: "ses_root" })
  await reporter.update({ state: "idle", sessionID: "ses_root" })
  await reporter.update({ state: "idle" })

  expect(commands).toHaveLength(3)
  expect(commands[2]).toEqual([
    "/usr/local/bin/herdr",
    "pane",
    "release-agent",
    "w1:p2",
    "--source",
    "herdr:opencode",
    "--agent",
    "opencode",
    "--seq",
    "2000003",
  ])
})

test("coalesces queued transitions while preserving command order", async () => {
  const commands: string[][] = []
  const first = Promise.withResolvers<void>()
  const reporter = createHerdrReporter(env, {
    now: () => 3_000,
    run: async (command) => {
      commands.push(command)
      if (commands.length === 1) await first.promise
    },
  })!

  const initial = reporter.update({ state: "idle", sessionID: "ses_root" })
  const skipped = reporter.update({ state: "working", sessionID: "ses_root" })
  const latest = reporter.update({ state: "blocked", sessionID: "ses_root" })
  first.resolve()
  await Promise.all([initial, skipped, latest])

  const states = commands.filter((command) => command[2] === "report-agent")
  expect(states.map((command) => command[command.indexOf("--state") + 1])).toEqual(["idle", "blocked"])
  expect(Number(states[1]![states[1]!.indexOf("--seq") + 1])).toBeGreaterThan(
    Number(states[0]![states[0]!.indexOf("--seq") + 1]),
  )
})

test("reasserts the current snapshot after Herdr process detection settles", async () => {
  const commands: string[][] = []
  const reporter = createHerdrReporter(env, {
    run: async (command) => void commands.push(command),
  })!
  const snapshot = { state: "idle", sessionID: "ses_root" } as const

  await reporter.update(snapshot)
  await reporter.refresh(snapshot)

  expect(commands.filter((command) => command[2] === "report-agent-session")).toHaveLength(2)
  expect(commands.filter((command) => command[2] === "report-agent")).toHaveLength(2)
})

test("command failures do not stop later reports or cleanup", async () => {
  const commands: string[][] = []
  let failed = false
  const reporter = createHerdrReporter(env, {
    run: async (command) => {
      commands.push(command)
      if (!failed) {
        failed = true
        throw new Error("socket unavailable")
      }
    },
  })!

  await reporter.update({ state: "working", sessionID: "ses_root" })
  await reporter.update({ state: "idle", sessionID: "ses_root" })
  await reporter.release()

  expect(commands.at(-1)?.slice(1, 4)).toEqual(["pane", "release-agent", "w1:p2"])
})

test("reporters remain isolated to their inherited panes", async () => {
  const commands: string[][] = []
  const options = { run: async (command: string[]) => void commands.push(command) }
  const left = createHerdrReporter({ ...env, HERDR_PANE_ID: "w1:p1" }, options)!
  const right = createHerdrReporter({ ...env, HERDR_PANE_ID: "w1:p2" }, options)!

  await Promise.all([
    left.update({ state: "working", sessionID: "ses_left" }),
    right.update({ state: "blocked", sessionID: "ses_right" }),
  ])

  expect(
    commands
      .filter((command) => command[2] === "report-agent-session")
      .map((command) => [command[3], command[command.indexOf("--agent-session-id") + 1]]),
  ).toEqual([
    ["w1:p1", "ses_left"],
    ["w1:p2", "ses_right"],
  ])
})

function projection(input: Partial<HerdrProjection> = {}): HerdrProjection {
  return {
    selectedSessionID: "ses_root",
    root: () => "ses_root",
    family: () => ["ses_root", "ses_child"],
    status: () => "idle",
    pending: () => 0,
    permissions: () => 0,
    forms: () => 0,
    ...input,
  }
}

test("projects only the selected root Session family with blocked precedence", () => {
  expect(
    deriveHerdrSnapshot(
      projection({
        status: (sessionID) => (sessionID === "ses_child" ? "running" : "idle"),
        permissions: (sessionID) => (sessionID === "ses_child" ? 1 : 0),
      }),
    ),
  ).toEqual({ state: "blocked", sessionID: "ses_root" })

  expect(
    deriveHerdrSnapshot(
      projection({
        family: () => ["ses_root", "ses_child"],
        status: (sessionID) => (sessionID === "ses_other" ? "running" : "idle"),
        permissions: (sessionID) => (sessionID === "ses_other" ? 1 : 0),
      }),
    ),
  ).toEqual({ state: "idle", sessionID: "ses_root" })
})

test("projects child execution and admitted input onto one root agent", () => {
  expect(
    deriveHerdrSnapshot(projection({ status: (sessionID) => (sessionID === "ses_child" ? "running" : "idle") })),
  ).toEqual({ state: "working", sessionID: "ses_root" })
  expect(
    deriveHerdrSnapshot(projection({ pending: (sessionID) => (sessionID === "ses_child" ? 1 : 0) })),
  ).toEqual({ state: "working", sessionID: "ses_root" })
})

test("resolves a selected child to its active root Session and idles without a Session", () => {
  expect(
    deriveHerdrSnapshot(
      projection({
        selectedSessionID: "ses_child",
        root: () => "ses_root",
      }),
    ),
  ).toEqual({ state: "idle", sessionID: "ses_root" })
  expect(deriveHerdrSnapshot(projection({ selectedSessionID: undefined }))).toEqual({ state: "idle" })
})

test("Herdr commands are killed at their deadline", async () => {
  if (process.platform === "win32") return
  const started = Date.now()
  await runHerdrCommand(["/bin/sh", "-c", "sleep 2"], 20)
  expect(Date.now() - started).toBeLessThan(1_000)
})

test("reactive TUI ownership releases once on Solid disposal before lifecycle cleanup", async () => {
  const commands: string[][] = []
  const reporter = createHerdrReporter(env, {
    run: async (command) => void commands.push(command),
  })!
  const [selectedSessionID, selectSession] = createSignal<string>()
  let cleanup = async () => {}

  const dispose = createRoot((dispose) => {
    startHerdrReporting({
      reporter,
      projection: () => projection({ selectedSessionID: selectedSessionID() }),
      lifecycle: {
        add(finalizer) {
          cleanup = finalizer
          return () => {}
        },
      },
    })
    return dispose
  })

  await Bun.sleep(0)
  selectSession("ses_child")
  await Bun.sleep(0)
  dispose()
  await Bun.sleep(0)
  expect(commands.filter((command) => command[2] === "release-agent")).toHaveLength(1)
  await cleanup()

  expect(commands[0]?.slice(-4)).toEqual(["--agent-session-id", "ses_root", "--session-start-source", "select"])
  expect(commands[1]?.slice(-2)).toEqual(["--agent-session-id", "ses_root"])
  expect(commands.at(-1)?.slice(1, 4)).toEqual(["pane", "release-agent", "w1:p2"])
  expect(commands.filter((command) => command[2] === "release-agent")).toHaveLength(1)
})

test("authoritative activity replaces a stale blocked projection immediately", async () => {
  const commands: string[][] = []
  const reporter = createHerdrReporter(env, {
    run: async (command) => void commands.push(command),
  })!
  let activity = (_sessionID: string) => {}

  const dispose = createRoot((dispose) => {
    startHerdrReporting({
      reporter,
      projection: () => projection({ permissions: () => 1 }),
      lifecycle: { add: () => () => {} },
      activity: (handler) => {
        activity = handler
        return () => {}
      },
    })
    return dispose
  })

  await Bun.sleep(0)
  activity("ses_child")
  await Bun.sleep(0)
  dispose()

  expect(
    commands
      .filter((command) => command[2] === "report-agent")
      .map((command) => command[command.indexOf("--state") + 1]),
  ).toEqual(["blocked", "working"])
})

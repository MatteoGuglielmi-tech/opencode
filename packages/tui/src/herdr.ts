import { createEffect, onCleanup } from "solid-js"

export type HerdrState = "idle" | "working" | "blocked"

export type HerdrSnapshot = {
  state: HerdrState
  sessionID?: string
}

export type HerdrProjection = {
  selectedSessionID?: string
  root(sessionID: string): string
  family(sessionID: string): string[]
  status(sessionID: string): "idle" | "running"
  pending(sessionID: string): number
  permissions(sessionID: string): number
  forms(sessionID: string): number
}

type Environment = Record<string, string | undefined>

type Options = {
  run?: (command: string[]) => Promise<void>
  now?: () => number
}

const SOURCE = "herdr:opencode"
const AGENT = "opencode"

export function deriveHerdrSnapshot(projection: HerdrProjection): HerdrSnapshot {
  if (!projection.selectedSessionID) return { state: "idle" }
  const sessionID = projection.root(projection.selectedSessionID)
  const family = projection.family(sessionID)
  const sessions = family.includes(sessionID) ? family : [sessionID, ...family]
  if (sessions.some((id) => projection.permissions(id) > 0 || projection.forms(id) > 0)) {
    return { state: "blocked", sessionID }
  }
  if (sessions.some((id) => projection.status(id) === "running" || projection.pending(id) > 0)) {
    return { state: "working", sessionID }
  }
  return { state: "idle", sessionID }
}

export function createHerdrReporter(environment: Environment = process.env, options: Options = {}) {
  const paneID = environmentValue(environment.HERDR_PANE_ID)
  const socketPath = environmentValue(environment.HERDR_SOCKET_PATH)
  const binPath = environmentValue(environment.HERDR_BIN_PATH)
  if (environment.HERDR_ENV !== "1" || !paneID || !socketPath || !binPath) return

  const run = options.run ?? runHerdrCommand
  let sequence = (options.now ?? Date.now)() * 1_000
  let pending: HerdrSnapshot | undefined
  let reported: HerdrSnapshot | undefined
  let draining: Promise<void> | undefined
  let released = false

  const nextSequence = () => String(++sequence)
  const base = () => [binPath, "pane"]
  const identity = (source: string) => ["--source", source, "--agent", AGENT]
  const execute = (command: string[]) => run(command).catch(() => undefined)

  const drain = async () => {
    while (pending) {
      const snapshot = pending
      pending = undefined
      if (sameSnapshot(snapshot, reported)) continue

      if (!snapshot.sessionID) {
        if (!reported?.sessionID) {
          reported = snapshot
          continue
        }
        await execute([
          ...base(),
          "release-agent",
          paneID,
          ...identity(SOURCE),
          "--seq",
          nextSequence(),
        ])
        reported = snapshot
        continue
      }
      if (reported?.sessionID !== snapshot.sessionID) {
        await execute([
          ...base(),
          "report-agent-session",
          paneID,
          ...identity(SOURCE),
          "--seq",
          nextSequence(),
          "--agent-session-id",
          snapshot.sessionID,
          "--session-start-source",
          "select",
        ])
      }
      await execute([
        ...base(),
        "report-agent",
        paneID,
        ...identity(SOURCE),
        "--state",
        snapshot.state,
        "--seq",
        nextSequence(),
        "--agent-session-id",
        snapshot.sessionID,
      ])
      reported = snapshot
    }
  }

  const schedule = (snapshot: HerdrSnapshot) => {
    pending = snapshot
    if (!draining) draining = drain().finally(() => (draining = undefined))
    return draining
  }

  return {
    update(snapshot: HerdrSnapshot) {
      if (released || sameSnapshot(snapshot, pending ?? reported)) return draining ?? Promise.resolve()
      return schedule(snapshot)
    },
    refresh(snapshot: HerdrSnapshot) {
      if (released) return draining ?? Promise.resolve()
      reported = undefined
      return schedule(snapshot)
    },
    async release() {
      if (released) return
      released = true
      pending = undefined
      await draining
      if (!reported?.sessionID) return
      await execute([
        ...base(),
        "release-agent",
        paneID,
        ...identity(SOURCE),
        "--seq",
        nextSequence(),
      ])
    },
  }
}

export function startHerdrReporting(input: {
  reporter: NonNullable<ReturnType<typeof createHerdrReporter>> | undefined
  projection: () => HerdrProjection
  lifecycle: { add(finalizer: () => Promise<void>): () => void }
}) {
  const reporter = input.reporter
  if (!reporter) return
  let snapshot: HerdrSnapshot | undefined
  createEffect(() => {
    snapshot = deriveHerdrSnapshot(input.projection())
    void reporter.update(snapshot)
  })
  const retry = setTimeout(() => {
    if (snapshot) void reporter.refresh(snapshot)
  }, 1_000)
  let remove = () => {}
  let cleaning: Promise<void> | undefined
  const cleanup = () => {
    clearTimeout(retry)
    remove()
    cleaning ??= reporter.release()
    return cleaning
  }
  remove = input.lifecycle.add(cleanup)
  onCleanup(() => void cleanup())
}

export async function runHerdrCommand(command: string[], timeout = 250) {
  const child = Bun.spawn(command, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    child.exited,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        child.kill()
        resolve()
      }, timeout)
    }),
  ])
  if (timer) clearTimeout(timer)
}

function environmentValue(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed || [...trimmed].some((character) => character.charCodeAt(0) < 32)) return
  return trimmed
}

function sameSnapshot(left: HerdrSnapshot | undefined, right: HerdrSnapshot | undefined) {
  return left?.state === right?.state && left?.sessionID === right?.sessionID
}

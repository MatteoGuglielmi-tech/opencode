import path from "node:path"
import { expect } from "bun:test"
import { Effect, Schedule } from "effect"
import { HttpServer } from "effect/unstable/http"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerFetch } from "../src/fetch"
import { ServerProcess } from "../src/process"

it.live("traces executable commands through a real service", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir("opencode-command-tracer-")),
    (tmp) =>
      Effect.gen(function* () {
        const config = path.join(tmp.path, "opencode.json")
        yield* Effect.promise(() => Bun.write(config, pluginConfig()))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* startServer(tmp.path, true)
            const base = HttpServer.formatAddress(server.address)
            const sessionID = yield* createSession(base, tmp.path)
            const plugins = record(
              yield* request(base, "/api/plugin?location%5Bdirectory%5D=" + encodeURIComponent(tmp.path), {
                method: "GET",
              }),
            )
            expect(plugins["data"]).toContainEqual({ id: "executable-command-tracer" })
            const invocation = {
              id: "msg_trace_synthetic",
              command: "trace-synthetic",
              arguments: "--exact value",
              agent: "missing-agent",
              model: { providerID: "missing-provider", id: "missing-model", variant: "high" },
              files: [{ uri: "file:///tmp/example.ts", name: "example.ts" }],
              agents: [{ name: "reviewer" }],
              skills: [{ id: "testing" }],
              delivery: "queue",
              resume: true,
            }
            const synthetic = record(
              record(
                yield* request(base, `/api/session/${sessionID}/command`, {
                  method: "POST",
                  body: JSON.stringify(invocation),
                }),
              )["data"],
            )
            expect(synthetic["type"]).toBe("synthetic")
            expect(JSON.parse(String(record(synthetic["payload"])["text"]))).toEqual({
              sessionID,
              ...invocation,
            })

            const user = record(
              record(
                yield* request(base, `/api/session/${sessionID}/command`, {
                  method: "POST",
                  body: JSON.stringify({ ...invocation, id: "msg_trace_user", command: "trace-user" }),
                }),
              )["data"],
            )
            expect(user["type"]).toBe("user")

            yield* Effect.promise(() => Bun.write(config, JSON.stringify({ plugins: ["-*"] })))
            yield* pluginList(base, tmp.path).pipe(
              Effect.filterOrFail(
                (items) => items.every((item) => record(item)["id"] !== "executable-command-tracer"),
                () => new Error("Executable command plugin was not disabled"),
              ),
              Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }),
            )
            const removed = yield* Effect.promise(() =>
              fetch(`${base}/api/session/${sessionID}/command`, {
                method: "POST",
                headers: { authorization: authorization(), "content-type": "application/json" },
                body: JSON.stringify({ command: "trace-synthetic", resume: false }),
              }),
            ).pipe(
              Effect.filterOrFail(
                (response) => response.status === 404,
                () => new Error("Executable command registration was not removed"),
              ),
              Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }),
            )
            expect(removed.status).toBe(404)
          }),
        )
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("cancels executable commands with their request", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir("opencode-command-cancel-")),
    (tmp) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handler = yield* ServerFetch.make({
            password: "secret",
            app: { version: "test-version" },
            database: { path: ":memory:" },
            config: { directory: tmp.path, content: pluginConfig() },
            fs: { filewatcher: false },
          })
          const sessionID = yield* createSession("http://opencode.local", tmp.path, handler)
          const cancelled = path.join(tmp.path, "cancelled")
          const controller = new AbortController()
          const pending = handler(
            new Request(`http://opencode.local/api/session/${sessionID}/command`, {
              method: "POST",
              headers: { authorization: authorization(), "content-type": "application/json" },
              body: JSON.stringify({ command: "trace-cancel", arguments: cancelled, resume: false }),
              signal: controller.signal,
            }),
          ).catch(() => undefined)
          yield* exists(`${cancelled}.started`)
          controller.abort()
          yield* Effect.promise(() => pending)
          expect(yield* exists(cancelled)).toBe(true)
        }),
      ),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

it.live("disposes executable commands when the server shuts down", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir("opencode-command-shutdown-")),
    (tmp) =>
      Effect.gen(function* () {
        const marker = path.join(tmp.path, "disposed")
        yield* Effect.promise(() => Bun.write(path.join(tmp.path, "opencode.json"), pluginConfig()))
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* startServer(tmp.path, false)
            const base = HttpServer.formatAddress(server.address)
            const sessionID = yield* createSession(base, tmp.path)
            yield* request(base, `/api/session/${sessionID}/command`, {
              method: "POST",
              body: JSON.stringify({ command: "trace-shutdown", arguments: marker, resume: false }),
            })
          }),
        )

        expect(yield* exists(marker)).toBe(true)
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

type Handler = (request: Request) => Promise<Response>

const startServer = (directory: string, filewatcher: boolean) =>
  ServerProcess.start<never, never>({
    hostname: "127.0.0.1",
    port: 0,
    password: "secret",
    app: { version: "test-version" },
    database: { path: ":memory:" },
    config: { directory },
    fs: { filewatcher },
  })

const request = (base: string, pathname: string, init: RequestInit, handler: Handler = fetch) =>
  Effect.promise(async () => {
    const response = await handler(
      new Request(`${base}${pathname}`, {
        ...init,
        headers: { authorization: authorization(), "content-type": "application/json", ...init.headers },
      }),
    )
    const body: unknown = await response.json()
    if (!response.ok) throw new Error(`${pathname} failed (${response.status}): ${JSON.stringify(body)}`)
    return body
  })

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object")
  return value as Record<string, unknown>
}

function authorization() {
  return `Basic ${btoa("opencode:secret")}`
}

const createSession = (base: string, directory: string, handler?: Handler) =>
  Effect.gen(function* () {
    yield* request(
      base,
      "/api/model?location%5Bdirectory%5D=" + encodeURIComponent(directory),
      { method: "GET" },
      handler,
    )
    const created = record(
      yield* request(
        base,
        "/api/session",
        { method: "POST", body: JSON.stringify({ location: { directory } }) },
        handler,
      ),
    )
    const sessionID = record(created["data"])["id"]
    if (typeof sessionID !== "string") return yield* Effect.die(new Error("Expected a Session ID"))
    return sessionID
  })

function pluginConfig() {
  return JSON.stringify({ plugins: ["-*", path.join(import.meta.dir, "fixture/executable-command-plugin.ts")] })
}

const exists = (file: string) =>
  Effect.promise(() => Bun.file(file).exists()).pipe(
    Effect.filterOrFail(
      (value) => value,
      () => new Error(`File was not created: ${file}`),
    ),
    Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }),
  )

const pluginList = (base: string, directory: string) =>
  request(base, "/api/plugin?location%5Bdirectory%5D=" + encodeURIComponent(directory), { method: "GET" }).pipe(
    Effect.map((body) => record(body)["data"]),
    Effect.flatMap((data) => (Array.isArray(data) ? Effect.succeed(data) : Effect.fail(new Error("Expected plugins")))),
  )

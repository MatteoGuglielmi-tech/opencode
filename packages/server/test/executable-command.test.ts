import path from "node:path"
import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { Effect, Fiber, Schedule } from "effect"
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
        const database = path.join(tmp.path, "opencode.db")
        const effectPlugin = path.join(import.meta.dir, "fixture/executable-command-plugin.ts")
        const promisePlugin = path.join(import.meta.dir, "fixture/promise-command-plugin.ts")
        const failingPlugin = path.join(import.meta.dir, "fixture/failing-command-plugin.ts")
        yield* Effect.promise(() =>
          Bun.write(
            config,
            pluginConfig([
              effectPlugin,
              { package: promisePlugin, options: { generation: "first" } },
            ]),
          ),
        )
        const ids: { parent?: string; effectChild?: string; promiseChild?: string } = {}
        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* startServer(tmp.path, true, database)
            const base = HttpServer.formatAddress(server.address)
            const sessionID = yield* createSession(base, tmp.path, undefined, {
              agent: "build",
              model: { providerID: "parent-provider", id: "parent-model", variant: "parent-variant" },
              location: { directory: tmp.path },
            })
            ids.parent = sessionID
            const plugins = record(
              yield* request(base, "/api/plugin?location%5Bdirectory%5D=" + encodeURIComponent(tmp.path), {
                method: "GET",
              }),
            )
            expect(plugins["data"]).toContainEqual({ id: "executable-command-tracer" })
            expect(plugins["data"]).toContainEqual({ id: "promise-command-tracer" })
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

            const promised = record(
              record(
                yield* request(base, `/api/session/${sessionID}/command`, {
                  method: "POST",
                  body: JSON.stringify({ ...invocation, id: "msg_trace_promise", command: "trace-promise" }),
                }),
              )["data"],
            )
            expect(promised["type"]).toBe("synthetic")
            expect(record(JSON.parse(String(record(promised["payload"])["text"])))["invocation"]).toEqual({
              sessionID,
              ...invocation,
              id: "msg_trace_promise",
              command: "trace-promise",
            })

            const effectChildResult = yield* command(base, sessionID, {
              id: "msg_effect_child",
              command: "trace-effect-child",
              agent: "build",
              model: { providerID: "effect-provider", id: "effect-model", variant: "effect-variant" },
              delivery: "queue",
              resume: false,
            })
            expect(record(payload(effectChildResult)["invocation"])["command"]).toBe("trace-effect-child")

            const selectors = JSON.stringify({ providerID: "child-provider", modelID: "child-model" })
            const promiseChildResult = yield* command(base, sessionID, {
              id: "msg_promise_child",
              command: "trace-promise-child",
              arguments: selectors,
              delivery: "queue",
              resume: false,
            })
            const promiseChildPayload = payload(promiseChildResult)
            expect(record(promiseChildPayload["invocation"])["arguments"]).toBe(selectors)

            const children = record(
              yield* request(base, `/api/session?parentID=${encodeURIComponent(sessionID)}`, { method: "GET" }),
            )["data"]
            if (!Array.isArray(children)) return yield* Effect.die(new Error("Expected child Sessions"))
            const effectChild = record(children.find((item) => record(item)["title"] === "Effect child"))
            const promiseChild = record(children.find((item) => record(item)["title"] === "Promise child"))
            ids.effectChild = String(effectChild["id"])
            ids.promiseChild = String(promiseChild["id"])
            expect(effectChild).toMatchObject({
              parentID: sessionID,
              title: "Effect child",
              agent: "build",
              model: { providerID: "effect-provider", id: "effect-model", variant: "effect-variant" },
              location: { directory: tmp.path },
            })
            expect(promiseChild).toMatchObject({
              parentID: sessionID,
              title: "Promise child",
              agent: "general",
              model: { providerID: "child-provider", id: "child-model", variant: "parent-variant" },
              location: { directory: tmp.path },
            })

            const parent = record(record(yield* request(base, `/api/session/${sessionID}`, { method: "GET" }))["data"])
            expect(parent).toMatchObject({
              agent: "build",
              model: { providerID: "parent-provider", id: "parent-model", variant: "parent-variant" },
            })

            const approval = fetch(`${base}/api/session/${ids.promiseChild}/permission`, {
              method: "POST",
              headers: { authorization: authorization(), "content-type": "application/json" },
              body: JSON.stringify({ action: "delegate", resources: ["child-task"] }),
            })
            const requests = yield* request(base, `/api/session/${ids.promiseChild}/permission`, { method: "GET" }).pipe(
              Effect.filterOrFail(
                (body) => {
                  const data = record(body)["data"]
                  return Array.isArray(data) && data.length === 1
                },
                () => new Error("Child approval was not routed through the selected agent"),
              ),
              Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }),
            )
            const approvalRequest = record((record(requests)["data"] as unknown[])[0])
            expect(approvalRequest).toMatchObject({ sessionID: ids.promiseChild, action: "delegate" })
            yield* request(base, `/api/session/${ids.promiseChild}/permission/${approvalRequest["id"]}/reply`, {
              method: "POST",
              body: JSON.stringify({ reply: "once" }),
            })
            expect(record(record(yield* Effect.promise(() => approval.then((response) => response.json())))["data"])["effect"]).toBe(
              "ask",
            )

            const inbox = record(yield* request(base, `/api/session/${sessionID}/inbox`, { method: "GET" }))["data"]
            if (!Array.isArray(inbox)) return yield* Effect.die(new Error("Expected durable inbox entries"))
            expect(inbox.map((item) => record(item)["id"])).toEqual(
              expect.arrayContaining([
                "msg_trace_synthetic",
                "msg_trace_user",
                "msg_trace_promise",
              ]),
            )
            const childInbox = record(
              yield* request(base, `/api/session/${ids.promiseChild}/inbox`, { method: "GET" }),
            )["data"]
            if (!Array.isArray(childInbox)) return yield* Effect.die(new Error("Expected durable child inbox entries"))
            expect(childInbox.map((item) => record(item)["id"])).toContain("msg_promise_child")

            const cancelled = path.join(tmp.path, "combined-cancelled")
            const controller = new AbortController()
            const pending = yield* raw(base, `/api/session/${sessionID}/command`, {
              method: "POST",
              body: JSON.stringify({ command: "trace-cancel", arguments: cancelled, resume: false }),
              signal: controller.signal,
            }).pipe(Effect.catchCause(() => Effect.void), Effect.forkScoped)
            yield* exists(`${cancelled}.started`)
            yield* request(base, `/api/session/${sessionID}/interrupt`, { method: "POST" })
            expect(yield* Effect.promise(() => Bun.file(cancelled).exists())).toBe(false)

            yield* Effect.promise(() =>
              Bun.write(
                config,
                pluginConfig([{ package: promisePlugin, options: { generation: "first" } }]),
              ),
            )
            yield* pluginList(base, tmp.path).pipe(
              Effect.filterOrFail(
                (items) => items.every((item) => record(item)["id"] !== "executable-command-tracer"),
                () => new Error("Executable command plugin was not disabled"),
              ),
              Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }),
            )
            expect(yield* Effect.promise(() => Bun.file(cancelled).exists())).toBe(false)
            controller.abort()
            yield* Fiber.join(pending)
            expect((yield* raw(base, `/api/session/${sessionID}/command`, {
              method: "POST",
              body: JSON.stringify({ command: "trace-synthetic", resume: false }),
            })).status).toBe(404)

            yield* Effect.promise(() =>
              Bun.write(
                config,
                pluginConfig([
                  { package: promisePlugin, options: { generation: "first" } },
                  { package: failingPlugin, options: { marker: path.join(tmp.path, "failed-disposed") } },
                ]),
              ),
            )
            yield* exists(path.join(tmp.path, "failed-disposed"))
            expect((yield* raw(base, `/api/session/${sessionID}/command`, {
              method: "POST",
              body: JSON.stringify({ command: "trace-failed-generation", resume: false }),
            })).status).toBe(404)

            yield* Effect.promise(() =>
              Bun.write(
                config,
                pluginConfig([{ package: promisePlugin, options: { generation: "second" } }]),
              ),
            )
            yield* command(base, sessionID, {
              command: "trace-promise",
              resume: false,
            }).pipe(
              Effect.filterOrFail(
                (result) => payload(result)["generation"] === "second",
                () => new Error("Promise plugin did not reload"),
              ),
              Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }),
            )

            yield* Effect.promise(() => Bun.write(config, pluginConfig([])))
            yield* pluginList(base, tmp.path).pipe(
              Effect.filterOrFail(
                (items) =>
                  items.every(
                    (item) =>
                      !["executable-command-tracer", "promise-command-tracer"].includes(String(record(item)["id"])),
                  ),
                () => new Error("Tracer plugins were not disabled"),
              ),
              Effect.retry({ times: 100, schedule: Schedule.spaced("10 millis") }),
            )
          }),
        )

        const sqlite = new Database(database, { readonly: true })
        const tables = sqlite.query<{ name: string }, []>("select name from sqlite_master where type = 'table'").all()
        const events = sqlite.query<{ type: string }, []>("select distinct type from event").all()
        const effectChildID = ids.effectChild
        const promiseChildID = ids.promiseChild
        if (!effectChildID || !promiseChildID) return yield* Effect.die(new Error("Expected persisted child Session IDs"))
        const childEvents = sqlite
          .query<{ aggregate_id: string; data: string }, [string, string]>(
            "select aggregate_id, data from event where type = 'session.created.1' and aggregate_id in (?, ?)",
          )
          .all(effectChildID, promiseChildID)
        sqlite.close()
        expect(tables.some((table) => /delegat|child|command_executor/i.test(table.name))).toBe(false)
        expect(events.some((event) => /delegat|child|command_executor/i.test(event.type))).toBe(false)
        const created = Object.fromEntries(childEvents.map((event) => [event.aggregate_id, JSON.parse(event.data)]))
        expect(created[effectChildID]).toMatchObject({
          parentID: ids.parent,
          agent: "build",
          model: { providerID: "effect-provider", id: "effect-model", variant: "effect-variant" },
        })
        expect(created[promiseChildID]).toMatchObject({
          parentID: ids.parent,
          agent: "general",
          model: { providerID: "child-provider", id: "child-model", variant: "parent-variant" },
        })

        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* startServer(tmp.path, false, database)
            const base = HttpServer.formatAddress(server.address)
            yield* Effect.forEach(
              [ids.parent, ids.effectChild, ids.promiseChild],
              (id) =>
                id
                  ? raw(base, `/api/session/${id}`, { method: "GET" }).pipe(
                      Effect.tap((response) => Effect.sync(() => expect(response.status).toBe(200))),
                    )
                  : Effect.die(new Error("Expected persisted Session ID")),
              { discard: true },
            )
            yield* request(base, `/api/session/${ids.parent}`, { method: "DELETE" })
            expect((yield* raw(base, `/api/session/${ids.effectChild}`, { method: "GET" })).status).toBe(404)
            expect((yield* raw(base, `/api/session/${ids.promiseChild}`, { method: "GET" })).status).toBe(404)
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

const startServer = (directory: string, filewatcher: boolean, database = ":memory:") =>
  ServerProcess.start<never, never>({
    hostname: "127.0.0.1",
    port: 0,
    password: "secret",
    app: { version: "test-version" },
    database: { path: database },
    events: { persist: true },
    config: { directory },
    fs: { filewatcher },
  })

const request = (base: string, pathname: string, init: RequestInit, handler: Handler = fetch) =>
  Effect.tryPromise({
    try: async () => {
      const response = await rawRequest(base, pathname, init, handler)
      const text = await response.text()
      const body: unknown = text ? JSON.parse(text) : undefined
      if (!response.ok) throw new Error(`${pathname} failed (${response.status}): ${JSON.stringify(body)}`)
      return body
    },
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  })

const raw = (base: string, pathname: string, init: RequestInit, handler: Handler = fetch) =>
  Effect.promise(() => rawRequest(base, pathname, init, handler))

const rawRequest = (base: string, pathname: string, init: RequestInit, handler: Handler) =>
  handler(
    new Request(`${base}${pathname}`, {
      ...init,
      headers: { authorization: authorization(), "content-type": "application/json", ...init.headers },
    }),
  )

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected an object")
  return value as Record<string, unknown>
}

function authorization() {
  return `Basic ${btoa("opencode:secret")}`
}

const createSession = (
  base: string,
  directory: string,
  handler?: Handler,
  input: Record<string, unknown> = { location: { directory } },
) =>
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
        { method: "POST", body: JSON.stringify(input) },
        handler,
      ),
    )
    const sessionID = record(created["data"])["id"]
    if (typeof sessionID !== "string") return yield* Effect.die(new Error("Expected a Session ID"))
    return sessionID
  })

function pluginConfig(plugins: unknown[] = [path.join(import.meta.dir, "fixture/executable-command-plugin.ts")]) {
  return JSON.stringify({ plugins: ["-*", ...plugins] })
}

const command = (base: string, sessionID: string, input: Record<string, unknown>) =>
  request(base, `/api/session/${sessionID}/command`, { method: "POST", body: JSON.stringify(input) }).pipe(
    Effect.map((body) => record(record(body)["data"])),
  )

function payload(result: Record<string, unknown>) {
  return record(JSON.parse(String(record(result["payload"])["text"])))
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

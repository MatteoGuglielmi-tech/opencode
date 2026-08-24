import path from "node:path"
import { Database } from "bun:sqlite"
import { expect } from "bun:test"
import { Plugin } from "@opencode-ai/schema/plugin"
import { Effect, Schedule } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpServer } from "effect/unstable/http"
import { tmpdir } from "../../core/test/fixture/tmpdir"
import { it } from "../../core/test/lib/effect"
import { ServerProcess } from "../src/process"

it.live("invokes authenticated Location-scoped plugin queries without Session history", () =>
  Effect.acquireUseRelease(
    Effect.promise(() => tmpdir("opencode-plugin-query-")),
    (tmp) =>
      Effect.gen(function* () {
        const first = path.join(tmp.path, "first")
        const second = path.join(tmp.path, "second")
        const database = path.join(tmp.path, "opencode.db")
        const effectPlugin = path.join(import.meta.dir, "fixture/effect-query-plugin.ts")
        const promisePlugin = path.join(import.meta.dir, "fixture/promise-query-plugin.ts")
        yield* Effect.promise(() => Promise.all([Bun.write(path.join(first, ".keep"), ""), Bun.write(path.join(second, ".keep"), "")]))
        yield* Effect.promise(() =>
          Promise.all([
            Bun.write(
              path.join(first, "opencode.json"),
              config([
                { package: effectPlugin, options: { source: "first-effect" } },
                { package: promisePlugin, options: { source: "first-promise" } },
              ]),
            ),
            Bun.write(
              path.join(second, "opencode.json"),
              config([{ package: effectPlugin, options: { source: "second-effect" } }]),
            ),
          ]),
        )

        yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* ServerProcess.start<never, never>({
              hostname: "127.0.0.1",
              port: 0,
              password: "secret",
              app: { version: "test-version" },
              database: { path: database },
              events: { persist: true },
              config: { directory: first },
              fs: { filewatcher: true },
            })
            const baseUrl = HttpServer.formatAddress(server.address)
            const endpoint = (pluginID: string, directory: string) =>
              `${baseUrl}/api/plugin/${pluginID}/query/status?location%5Bdirectory%5D=${encodeURIComponent(directory)}`

            expect(
              (
                yield* Effect.promise(() =>
                  fetch(endpoint("effect-query", first), {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ version: "1", input: { value: 1 } }),
                  }),
                )
              ).status,
            ).toBe(401)

            yield* Effect.promise(() => fetch(endpoint("effect-query", first), request())).pipe(
              Effect.filterOrFail(
                (response) => response.status === 200,
                () => new Error("First Location plugin is not active"),
              ),
              Effect.retry({ times: 100, schedule: Schedule.spaced("20 millis") }),
            )
            yield* Effect.promise(() => fetch(endpoint("effect-query", second), request())).pipe(
              Effect.filterOrFail(
                (response) => response.status === 200,
                () => new Error("Second Location plugin is not active"),
              ),
              Effect.retry({ times: 100, schedule: Schedule.spaced("20 millis") }),
            )
            const session = yield* Effect.promise(() =>
              fetch(`${baseUrl}/api/session`, {
                method: "POST",
                headers: { authorization: authorization(), "content-type": "application/json" },
                body: JSON.stringify({ location: { directory: first } }),
              }),
            )
            expect(session.status).toBe(200)

            const { OpenCode } = yield* Effect.promise(() => import("@opencode-ai/client"))
            const client = OpenCode.make({ baseUrl, headers: { authorization: authorization() } })
            const firstEffect = yield* Effect.promise(() =>
              client.plugin.query.invoke({
                pluginID: "effect-query",
                query: "status",
                version: "1",
                input: { value: 2 },
                location: { directory: first },
              }),
            )
            const firstPromise = yield* Effect.promise(() =>
              client.plugin.query.invoke({
                pluginID: "promise-query",
                query: "status",
                version: "1",
                input: { value: 3 },
                location: { directory: first },
              }),
            )
            expect(firstEffect.data).toEqual({ version: "1", output: { source: "first-effect", value: 2 } })
            expect(firstPromise.data).toEqual({ version: "1", output: { source: "first-promise", value: 3 } })

            {
              const { OpenCode } = yield* Effect.promise(() => import("@opencode-ai/client/effect"))
              const httpClient = yield* HttpClient.HttpClient
              const result = yield* Effect.gen(function* () {
                const client = yield* OpenCode.make({ baseUrl })
                return yield* client.plugin.query.invoke({
                  pluginID: Plugin.ID.make("effect-query"),
                  query: "status",
                  version: "1",
                  input: { value: 4 },
                  location: { directory: second },
                })
              }).pipe(
                Effect.provideService(
                  HttpClient.HttpClient,
                  httpClient.pipe(HttpClient.mapRequest(HttpClientRequest.basicAuth("opencode", "secret"))),
                ),
              )
              expect(result.data).toEqual({ version: "1", output: { source: "second-effect", value: 4 } })
            }

            const invalid = yield* Effect.promise(() =>
              fetch(endpoint("effect-query", first), request({ version: "1", input: { value: "bad" } })),
            )
            expect(invalid.status).toBe(400)
            expect(yield* Effect.promise(() => invalid.json())).toMatchObject({
              _tag: "PluginQueryInvalidRequestError",
              kind: "invalid_request",
            })

            const unavailable = yield* Effect.promise(() =>
              fetch(endpoint("effect-query", first), request({ version: "2", input: { value: 1 } })),
            )
            expect(unavailable.status).toBe(404)
            expect(yield* Effect.promise(() => unavailable.json())).toMatchObject({
              _tag: "PluginQueryUnavailableError",
              kind: "query_unavailable",
            })

            const missing = yield* Effect.promise(() => fetch(endpoint("missing", first), request()))
            expect(missing.status).toBe(404)
            expect(yield* Effect.promise(() => missing.json())).toMatchObject({
              _tag: "PluginUnavailableError",
              kind: "plugin_unavailable",
            })

            yield* Effect.promise(() => Bun.write(path.join(first, "opencode.json"), config([])))
            yield* Effect.promise(() => fetch(endpoint("effect-query", first), request())).pipe(
              Effect.filterOrFail(
                (response) => response.status === 404,
                () => new Error("Plugin query registration was not removed"),
              ),
              Effect.retry({ times: 100, schedule: Schedule.spaced("20 millis") }),
            )
          }).pipe(Effect.provide(FetchHttpClient.layer)),
        )

        const sqlite = new Database(database, { readonly: true })
        expect(sqlite.query<{ count: number }, []>("select count(*) as count from session_v2").get()?.count).toBe(1)
        expect(
          sqlite.query<{ count: number }, []>("select count(*) as count from event where type like 'session.%'").get()?.count,
        ).toBe(1)
        sqlite.close()
      }),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ),
)

function config(plugins: unknown[]) {
  return JSON.stringify({ plugins: ["-*", ...plugins] })
}

function authorization() {
  return `Basic ${btoa("opencode:secret")}`
}

function request(body: unknown = { version: "1", input: { value: 1 } }): RequestInit {
  return {
    method: "POST",
    headers: { authorization: authorization(), "content-type": "application/json" },
    body: JSON.stringify(body),
  }
}

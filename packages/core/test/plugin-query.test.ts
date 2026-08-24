import { describe, expect } from "bun:test"
import { Plugin as EffectPlugin } from "@opencode-ai/plugin/effect"
import { Plugin as PromisePlugin } from "@opencode-ai/plugin"
import { Plugin } from "@opencode-ai/core/plugin"
import { PluginPromise } from "@opencode-ai/core/plugin/promise"
import { Effect, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)
const request = { pluginID: Plugin.ID.make("query-plugin"), name: "status", version: "1", input: { value: 2 } }

describe("Plugin queries", () => {
  it.effect("validates and invokes namespaced versioned Effect queries", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      yield* plugins.activate([
        {
          ...EffectPlugin.define({
            id: "query-plugin",
            effect: (ctx) =>
              Effect.all(
                [
                  ctx.plugin.query.register("status", {
                    version: "1",
                    input: Schema.Struct({ value: Schema.Number }),
                    output: Schema.Struct({ doubled: Schema.Number }),
                    execute: (input) => Effect.succeed({ doubled: input.value * 2 }),
                  }),
                  ctx.plugin.query.register("status", {
                    version: "2",
                    input: Schema.Struct({ value: Schema.Number }),
                    output: Schema.Struct({ tripled: Schema.Number }),
                    execute: (input) => Effect.succeed({ tripled: input.value * 3 }),
                  }),
                ],
                { discard: true },
              ),
          }),
          version: "1",
        },
      ])

      expect(yield* plugins.query(request)).toEqual({ version: "1", output: { doubled: 4 } })
      expect(yield* plugins.query({ ...request, version: "2" })).toEqual({ version: "2", output: { tripled: 6 } })
      expect(yield* plugins.query({ ...request, pluginID: Plugin.ID.make("missing") }).pipe(Effect.flip)).toMatchObject({
        _tag: "PluginUnavailableError",
      })
      expect(yield* plugins.query({ ...request, name: "missing" }).pipe(Effect.flip)).toMatchObject({
        _tag: "PluginQueryUnavailableError",
      })
      expect(yield* plugins.query({ ...request, version: "3" }).pipe(Effect.flip)).toMatchObject({
        _tag: "PluginQueryUnavailableError",
      })
      expect(yield* plugins.query({ ...request, input: { value: "bad" } }).pipe(Effect.flip)).toMatchObject({
        _tag: "PluginQueryInvalidRequestError",
      })
    }),
  )

  it.effect("removes registrations with activation and supports Promise queries", () =>
    Effect.gen(function* () {
      const plugins = yield* Plugin.Service
      const plugin = PromisePlugin.define({
        id: "query-plugin",
        setup: async (ctx) => {
          await ctx.plugin.query.register("status", {
            version: "1",
            input: Schema.Struct({ value: Schema.Number }),
            output: Schema.Struct({ doubled: Schema.Number }),
            execute: async (input) => ({ doubled: input.value * 2 }),
          })
        },
      })

      yield* plugins.activate([{ ...PluginPromise.fromPromise(plugin), version: "1" }])
      expect(yield* plugins.query(request)).toEqual({ version: "1", output: { doubled: 4 } })

      yield* plugins.activate([])
      expect(yield* plugins.query(request).pipe(Effect.flip)).toMatchObject({ _tag: "PluginUnavailableError" })
    }),
  )
})

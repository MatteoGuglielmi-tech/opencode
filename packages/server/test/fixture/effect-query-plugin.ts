import { Plugin } from "@opencode-ai/plugin/effect"
import { Effect, Schema } from "effect"

export default Plugin.define({
  id: "effect-query",
  effect: (ctx) =>
    ctx.plugin.query
      .register("status", {
        version: "1",
        input: Schema.Struct({ value: Schema.Number }),
        output: Schema.Struct({ source: Schema.String, value: Schema.Number }),
        execute: (input) => Effect.succeed({ source: String(ctx.options.source), value: input.value }),
      })
      .pipe(Effect.asVoid),
})

import { Plugin } from "@opencode-ai/plugin"
import { Schema } from "effect"

export default Plugin.define({
  id: "promise-query",
  setup: async (ctx) => {
    await ctx.plugin.query.register("status", {
      version: "1",
      input: Schema.Struct({ value: Schema.Number }),
      output: Schema.Struct({ source: Schema.String, value: Schema.Number }),
      execute: async (input) => ({ source: String(ctx.options.source), value: input.value }),
    })
  },
})

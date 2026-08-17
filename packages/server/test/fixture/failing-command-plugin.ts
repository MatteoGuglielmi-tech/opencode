import { Plugin } from "@opencode-ai/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "failing-command-tracer",
  effect: (ctx) =>
    Effect.gen(function* () {
      const marker = ctx.options.marker
      yield* Effect.addFinalizer(() =>
        typeof marker === "string" ? Effect.promise(() => Bun.write(marker, "disposed")) : Effect.void,
      )
      yield* ctx.command.register("trace-failed-generation", () => Effect.never)
      return yield* Effect.die(new Error("expected tracer activation failure"))
    }),
})

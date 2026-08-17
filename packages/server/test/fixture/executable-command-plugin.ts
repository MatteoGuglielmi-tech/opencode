import { Plugin } from "@opencode-ai/plugin/effect"
import { Effect } from "effect"

export default Plugin.define({
  id: "executable-command-tracer",
  effect: (ctx) =>
    Effect.gen(function* () {
      const shutdown: { path?: string } = {}
      // Registered first so this runs after command registration finalizers.
      yield* Effect.addFinalizer(() => {
        const file = shutdown.path
        return file ? Effect.promise(() => Bun.write(file, "disposed")) : Effect.void
      })
      yield* ctx.command.register("trace-user", (input) =>
        ctx.session.prompt({
          id: input.id,
          sessionID: input.sessionID,
          text: JSON.stringify(input),
          delivery: input.delivery,
          resume: false,
        }),
      )
      yield* ctx.command.register("trace-synthetic", (input) =>
        ctx.session.synthetic({
          id: input.id,
          sessionID: input.sessionID,
          text: JSON.stringify(input),
          delivery: input.delivery,
          resume: false,
        }),
      )
      yield* ctx.command.register("trace-effect-child", (input) =>
        Effect.gen(function* () {
          const child = yield* ctx.session.createChild({
            parentID: input.sessionID,
            title: "Effect child",
            agent: input.agent,
            model: input.model,
          })
          return yield* ctx.session.synthetic({
            id: input.id,
            sessionID: child.id,
            text: JSON.stringify({ invocation: input }),
            delivery: input.delivery,
            resume: false,
          })
        }),
      )
      yield* ctx.command.register("trace-cancel", (input) => {
        const file = input.arguments
        return (file ? Effect.promise(() => Bun.write(`${file}.started`, "started")) : Effect.void).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => (file ? Effect.promise(() => Bun.write(file, "aborted")) : Effect.void)),
        )
      })
      yield* ctx.command.register("trace-shutdown", (input) => {
        shutdown.path = input.arguments
        return ctx.session.synthetic({
          id: input.id,
          sessionID: input.sessionID,
          text: "registered",
          delivery: input.delivery,
          resume: false,
        })
      })
    }),
})

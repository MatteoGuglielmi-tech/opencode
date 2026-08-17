import { Plugin } from "@opencode-ai/plugin"

export default Plugin.define({
  id: "promise-command-tracer",
  setup: async (ctx) => {
    await ctx.agent.transform((draft) => {
      draft.update("general", (agent) => {
        agent.permissions = [{ action: "delegate", resource: "*", effect: "ask" }]
      })
    })

    await ctx.command.register("trace-promise", async (input) =>
      ctx.session.synthetic({
        id: input.id,
        sessionID: input.sessionID,
        text: JSON.stringify({ invocation: input, generation: ctx.options.generation }),
        delivery: input.delivery,
        resume: false,
      }),
    )

    await ctx.command.register("trace-promise-child", async (input) => {
      const parent = await ctx.session.get({ sessionID: input.sessionID })
      const selectors: Record<string, string | undefined> = input.arguments ? JSON.parse(input.arguments) : {}
      const model = parent.model
      if (!model) throw new Error("Tracer parent requires a model")
      const child = await ctx.session.createChild({
        parentID: parent.id,
        title: "Promise child",
        agent: selectors.agent ?? "general",
        model: {
          providerID: selectors.providerID ?? model.providerID,
          id: selectors.modelID ?? model.id,
          variant: selectors.variant ?? model.variant,
        },
      })
      return ctx.session.synthetic({
        id: input.id,
        sessionID: child.id,
        text: JSON.stringify({ invocation: input }),
        delivery: input.delivery,
        resume: false,
      })
    })
  },
})

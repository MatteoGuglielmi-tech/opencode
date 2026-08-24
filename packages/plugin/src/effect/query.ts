export * as Query from "./query.js"

import type { PluginApi } from "@opencode-ai/client/effect/api"
import type { Plugin } from "@opencode-ai/schema/plugin"
import type { Effect, Scope } from "effect"
import type { Registration } from "./registration.js"

export interface Definition<Input extends Plugin.ValueSchema<any>, Output extends Plugin.ValueSchema<any>> {
  readonly version: string
  readonly input: Input
  readonly output: Output
  readonly execute: (input: Plugin.InputValue<Input>) => Effect.Effect<Plugin.OutputValue<Output>>
}

export interface Domain<E = never> extends PluginApi<E> {
  readonly query: PluginApi<E>["query"] & {
    readonly register: <Input extends Plugin.ValueSchema<any>, Output extends Plugin.ValueSchema<any>>(
      name: string,
      definition: Definition<Input, Output>,
    ) => Effect.Effect<Registration, never, Scope.Scope>
  }
}

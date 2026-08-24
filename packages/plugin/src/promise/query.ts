export * as Query from "./query.js"

import type { PluginApi } from "@opencode-ai/client/promise/api"
import type { Plugin } from "@opencode-ai/schema/plugin"
import type { Registration } from "./registration.js"

export interface Definition<Input extends Plugin.ValueSchema<any>, Output extends Plugin.ValueSchema<any>> {
  readonly version: string
  readonly input: Input
  readonly output: Output
  readonly execute: (input: Plugin.InputValue<Input>, context: { readonly signal: AbortSignal }) => Promise<Plugin.OutputValue<Output>>
}

export interface Domain extends PluginApi {
  readonly query: PluginApi["query"] & {
    readonly register: <Input extends Plugin.ValueSchema<any>, Output extends Plugin.ValueSchema<any>>(
      name: string,
      definition: Definition<Input, Output>,
    ) => Promise<Registration>
  }
}

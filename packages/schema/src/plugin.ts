export * as Plugin from "./plugin.js"

import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { Schema } from "effect"
import { ephemeral, inventory } from "./event.js"

export const ID = Schema.String.pipe(Schema.brand("Plugin.ID"))
export type ID = typeof ID.Type

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
}).annotate({ identifier: "Plugin.Info" })

export type ValueSchema<A = unknown> =
  | Schema.Codec<A, any>
  | (StandardSchemaV1<any, A> & StandardJSONSchemaV1<any, A>)

export type InputValue<S> = 0 extends 1 & S
  ? any
  : S extends Schema.Codec<infer A, any>
    ? A
    : S extends StandardSchemaV1<any, infer A>
      ? A
      : unknown

export type OutputValue<S> = 0 extends 1 & S
  ? any
  : S extends Schema.Codec<infer A, any>
    ? A
    : S extends StandardSchemaV1<infer A, any>
      ? A
      : unknown

export interface QueryRequest extends Schema.Schema.Type<typeof QueryRequest> {}
export const QueryRequest = Schema.Struct({
  version: Schema.String,
  input: Schema.Json,
}).annotate({ identifier: "Plugin.QueryRequest" })

export interface QueryResponse extends Schema.Schema.Type<typeof QueryResponse> {}
export const QueryResponse = Schema.Struct({
  version: Schema.String,
  output: Schema.Json,
}).annotate({ identifier: "Plugin.QueryResponse" })

const Added = ephemeral({
  type: "plugin.added",
  schema: { id: ID },
})
const Updated = ephemeral({
  type: "plugin.updated",
  schema: {},
})
export const Event = { Added, Updated, Definitions: inventory(Added, Updated) }

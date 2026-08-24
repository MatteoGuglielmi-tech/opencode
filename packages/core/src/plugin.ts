export * as Plugin from "./plugin.js"
export { Event, ID, Info } from "@opencode-ai/schema/plugin"

import { Plugin } from "@opencode-ai/schema/plugin"
import { Query } from "@opencode-ai/plugin/effect/query"
import type { StandardJSONSchemaV1, StandardSchemaV1 } from "@standard-schema/spec"
import { makeLocationNode } from "@opencode-ai/util/effect/app-node"
import { App } from "./app.js"
import { Context, Effect, Exit, Layer, Logger, References, Schema, Scope, Semaphore } from "effect"
import { Agent } from "./agent.js"
import { AISDK } from "./aisdk.js"
import { Catalog } from "./catalog.js"
import { Command } from "./command.js"
import { Bus } from "./bus.js"
import { Integration } from "./integration.js"
import { Location } from "./location.js"
import { PluginHost } from "./plugin/host.js"
import { PluginRuntime } from "./plugin/runtime.js"
import { WebSearch } from "./websearch.js"
import { Reference } from "./reference.js"
import { Skill } from "./skill.js"
import { State } from "./state.js"
import { Tool } from "./tool.js"
import { PluginHooks } from "./plugin/hooks.js"

export interface Interface {
  readonly activate: (plugins: readonly Versioned[]) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Plugin.Info[]>
  readonly registerQuery: (
    pluginID: Plugin.ID,
    name: string,
    definition: Query.Definition<any, any>,
  ) => Effect.Effect<{ readonly dispose: Effect.Effect<void> }, never, Scope.Scope>
  readonly query: (input: QueryInput) => Effect.Effect<QueryOutput, QueryError>
}

export interface QueryInput {
  readonly pluginID: Plugin.ID
  readonly name: string
  readonly version: string
  readonly input: unknown
}

export interface QueryOutput {
  readonly version: string
  readonly output: Schema.Json
}

export class PluginUnavailableError extends Schema.TaggedErrorClass<PluginUnavailableError>()(
  "PluginUnavailableError",
  { pluginID: Plugin.ID },
) {}

export class PluginQueryUnavailableError extends Schema.TaggedErrorClass<PluginQueryUnavailableError>()(
  "PluginQueryUnavailableError",
  { pluginID: Plugin.ID, query: Schema.String, version: Schema.String },
) {}

export class PluginQueryInvalidRequestError extends Schema.TaggedErrorClass<PluginQueryInvalidRequestError>()(
  "PluginQueryInvalidRequestError",
  { pluginID: Plugin.ID, query: Schema.String, version: Schema.String, message: Schema.String },
) {}

export type QueryError = PluginUnavailableError | PluginQueryUnavailableError | PluginQueryInvalidRequestError
type QueryHandler = (input: unknown) => Effect.Effect<Schema.Json, PluginQueryInvalidRequestError>

export type Versioned = import("@opencode-ai/plugin/effect/plugin").Plugin & { readonly version: string }

export class Service extends Context.Service<Service, Interface>()("@opencode/Plugin") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const scope = yield* Scope.make()
    const active = new Map<Plugin.ID, { readonly plugin: Versioned; readonly scope: Scope.Closeable }>()
    const queries = new Map<Plugin.ID, Map<string, Map<string, QueryHandler>>>()
    const lock = Semaphore.makeUnsafe(1)
    let service: Interface
    let host: Parameters<Versioned["effect"]>[0]

    const load = Effect.fnUntraced(function* (plugin: Versioned) {
      const child = yield* Scope.fork(scope)
      const inherit = yield* State.inherit()
      const pluginID = Plugin.ID.make(plugin.id)
      const pluginHost = {
        ...host,
        plugin: {
          ...host.plugin,
          query: {
            ...host.plugin.query,
            register: (name: string, definition: Query.Definition<any, any>) =>
              service.registerQuery(pluginID, name, definition),
          },
        },
      }
      const loaded = yield* Effect.suspend(() => plugin.effect(pluginHost)).pipe(
        inherit,
        Effect.updateContext((context: Context.Context<never>) =>
          Context.make(Scope.Scope, child).pipe(
            Context.add(Logger.CurrentLoggers, Context.get(context, Logger.CurrentLoggers)),
            Context.add(References.MinimumLogLevel, Context.get(context, References.MinimumLogLevel)),
          ),
        ),
        Effect.withSpan("Plugin.load", { attributes: { "plugin.id": plugin.id } }),
        Effect.andThen(bus.publish(Plugin.Event.Added, { id: Plugin.ID.make(plugin.id) })),
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(child, exit) : Effect.void)),
        Effect.exit,
      )
      if (Exit.isSuccess(loaded)) return child
      yield* Effect.logWarning("failed to load plugin", {
        "plugin.id": plugin.id,
        cause: loaded.cause,
      })
      return undefined
    })

    const activate = Effect.fn("Plugin.activate")(function* (plugins: readonly Versioned[]) {
      const definitions = plugins.map((plugin) => ({ ...plugin, id: Plugin.ID.make(plugin.id) }))
      const ids = new Set<Plugin.ID>()
      for (const definition of definitions) {
        if (ids.has(definition.id)) yield* Effect.die(new Error(`Duplicate plugin ID: ${definition.id}`))
        ids.add(definition.id)
      }

      yield* lock.withPermit(
        Effect.gen(function* () {
          const next = definitions.map((definition) => ({ id: definition.id, version: definition.version }))
          const current = Array.from(active.values(), (entry) => ({
            id: entry.plugin.id,
            version: entry.plugin.version,
          }))
          if (
            current.length === next.length &&
            current.every((definition, index) => {
              const candidate = next[index]
              return definition.id === candidate?.id && definition.version === candidate.version
            })
          )
            return

          yield* State.batch(
            Effect.gen(function* () {
              for (const definition of definitions) {
                const previous = active.get(definition.id)
                active.delete(definition.id)
                if (previous) yield* Scope.close(previous.scope, Exit.void).pipe(Effect.ignore)

                const loaded = yield* load(definition)
                if (loaded) {
                  active.set(definition.id, { plugin: definition, scope: loaded })
                  continue
                }

                if (!previous) continue
                const restored = yield* load(previous.plugin)
                if (restored) {
                  active.set(definition.id, { plugin: previous.plugin, scope: restored })
                  continue
                }
                yield* Effect.logError("failed to restore plugin; deactivating", {
                  "plugin.id": definition.id,
                })
              }

              const removed = Array.from(active.entries())
                .filter(([id]) => !ids.has(id))
                .toReversed()
              removed.forEach(([id]) => active.delete(id))
              yield* Effect.forEach(removed, ([, entry]) => Scope.close(entry.scope, Exit.void).pipe(Effect.ignore), {
                discard: true,
              })
            }),
          )
          yield* bus.publish(Plugin.Event.Updated, {})
        }),
      )
    })

    yield* Effect.addFinalizer((exit) =>
      Effect.gen(function* () {
        active.clear()
        yield* State.batch(Scope.close(scope, exit))
      }),
    )

    service = Service.of({
      activate,
      list: Effect.fn("Plugin.list")(function* () {
        return Array.from(active.keys()).map((id) => ({ id }))
      }),
      registerQuery: Effect.fn("Plugin.registerQuery")(function* (pluginID, name, definition) {
        const scope = yield* Scope.Scope
        const versions = queries.get(pluginID)?.get(name) ?? new Map<string, QueryHandler>()
        if (versions.has(definition.version))
          return yield* Effect.die(new Error(`Plugin query already registered: ${pluginID}/${name}@${definition.version}`))
        const handler: QueryHandler = (input) =>
          decode(definition.input, input).pipe(
            Effect.mapError(
              (error) =>
                new PluginQueryInvalidRequestError({
                  pluginID,
                  query: name,
                  version: definition.version,
                  message: error instanceof Error ? error.message : String(error),
                }),
            ),
            Effect.flatMap(definition.execute),
            Effect.flatMap((output) =>
              encode(definition.output, output).pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
                Effect.orDie,
              ),
            ),
          )
        if (!queries.has(pluginID)) queries.set(pluginID, new Map())
        queries.get(pluginID)?.set(name, versions)
        versions.set(definition.version, handler)
        const dispose = Effect.sync(() => {
          if (versions.get(definition.version) !== handler) return
          versions.delete(definition.version)
          if (versions.size === 0) queries.get(pluginID)?.delete(name)
          if (queries.get(pluginID)?.size === 0) queries.delete(pluginID)
        })
        yield* Scope.addFinalizer(scope, dispose)
        return { dispose }
      }),
      query: Effect.fn("Plugin.query")(function* (input) {
        if (!active.has(input.pluginID)) return yield* new PluginUnavailableError({ pluginID: input.pluginID })
        const handler = queries.get(input.pluginID)?.get(input.name)?.get(input.version)
        if (!handler)
          return yield* new PluginQueryUnavailableError({
            pluginID: input.pluginID,
            query: input.name,
            version: input.version,
          })
        return { version: input.version, output: yield* handler(input.input) }
      }),
    })
    host = yield* PluginHost.make(service)
    return service
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Bus.node,
    App.node,
    Agent.node,
    AISDK.node,
    Catalog.node,
    Command.node,
    Integration.node,
    Location.node,
    Reference.node,
    Skill.node,
    Tool.node,
    PluginHooks.node,
    PluginRuntime.node,
    WebSearch.node,
  ],
})

const isStandardSchema = (
  schema: Plugin.ValueSchema<any>,
): schema is StandardSchemaV1<any, any> & StandardJSONSchemaV1<any, any> =>
  typeof schema === "object" && schema !== null && "~standard" in schema

const decode = (schema: Plugin.ValueSchema<any>, value: unknown): Effect.Effect<unknown, Error | Schema.SchemaError> => {
  if (Schema.isSchema(schema))
    return Schema.decodeUnknownEffect(schema as Schema.Codec<unknown, unknown>)(value)
  if (isStandardSchema(schema)) return validateStandard(schema, value)
  return Effect.fail(new Error("Unsupported plugin query input schema"))
}

const encode = (schema: Plugin.ValueSchema<any>, value: unknown): Effect.Effect<unknown, Error | Schema.SchemaError> => {
  if (Schema.isSchema(schema)) return Schema.encodeEffect(schema as Schema.Codec<unknown, unknown>)(value)
  if (isStandardSchema(schema)) return validateStandard(schema, value)
  return Effect.fail(new Error("Unsupported plugin query output schema"))
}

const validateStandard = (schema: StandardSchemaV1<any, any>, value: unknown) =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() => Promise.resolve(schema["~standard"].validate(value)))
    if (result.issues) return yield* Effect.fail(new Error(result.issues.map((issue) => issue.message).join(", ")))
    return result.value
  })

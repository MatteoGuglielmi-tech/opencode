export * as PluginLegacy from "./legacy.js"

import { createHash } from "node:crypto"
import path from "node:path"
import { Effect } from "effect"
import type { Context, Plugin } from "@opencode/plugin/effect/plugin"

type Hooks = Record<string, unknown>
type Factory = (input: unknown, options: Record<string, unknown> | undefined) => Promise<Hooks>
type AnyRecord = Record<string, any>

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null

export function selectFactories(mod: Record<string, unknown>): { factories: Factory[]; id?: string } | undefined {
  const def = mod.default
  if (isRecord(def) && typeof def.server === "function") {
    const id = typeof def.id === "string" && def.id.trim() ? def.id : undefined
    return { factories: [def.server as Factory], id }
  }
  const seen = new Set<unknown>()
  const factories: Factory[] = []
  for (const value of Object.values(mod)) {
    const factory =
      typeof value === "function"
        ? value
        : isRecord(value) && typeof value.server === "function"
          ? value.server
          : undefined
    if (!factory || seen.has(factory)) continue
    seen.add(factory)
    factories.push(factory as Factory)
  }
  return factories.length ? { factories } : undefined
}

export function legacyId(target: string, id?: string) {
  if (id) return id
  const base = path.basename(target, path.extname(target))
  const hash = createHash("sha1").update(target).digest("hex").slice(0, 8)
  return `legacy:${base}-${hash}`
}

function unstringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function registerHooks(ctx: Context, hooks: Hooks) {
  return Effect.gen(function* () {
    const after = hooks["tool.execute.after"]
    if (typeof after === "function") {
      yield* ctx.tool.hook("execute.after", (event: AnyRecord) =>
        Effect.promise(async () => {
          const v1input = { tool: event.tool, sessionID: event.sessionID, callID: event.id, args: event.input }
          if (event.status === "error") {
            await after(v1input, { output: event.error.message, metadata: event.error.metadata })
            return
          }
          const original =
            typeof event.result.content === "string" ? event.result.content : unstringify(event.result.output)
          const v1output: AnyRecord = { output: original, metadata: event.result.metadata }
          await after(v1input, v1output)
          if (v1output.output !== original) event.result.content = v1output.output
          if (v1output.metadata !== undefined) event.result.metadata = v1output.metadata
        }),
      )
    }

    const before = hooks["tool.execute.before"]
    if (typeof before === "function") {
      yield* ctx.tool.hook("execute.before", (event: AnyRecord) =>
        Effect.promise(async () => {
          const v1output: AnyRecord = { args: event.input }
          await before({ tool: event.tool, sessionID: event.sessionID, callID: event.id }, v1output)
          if (v1output.args !== undefined) event.input = v1output.args
        }),
      )
    }

    const shellEnv = hooks["shell.env"]
    if (typeof shellEnv === "function") {
      yield* ctx.shell.hook("create.before", (event) =>
        Effect.promise(async () => {
          const v1output: AnyRecord = { env: {} }
          await shellEnv({ cwd: event.cwd }, v1output)
          Object.assign(event.env, v1output.env)
        }),
      )
    }

    const dispose = hooks.dispose
    if (typeof dispose === "function") {
      yield* Effect.addFinalizer(() => Effect.promise(() => Promise.resolve(dispose())))
    }

    for (const name of Object.keys(hooks)) {
      if (["tool.execute.after", "tool.execute.before", "shell.env", "dispose"].includes(name)) continue
      yield* Effect.logWarning("v1 plugin hook not supported on v2", { hook: name })
    }
  })
}

export function fromModule(mod: Record<string, unknown>, operation: { readonly target: string }): Plugin | undefined {
  const selected = selectFactories(mod)
  if (!selected) return undefined
  const id = legacyId(operation.target, selected.id)
  return {
    id,
    effect: (ctx) =>
      Effect.gen(function* () {
        const input = {
          directory: ctx.location.directory,
          project: ctx.location.project,
          $: typeof Bun === "undefined" ? undefined : Bun.$,
        }
        for (const factory of selected.factories) {
          const hooks = yield* Effect.promise(() => factory(input, undefined))
          yield* registerHooks(ctx, hooks)
        }
      }),
  }
}

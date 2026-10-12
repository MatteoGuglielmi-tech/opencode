export * as PluginLegacy from "./legacy.js"

import { createHash } from "node:crypto"
import path from "node:path"
import { Effect, Scope } from "effect"
import type { Plugin } from "@opencode/plugin/effect/plugin"

type Hooks = Record<string, unknown>
type Factory = (input: unknown, options: Record<string, unknown> | undefined) => Promise<Hooks>

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

export function fromModule(mod: Record<string, unknown>, operation: { readonly target: string }): Plugin | undefined {
  const selected = selectFactories(mod)
  if (!selected) return undefined
  const id = legacyId(operation.target, selected.id)
  return {
    id,
    effect: (_ctx): Effect.Effect<void, never, Scope.Scope> => Effect.void,
  }
}

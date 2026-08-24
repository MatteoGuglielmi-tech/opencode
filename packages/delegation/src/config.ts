export * as DelegationConfig from "./config.js"

import path from "node:path"
import { Schema } from "effect"

const Input = Schema.Struct({
  profile: Schema.String,
  store: Schema.String,
  concurrency: Schema.Int.check(Schema.isGreaterThan(0)),
})

export interface Options {
  readonly profile: string
  readonly store: string
  readonly concurrency: number
}

export class ConfigError extends Error {
  readonly code = "invalid_options"
}

export function decode(input: unknown): Options {
  const value = Schema.decodeUnknownSync(Input)(
    input !== null && typeof input === "object" && !("concurrency" in input) ? { ...input, concurrency: 6 } : input,
  )
  const profile = path.resolve(value.profile)
  const store = path.resolve(value.store)
  const relative = path.relative(profile, store)
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ConfigError("Delegation store must be a file inside the profile directory")
  }
  return { profile, store, concurrency: value.concurrency }
}

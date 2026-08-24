export * as DelegationDistribution from "./distribution.js"

import path from "node:path"
import { decode } from "./config.js"
import { initialize } from "./storage.js"

export interface ProfileOptions {
  readonly profile: string
  readonly store?: string
  readonly concurrency?: number
}

export async function initializeProfile(input: ProfileOptions) {
  const options = decode({
    profile: input.profile,
    store: input.store ?? path.join(input.profile, "coordinator.sqlite"),
    ...(input.concurrency === undefined ? {} : { concurrency: input.concurrency }),
  })
  await initialize(options)
  return options
}

export async function developmentConfig(input: ProfileOptions) {
  const options = await initializeProfile(input)
  return {
    plugins: [
      {
        package: path.resolve(import.meta.dir, "plugin.ts"),
        options,
      },
    ],
  }
}

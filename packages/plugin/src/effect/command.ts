import type { CommandApi, SessionCommandOperation } from "@opencode-ai/client/effect/api"
import type { CommandInfo } from "@opencode-ai/client"
import type { Effect, Scope } from "effect"
import type { Registration, Transform } from "./registration.js"

export type CommandExecutionInput = Parameters<SessionCommandOperation>[0]
export type CommandExecutionResult = Effect.Success<ReturnType<SessionCommandOperation>>
export type CommandExecutor<E = never> = SessionCommandOperation<E>

export interface CommandRegistrationOptions {
  readonly discoverable?: boolean
}

export interface CommandDraft {
  list(): readonly CommandInfo[]
  get(name: string): CommandInfo | undefined
  update(name: string, update: (command: CommandInfo) => void): void
  remove(name: string): void
}

export interface CommandDomain extends CommandApi<unknown> {
  readonly register: <E = never>(
    name: string,
    execute: CommandExecutor<E>,
    options?: CommandRegistrationOptions,
  ) => Effect.Effect<Registration, never, Scope.Scope>
  readonly transform: Transform<CommandDraft>
  readonly reload: () => Effect.Effect<void>
}

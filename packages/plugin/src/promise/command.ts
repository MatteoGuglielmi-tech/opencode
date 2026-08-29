import type { CommandApi } from "@opencode-ai/client/promise/api"
import type { CommandInfo, SessionCommandInput, SessionCommandOutput } from "@opencode-ai/client"
import type { Registration, Transform } from "./registration.js"

export type CommandExecutionInput = SessionCommandInput
export type CommandExecutionResult = SessionCommandOutput
export type CommandExecutor = (
  input: CommandExecutionInput,
  context: { readonly signal: AbortSignal },
) => Promise<CommandExecutionResult>

export interface CommandRegistrationOptions {
  readonly discoverable?: boolean
}

export interface CommandDraft {
  list(): readonly CommandInfo[]
  get(name: string): CommandInfo | undefined
  update(name: string, update: (command: CommandInfo) => void): void
  remove(name: string): void
}

export interface CommandDomain extends CommandApi {
  readonly register: (
    name: string,
    execute: CommandExecutor,
    options?: CommandRegistrationOptions,
  ) => Promise<Registration>
  readonly transform: Transform<CommandDraft>
  readonly reload: () => Promise<void>
}

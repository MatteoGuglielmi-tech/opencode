import type { SessionApi } from "@opencode-ai/client/effect/api"
import type { Message, SystemPart } from "@opencode-ai/ai"
import type { Agent } from "@opencode-ai/schema/agent"
import type { Model } from "@opencode-ai/schema/model"
import type { Session } from "@opencode-ai/schema/session"
import type { SessionMessage } from "@opencode-ai/schema/session-message"
import type { Effect, JsonSchema } from "effect"
import type { Hooks } from "./registration.js"

export interface SessionContext {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  system: Array<SystemPart>
  messages: Array<Message>
  tools: Record<string, { description: string; input: JsonSchema.JsonSchema }>
}

export interface SessionHttpRequest {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  request: Request
}

export interface SessionHttpResponse {
  readonly sessionID: Session.ID
  readonly agent: Agent.ID
  readonly model: Model.Ref
  readonly request: Request
  response: Response
}

export interface SessionHooks {
  readonly context: SessionContext
  readonly "http.request": SessionHttpRequest
  readonly "http.response": SessionHttpResponse
}

export interface CreateChildInput {
  readonly parentID: Session.ID
  readonly title?: string
  readonly agent?: Agent.ID
  readonly model?: Model.Ref
}

export interface SessionDomain
  extends Pick<
    SessionApi<unknown>,
    "create" | "get" | "prompt" | "generate" | "command" | "synthetic" | "interrupt" | "rename" | "wait"
  > {
  readonly createChild: (input: CreateChildInput) => ReturnType<SessionApi<unknown>["create"]>
  readonly messages: (input: {
    readonly sessionID: Session.ID
    readonly limit?: number
    readonly order?: "asc" | "desc"
  }) => Effect.Effect<ReadonlyArray<SessionMessage.Info>, unknown>
  readonly resume: (input: { readonly sessionID: Session.ID }) => ReturnType<SessionApi<unknown>["wait"]>
  readonly inbox: Pick<SessionApi<unknown>["inbox"], "cancel">
  readonly hook: Hooks<SessionHooks>
}

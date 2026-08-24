import type { SessionApi } from "@opencode-ai/client/promise/api"
import type { ModelRef, SessionMessageInfo } from "@opencode-ai/client"
import type { Message, SystemPart } from "@opencode-ai/ai"
import type { Agent } from "@opencode-ai/schema/agent"
import type { Model } from "@opencode-ai/schema/model"
import type { Session } from "@opencode-ai/schema/session"
import type { JsonSchema } from "effect"
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
  readonly parentID: string
  readonly title?: string
  readonly agent?: string
  readonly model?: ModelRef
}

export interface SessionDomain
  extends Pick<SessionApi, "create" | "get" | "prompt" | "generate" | "command" | "synthetic" | "interrupt"> {
  readonly createChild: (input: CreateChildInput) => ReturnType<SessionApi["create"]>
  readonly messages: (input: {
    readonly sessionID: string
    readonly limit?: number
    readonly order?: "asc" | "desc"
  }) => Promise<ReadonlyArray<SessionMessageInfo>>
  readonly resume: (input: { readonly sessionID: string }) => Promise<void>
  readonly inbox: Pick<SessionApi["inbox"], "cancel">
  readonly hook: Hooks<SessionHooks>
}

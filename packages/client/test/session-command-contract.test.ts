import { expect, test } from "bun:test"
import type { SessionCommandOutput } from "@opencode-ai/client"
import type { SessionCommandOperation } from "@opencode-ai/client/effect/api"
import { Session } from "@opencode-ai/schema/session"
import { SessionInbox } from "@opencode-ai/schema/session-inbox"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { DateTime, type Effect } from "effect"

type EffectSessionCommandOutput = Effect.Success<ReturnType<SessionCommandOperation>>

test("generated command outputs accept durable user and synthetic results", () => {
  const promise = [
    {
      id: "msg_user",
      sessionID: "ses_contract",
      timeCreated: 0,
      type: "user",
      payload: { text: "user" },
      delivery: "queue",
    },
    {
      id: "msg_synthetic",
      sessionID: "ses_contract",
      timeCreated: 0,
      type: "synthetic",
      payload: { text: "synthetic" },
      delivery: "queue",
    },
  ] satisfies SessionCommandOutput[]
  const base = { sessionID: Session.ID.make("ses_contract"), timeCreated: DateTime.makeUnsafe(0), delivery: "queue" }
  const effect = [
    SessionInbox.User.make({
      ...base,
      id: SessionMessage.ID.make("msg_user"),
      type: "user",
      payload: { text: "user" },
    }),
    SessionInbox.Synthetic.make({
      ...base,
      id: SessionMessage.ID.make("msg_synthetic"),
      type: "synthetic",
      payload: { text: "synthetic" },
    }),
  ] satisfies EffectSessionCommandOutput[]

  expect(promise.map((item) => item.type)).toEqual(["user", "synthetic"])
  expect(effect.map((item) => item.type)).toEqual(["user", "synthetic"])
})

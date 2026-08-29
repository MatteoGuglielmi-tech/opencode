import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { execute, parse, ReceiptPendingError, resolve } from "../src/admission"
import { decode } from "../src/config"
import { initialize, open } from "../src/storage"

describe("delegation admission", () => {
  test("parses repeated tasks and shell-like shared fields", () => {
    expect(
      parse('agent=reviewer model=openai/gpt-5 effort=high context="release \\"gate\\"" task="check api"\n task="check ui"'),
    ).toEqual({
      agent: "reviewer",
      model: "openai/gpt-5",
      effort: "high",
      context: 'release "gate"',
      operations: ["check api", "check ui"],
    })
  })

  test("preserves quoted operation text while validating its trimmed content", () => {
    expect(parse('task="  inspect exactly  "').operations).toEqual(["  inspect exactly  "])
    expect(() => parse('task="   "')).toThrow("at least one operation")
  })

  test("treats everything after the first bare token as one literal operation", () => {
    expect(parse("agent=general inspect foo=bar and keep spacing")).toEqual({
      agent: "general",
      operations: ["inspect foo=bar and keep spacing"],
    })
  })

  test("rejects ambiguous or invalid grammar", () => {
    expect(() => parse('task="one" trailing text')).toThrow("cannot be combined")
    expect(() => parse("agent=general agent=reviewer task=work")).toThrow("Duplicate field")
    expect(() => parse("unknown=value task=work")).toThrow("Unknown field")
    expect(() => parse("unknown_field=value task=work")).toThrow("Unknown field")
    expect(() => parse('task="unterminated')).toThrow("Unterminated quote")
    expect(() => parse("context=only")).toThrow("at least one operation")
  })

  test("resolves effective selectors and validates admitted references", () => {
    const resolved = resolve(
      parse('agent=reviewer effort=high context=" release " task="check api"'),
      {
        parentAgent: "general",
        parentModel: { providerID: "openai", id: "gpt-5", variant: "low" },
        files: [{ uri: "file:///tmp/input.txt" }],
        agents: [{ name: "general" }],
        skills: [{ id: "effect" }],
      },
      {
        agents: [
          { id: "general", name: "General", mode: "primary" },
          {
            id: "reviewer",
            name: "Reviewer",
            mode: "subagent",
            model: { providerID: "anthropic", id: "claude", variant: "fast" },
          },
        ],
        models: [
          { providerID: "openai", id: "gpt-5", variants: ["low", "high"] },
          { providerID: "anthropic", id: "claude", variants: ["fast", "high"] },
        ],
        skills: ["effect"],
      },
    )

    expect(resolved).toEqual({
      agent: "reviewer",
      model: { providerID: "anthropic", modelID: "claude", variant: "high" },
      context: "release",
      files: [{ uri: "file:///tmp/input.txt" }],
      agents: [{ name: "general" }],
      skills: [{ id: "effect" }],
      operations: ["check api"],
    })
  })

  test("keeps slash-attached skills distinct from backticked operation text", () => {
    const inventory = {
      agents: [{ id: "general", name: "General", mode: "subagent" as const }],
      models: [{ providerID: "openai", id: "gpt-5", variants: [] }],
      skills: ["bugfix-session"],
    }
    const parent = {
      parentAgent: "general",
      parentModel: { providerID: "openai", id: "gpt-5" },
      files: [],
      agents: [],
    }

    expect(
      resolve(
        parse('task="/bugfix-session inspect the failure"'),
        { ...parent, skills: [{ id: "bugfix-session" }] },
        inventory,
      ).skills,
    ).toEqual([{ id: "bugfix-session" }])
    expect(resolve(parse('task="`bugfix-session` inspect the failure"'), { ...parent, skills: [] }, inventory).skills).toEqual(
      [],
    )
  })

  test("resolves short models in the parent provider and rejects invalid references", () => {
    const inventory = {
      agents: [
        { id: "general", name: "General", mode: "subagent" as const },
        { id: "primary", name: "Primary", mode: "primary" as const },
      ],
      models: [{ providerID: "openai", id: "gpt-5", variants: ["high"] }],
      skills: ["effect"],
    }
    const invocation = {
      parentAgent: "primary",
      parentModel: { providerID: "openai", id: "gpt-4" },
      files: [],
      agents: [],
      skills: [],
    }

    expect(resolve(parse("model=gpt-5 effort=high do work"), invocation, inventory).model).toEqual({
      providerID: "openai",
      modelID: "gpt-5",
      variant: "high",
    })
    expect(
      resolve(
        parse("model=gpt-5 do work"),
        { ...invocation, parentModel: { providerID: "openai", id: "gpt-5", variant: "high" } },
        inventory,
      ).model,
    ).toEqual({ providerID: "openai", modelID: "gpt-5", variant: "high" })
    expect(
      resolve(
        parse("model=gpt-5 do work"),
        { ...invocation, parentModel: { providerID: "openai", id: "gpt-4", variant: "high" } },
        inventory,
      ).model,
    ).toEqual({ providerID: "openai", modelID: "gpt-5" })
    expect(() => resolve(parse("agent=primary do work"), invocation, inventory)).toThrow("subagent-compatible")
    expect(() =>
      resolve(parse("model=gpt-5 do work"), { ...invocation, skills: [{ id: "missing" }] }, inventory),
    ).toThrow("Skill not found")
  })

  test("atomically reconciles exact retries and rejects conflicting invocation reuse", async () => {
    await using tmp = await tempDirectory()
    const options = decode({
      profile: tmp.path,
      store: path.join(tmp.path, "coordinator.sqlite"),
      concurrency: 2,
    })
    await initialize(options)
    const firstStore = await open(options)
    const request = {
      parentID: "ses_parent",
      invocationID: "msg_invocation",
      canonical: JSON.stringify({ operations: ["one", "two"] }),
      agent: "general",
      model: { providerID: "openai", modelID: "gpt-5", variant: "high" },
      context: "release",
      files: [{ uri: "file:///tmp/input.txt" }],
      agents: [{ name: "reviewer" }],
      skills: [{ id: "effect" }],
      operations: ["one", "two"],
      admittedAt: 123,
    }
    const first = await firstStore.admit(request)

    expect(first.created).toBe(true)
    expect(first.batch.operations.map((operation) => [operation.index, operation.text, operation.state])).toEqual([
      [0, "one", "queued"],
      [1, "two", "queued"],
    ])
    expect(first.receipt.id).toBe(
      "msg_" +
        createHash("sha256")
          .update(`delegation-admission-v1\0ses_parent\0${first.batch.id}`)
          .digest("hex"),
    )
    expect(first.receipt.resume).toBe(false)
    expect(first.receipt.delivery).toBe("steer")
    expect(first.receipt.metadata).toMatchObject({
      source: "delegation",
      kind: "admission-receipt",
      version: 1,
      parentID: "ses_parent",
      batchID: first.batch.id,
    })

    await firstStore.acknowledgeReceipt(first.batch.id)

    await firstStore.close()
    const secondStore = await open(options)
    const retry = await secondStore.admit(request)
    expect(retry.created).toBe(false)
    expect(retry).toEqual({ ...first, created: false, receipt: { ...first.receipt, acknowledged: true } })
    await expect(secondStore.admit({ ...request, canonical: JSON.stringify({ operations: ["different"] }) })).rejects.toMatchObject(
      { code: "invocation_conflict" },
    )
    await secondStore.close()
  })

  test("delivers and acknowledges the durable non-waking receipt", async () => {
    await using tmp = await tempDirectory()
    const options = decode({
      profile: tmp.path,
      store: path.join(tmp.path, "coordinator.sqlite"),
      concurrency: 2,
    })
    await initialize(options)
    const store = await open(options)
    const delivered: Array<Record<string, unknown>> = []
    const services = {
      parent: () => Effect.succeed({ agent: "general", model: { providerID: "openai", id: "gpt-5" } }),
      agents: () => Effect.succeed([{ id: "general", name: "General", mode: "subagent" as const }]),
      models: () => Effect.succeed([{ providerID: "openai", id: "gpt-5", variants: ["high"] }]),
      defaultModel: () => Effect.succeed(undefined),
      skills: () => Effect.succeed([{ id: "effect" }]),
      synthetic: (input: Record<string, unknown>) => {
        delivered.push(input)
        return Effect.succeed({ type: "synthetic" as const, ...input })
      },
    }

    const failure = await Effect.runPromise(
      execute({ sessionID: "ses_parent", arguments: "unknown=value" }, services, store).pipe(Effect.flip),
    )
    expect(failure).toMatchObject({ code: "invalid_arguments" })

    const result = await Effect.runPromise(
      execute(
        {
          sessionID: "ses_parent",
          id: "msg_invocation",
          arguments: 'effort=high task="check api"',
          files: [],
          agents: [],
          skills: [{ id: "effect" }],
        },
        services,
        store,
        () => 123,
      ),
    )

    expect(result.type).toBe("synthetic")
    expect(delivered).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      sessionID: "ses_parent",
      description: "Delegation admitted",
      delivery: "steer",
      resume: false,
    })
    const retry = await store.admit({
      parentID: "ses_parent",
      invocationID: "msg_invocation",
      canonical: JSON.stringify({
        agent: "general",
        model: { providerID: "openai", modelID: "gpt-5", variant: "high" },
        files: [],
        agents: [],
        skills: [{ id: "effect" }],
        operations: ["check api"],
        receipt: { delivery: "steer", resume: false },
      }),
      agent: "general",
      model: { providerID: "openai", modelID: "gpt-5", variant: "high" },
      files: [],
      agents: [],
      skills: [{ id: "effect" }],
      operations: ["check api"],
      admittedAt: 123,
    })
    expect(retry.receipt.acknowledged).toBe(true)

    const pending = await Effect.runPromise(
      execute(
        {
          sessionID: "ses_parent",
          id: "msg_second",
          arguments: 'effort=high task="check worker"',
          files: [],
          agents: [],
          skills: [{ id: "effect" }],
        },
        services,
        {
          ...store,
          acknowledgeReceipt: async () => {
            throw new Error("write failed")
          },
        },
        () => 124,
      ).pipe(Effect.flip),
    )
    expect(pending).toMatchObject({ code: "receipt_pending" })
    if (!(pending instanceof ReceiptPendingError)) throw new Error("expected pending receipt failure")
    expect(pending.batchID).toStartWith("dlg_")
    await store.close()
  })

  test("reconciles a pending receipt after admitted inventory disappears", async () => {
    await using tmp = await tempDirectory()
    const options = decode({
      profile: tmp.path,
      store: path.join(tmp.path, "coordinator.sqlite"),
      concurrency: 2,
    })
    await initialize(options)
    const store = await open(options)
    const input = {
      sessionID: "ses_parent",
      id: "msg_inventory_drift",
      arguments: 'agent=reviewer model=anthropic/claude effort=high task="check api"',
      skills: [{ id: "effect" }],
    }
    const parent = () => Effect.succeed({ agent: "general", model: { providerID: "openai", id: "gpt-5" } })
    const first = await Effect.runPromise(
      execute(
        input,
        {
          parent,
          agents: () =>
            Effect.succeed([
              { id: "general", name: "General", mode: "subagent" as const },
              { id: "reviewer", name: "Reviewer", mode: "subagent" as const },
            ]),
          models: () =>
            Effect.succeed([
              { providerID: "openai", id: "gpt-5", variants: [] },
              { providerID: "anthropic", id: "claude", variants: ["high"] },
            ]),
          defaultModel: () => Effect.succeed(undefined),
          skills: () => Effect.succeed([{ id: "effect" }]),
          synthetic: () => Effect.fail(new Error("delivery unavailable")),
        },
        store,
        () => 123,
      ).pipe(Effect.flip),
    )
    expect(first).toMatchObject({ code: "receipt_pending" })

    const drifted = {
      parent,
      agents: () => Effect.succeed([]),
      models: () => Effect.succeed([]),
      defaultModel: () => Effect.succeed(undefined),
      skills: () => Effect.succeed([]),
      synthetic: (receipt: Record<string, unknown>) => Effect.succeed(receipt),
    }
    const retry = await Effect.runPromise(execute(input, drifted, store, () => 124))
    expect(retry).toMatchObject({ description: "Delegation admitted", resume: false })

    const conflict = await Effect.runPromise(
      execute({ ...input, arguments: 'agent=reviewer task="different"' }, drifted, store, () => 125).pipe(Effect.flip),
    )
    expect(conflict).toMatchObject({ code: "invocation_conflict" })
    await store.close()
  })

  test("reconciles parent-relative selectors after the parent changes", async () => {
    await using tmp = await tempDirectory()
    const options = decode({ profile: tmp.path, store: path.join(tmp.path, "coordinator.sqlite"), concurrency: 2 })
    await initialize(options)
    const store = await open(options)
    const input = {
      sessionID: "ses_parent",
      id: "msg_parent_drift",
      arguments: 'agent=parent model=gpt-5 task="check api"',
    }
    const first = await Effect.runPromise(
      execute(
        input,
        {
          parent: () => Effect.succeed({ agent: "general", model: { providerID: "openai", id: "gpt-5" } }),
          agents: () => Effect.succeed([{ id: "general", name: "General", mode: "subagent" as const }]),
          models: () => Effect.succeed([{ providerID: "openai", id: "gpt-5", variants: [] }]),
          defaultModel: () => Effect.succeed(undefined),
          skills: () => Effect.succeed([]),
          synthetic: () => Effect.fail(new Error("delivery unavailable")),
        },
        store,
      ).pipe(Effect.flip),
    )
    expect(first).toMatchObject({ code: "receipt_pending" })

    const retry = await Effect.runPromise(
      execute(
        input,
        {
          parent: () => Effect.succeed({ agent: "reviewer", model: { providerID: "anthropic", id: "claude" } }),
          agents: () => Effect.succeed([]),
          models: () => Effect.succeed([]),
          defaultModel: () => Effect.succeed(undefined),
          skills: () => Effect.succeed([]),
          synthetic: (receipt: Record<string, unknown>) => Effect.succeed(receipt),
        },
        store,
      ),
    )
    expect(retry).toMatchObject({ description: "Delegation admitted", resume: false })
    await store.close()
  })

  test("keeps later receipts blocked behind the earliest unacknowledged receipt", async () => {
    await using tmp = await tempDirectory()
    const options = decode({
      profile: tmp.path,
      store: path.join(tmp.path, "coordinator.sqlite"),
      concurrency: 2,
    })
    await initialize(options)
    const store = await open(options)
    const request = {
      parentID: "ses_parent",
      canonical: "first",
      agent: "general",
      model: { providerID: "openai", modelID: "gpt-5" },
      files: [],
      agents: [],
      skills: [],
      operations: ["work"],
      admittedAt: 123,
    }
    const first = await store.admit(request)
    const second = await store.admit({ ...request, canonical: "second", admittedAt: 124 })

    expect(await store.receiptReady(first.batch.id)).toBe(true)
    expect(await store.receiptReady(second.batch.id)).toBe(false)
    await store.acknowledgeReceipt(first.batch.id)
    expect(await store.receiptReady(second.batch.id)).toBe(true)
    await store.close()
  })
})

async function tempDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-delegation-admission-"))
  return {
    path: directory,
    async [Symbol.asyncDispose]() {
      await rm(directory, { recursive: true, force: true })
    },
  }
}

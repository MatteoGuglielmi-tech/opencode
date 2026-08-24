export * as DelegationStorage from "./storage.js"

import { Database } from "bun:sqlite"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rm, stat } from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { AgentAttachment, PromptInput } from "@opencode-ai/schema"
import type { Options } from "./config.js"

const PROFILE_VERSION = 1
const SCHEMA_VERSION = 8
const OWNER_INITIALIZATION_GRACE = 5_000

export type OperationState = "queued" | "starting" | "running" | "waiting" | "completed" | "failed" | "interrupted"
export type ExecutionEndSource = "session_event" | "startup_reconciliation"
export type PermissionWaitCloseReason = "replied" | "operation_concluded" | "service_restart"
export type TerminalReasonCode =
  | "completed"
  | "execution_failed"
  | "setup_failed"
  | "cancelled_before_start"
  | "user_interrupted"
  | "child_deleted"
  | "prompt_admission_uncertain"
  | "service_restarted"

export interface OperationRecord {
  readonly id: string
  readonly batchID: string
  readonly parentID: string
  readonly index: number
  readonly text: string
  readonly state: OperationState
  readonly agent: string
  readonly model: AdmissionRequest["model"]
  readonly context?: string
  readonly files: ReadonlyArray<PromptInput.FileAttachment>
  readonly agents: ReadonlyArray<AgentAttachment>
  readonly skills: ReadonlyArray<PromptInput.SkillAttachment>
  readonly childID?: string
  readonly promptID?: string
  readonly promptAdmitted: boolean
  readonly cancellationRequested: boolean
  readonly executionStartedAt?: number
  readonly executionEndedAt?: number
  readonly executionEndSource?: ExecutionEndSource
  readonly completionObservedAt?: number
  readonly admittedAt: number
  readonly permitClaimedAt?: number
  readonly terminalAt?: number
  readonly reason?: string
  readonly reasonCode?: TerminalReasonCode
  readonly recoveryEligible: boolean
  readonly recoveryID?: string
  readonly recoveryReconciledAt?: number
  readonly recoveryPreviousState?: "starting" | "running" | "waiting"
  readonly retryOfOperationID?: string
}

export interface TransitionPatch {
  readonly childID?: string
  readonly promptID?: string
  readonly promptAdmitted?: boolean
  readonly executionStartedAt?: number
  readonly executionEndedAt?: number
  readonly executionEndSource?: ExecutionEndSource
  readonly completionObservedAt?: number
  readonly terminalAt?: number
  readonly reason?: string
  readonly reasonCode?: TerminalReasonCode
  readonly outcome?: string
}

export interface DeliveryIntent {
  readonly key: string
  readonly parentID: string
  readonly id: string
  readonly text: string
  readonly description: string
  readonly metadata: Record<string, unknown>
  readonly delivery: "steer"
  readonly resume: boolean
  readonly conflicted: boolean
}

export interface StartupState {
  readonly parents: ReadonlyArray<string>
  readonly active: ReadonlyArray<OperationRecord>
}

export interface SnapshotQuery {
  readonly parentID: string
  readonly batchID?: string
  readonly operationID?: string
  readonly state?: OperationState
  readonly cursor?: string
  readonly limit?: number
}

export interface DelegationSnapshot {
  readonly version: 1
  readonly batches: ReadonlyArray<{
    readonly id: string
    readonly sequence: number
    readonly admittedAt: number
    readonly startedAt?: number
    readonly concludedAt?: number
    readonly receiptDelivery: DeliveryState
    readonly status: "active" | "concluded"
    readonly outcomes: {
      readonly completed: number
      readonly failed: number
      readonly interrupted: number
    }
  }>
  readonly operations: ReadonlyArray<
    OperationRecord & {
      readonly permissionWaits: ReadonlyArray<PermissionWait>
      readonly fifoPosition: number
      readonly queuePosition: number
      readonly terminalDelivery?: DeliveryState
      readonly recoveryDelivery?: DeliveryState
      readonly terminalOutcome?: {
        readonly report: string
        readonly metadata: Record<string, unknown>
      }
    }
  >
  readonly delivery: Readonly<Record<DeliveryKind, { readonly pending: number; readonly conflicted: number }>>
  readonly summary: {
    readonly total: number
    readonly queued: number
    readonly starting: number
    readonly running: number
    readonly finalizing: number
    readonly waiting: number
    readonly completed: number
    readonly failed: number
    readonly interrupted: number
    readonly cancellationRequested: number
    readonly recoveryEligible: number
    readonly actionable: number
    readonly lastActivityAt: number
    readonly newestOperationID?: string
    readonly newestActionableOperationID?: string
  }
  readonly nextCursor?: string
}

export interface WorkspaceSnapshot {
  readonly parents: ReadonlyArray<{
    readonly parentID: string
    readonly operations: ReadonlyArray<OperationRecord & { readonly permissionWaits: ReadonlyArray<PermissionWait> }>
    readonly receiptDelivery: Readonly<Record<string, DeliveryState>>
    readonly delivery: DelegationSnapshot["delivery"]
  }>
}

export type DeliveryKind = "admission" | "terminal" | "recovery" | "control"
export type DeliveryState = "acknowledged" | "pending" | "conflicted"

export interface PermissionWait {
  readonly sequence: number
  readonly startedAt: number
  readonly endedAt?: number
  readonly closeReason?: PermissionWaitCloseReason
}

export type ControlAction =
  | Readonly<{ action: "cancel"; batchID?: string; operationID?: string }>
  | Readonly<{ action: "steer"; operationID: string; text: string }>
  | Readonly<{ action: "retry" | "dismiss"; operationID: string }>

export interface ControlRequest {
  readonly parentID: string
  readonly invocationID: string
  readonly canonical: string
  readonly action: ControlAction
  readonly committedAt: number
}

export interface ControlRecord {
  readonly created: boolean
  readonly retryBatchID?: string
  readonly effect?:
    | Readonly<{ kind: "cancel"; operationIDs: ReadonlyArray<string> }>
    | Readonly<{ kind: "steer"; operationID: string; childID: string; messageID: string; text: string }>
  readonly receipt: DeliveryIntent & { readonly acknowledged: boolean }
}

export interface AdmissionRequest {
  readonly parentID: string
  readonly invocationID?: string
  readonly canonical: string
  readonly agent: string
  readonly model: { readonly providerID: string; readonly modelID: string; readonly variant?: string }
  readonly context?: string
  readonly files: ReadonlyArray<unknown>
  readonly agents: ReadonlyArray<unknown>
  readonly skills: ReadonlyArray<unknown>
  readonly operations: ReadonlyArray<string>
  readonly admittedAt: number
}

export interface AdmissionRecord {
  readonly created: boolean
  readonly batch: {
    readonly id: string
    readonly parentID: string
    readonly sequence: number
    readonly agent: string
    readonly model: AdmissionRequest["model"]
    readonly context?: string
    readonly admittedAt: number
    readonly operations: ReadonlyArray<{
      readonly id: string
      readonly index: number
      readonly text: string
      readonly state: "queued"
    }>
  }
  readonly receipt: {
    readonly id: string
    readonly text: string
    readonly description: "Delegation admitted"
    readonly metadata: Record<string, unknown>
    readonly delivery: "steer"
    readonly resume: false
    readonly acknowledged: boolean
  }
}

export interface AdmissionIdentity {
  readonly agent: string
  readonly model: AdmissionRequest["model"]
}

export type StorageErrorCode =
  | "profile_uninitialized"
  | "profile_incompatible"
  | "store_missing"
  | "store_corrupt"
  | "store_incompatible"
  | "store_owned"
  | "store_unwritable"
  | "store_closed"
  | "invocation_conflict"
  | "control_conflict"
  | "control_invalid"

export type StorageFailureCode = Exclude<
  StorageErrorCode,
  "invocation_conflict" | "control_conflict" | "control_invalid"
>

export class StorageError extends Error {
  constructor(
    readonly code: StorageErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export function isStorageFailure(cause: unknown): cause is StorageError & { readonly code: StorageFailureCode } {
  return (
    cause instanceof StorageError &&
    cause.code !== "invocation_conflict" &&
    cause.code !== "control_conflict" &&
    cause.code !== "control_invalid"
  )
}

export function storageFailureCause(
  cause: unknown,
): (StorageError & { readonly code: StorageFailureCode }) | undefined {
  if (isStorageFailure(cause)) return cause
  if (cause instanceof Error && cause.cause !== undefined) return storageFailureCause(cause.cause)
  return undefined
}

export function isSyntheticConflict(cause: unknown) {
  return (
    typeof cause === "object" && cause !== null && "_tag" in cause && cause._tag === "Session.SyntheticConflictError"
  )
}

export interface Store {
  readonly path: string
  readonly readable: () => Promise<"ok">
  readonly check: () => Promise<"ok">
  readonly admissionIdentity: (parentID: string, invocationID: string) => Promise<AdmissionIdentity | undefined>
  readonly admit: (request: AdmissionRequest) => Promise<AdmissionRecord>
  readonly receiptReady: (batchID: string) => Promise<boolean>
  readonly acknowledgeReceipt: (batchID: string) => Promise<void>
  readonly pendingReceipts: () => Promise<ReadonlyArray<DeliveryIntent>>
  readonly acknowledgeTerminal: (operationID: string) => Promise<void>
  readonly pendingTerminals: () => Promise<ReadonlyArray<DeliveryIntent>>
  readonly acknowledgeRecovery: (recoveryID: string, parentID: string) => Promise<void>
  readonly pendingRecoveries: () => Promise<ReadonlyArray<DeliveryIntent>>
  readonly commitControl: (request: ControlRequest) => Promise<ControlRecord>
  readonly controlReady: (invocationID: string, parentID: string) => Promise<boolean>
  readonly pendingControls: () => Promise<ReadonlyArray<DeliveryIntent>>
  readonly pendingControlRecords: () => Promise<ReadonlyArray<ControlRecord>>
  readonly acknowledgeControl: (invocationID: string, parentID: string) => Promise<void>
  readonly markDeliveryConflict: (kind: DeliveryKind, key: string, parentID: string) => Promise<void>
  readonly pendingCompletions: () => Promise<ReadonlyArray<OperationRecord>>
  readonly startupState: () => Promise<StartupState>
  readonly reconcileStartup: (reconciledAt: number) => Promise<void>
  readonly claimQueued: (limit: number, claimedAt: number) => Promise<ReadonlyArray<OperationRecord>>
  readonly startPermissionWait: (operationID: string, startedAt: number) => Promise<boolean>
  readonly endPermissionWait: (
    operationID: string,
    endedAt: number,
    reason: PermissionWaitCloseReason,
  ) => Promise<boolean>
  readonly transition: (
    operationID: string,
    expected: ReadonlyArray<OperationState>,
    state: OperationState,
    patch?: TransitionPatch,
  ) => Promise<boolean>
  readonly operation: (operationID: string) => Promise<OperationRecord | undefined>
  readonly operationByChild: (childID: string) => Promise<OperationRecord | undefined>
  readonly operationsByBatch: (batchID: string) => Promise<ReadonlyArray<OperationRecord>>
  readonly activeByParent: (parentID: string) => Promise<ReadonlyArray<OperationRecord>>
  readonly workspaceSnapshots: (
    queries: ReadonlyArray<
      SnapshotQuery & { readonly focusChildID?: string; readonly focusOperationID?: string }
    >,
  ) => Promise<ReadonlyArray<{ readonly parentID: string; readonly snapshot: DelegationSnapshot }>>
  readonly workspace: () => Promise<WorkspaceSnapshot>
  readonly snapshot: (query: SnapshotQuery) => Promise<DelegationSnapshot>
  readonly requestCancellation: (
    operationID: string,
    cancelledAt: number,
  ) => Promise<{ readonly operation?: OperationRecord; readonly requested: boolean }>
  readonly removeParent: (parentID: string) => Promise<void>
  readonly close: () => Promise<void>
}

export async function initialize(options: Options) {
  await mkdir(options.profile, { recursive: true })
  const marker = path.join(options.profile, "profile.json")
  if (await Bun.file(marker).exists()) await verifyProfile(options.profile)
  else await Bun.write(marker, JSON.stringify({ version: PROFILE_VERSION }, null, 2) + "\n")

  if (await Bun.file(options.store).exists()) {
    const database = new Database(options.store, { create: false, readwrite: true })
    try {
      migrateSchema(database)
    } finally {
      database.close()
    }
    return
  }

  const database = new Database(options.store, { create: true, readwrite: true })
  try {
    database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE delegation_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO delegation_meta (key, value) VALUES ('schema', '${SCHEMA_VERSION}');
      PRAGMA user_version = ${SCHEMA_VERSION};
       ${admissionSchema}
       ${deliverySchema}
       ${controlSchema}
     `)
  } finally {
    database.close()
  }
}

export async function open(options: Options): Promise<Store> {
  await verifyProfile(options.profile)
  if (!(await Bun.file(options.store).exists())) {
    throw new StorageError("store_missing", "Initialized Delegation profile has no coordinator store")
  }

  const owner = await claimOwner(options.store)
  const database = await openDatabase(options.store).catch(async (cause) => {
    await owner.release()
    throw cause
  })
  let closed = false
  const admit = database.transaction((request: AdmissionRequest): AdmissionRecord => {
    const existing =
      request.invocationID === undefined
        ? undefined
        : database
            .query<
              { id: string; canonical_request: string },
              [string, string]
            >("SELECT id, canonical_request FROM delegation_batch WHERE parent_id = ? AND invocation_id = ?")
            .get(request.parentID, request.invocationID)
    if (existing) {
      if (existing.canonical_request !== request.canonical)
        throw new StorageError("invocation_conflict", "Delegation invocation ID was reused with different input")
      return loadAdmission(database, existing.id, false)
    }

    const batchID = `dlg_${randomUUID().replaceAll("-", "")}`
    const sequence =
      database
        .query<
          { sequence: number },
          [string]
        >("SELECT COALESCE(MAX(admission_sequence), 0) + 1 AS sequence FROM delegation_batch WHERE parent_id = ?")
        .get(request.parentID)?.sequence ?? 1
    const operations = request.operations.map((text, index) => ({
      id: `dop_${randomUUID().replaceAll("-", "")}`,
      index,
      text,
      state: "queued" as const,
    }))
    const receiptID =
      "msg_" + createHash("sha256").update(`delegation-admission-v1\0${request.parentID}\0${batchID}`).digest("hex")
    const receiptText = renderReceipt(batchID, operations)
    const metadata = receiptMetadata(request, batchID, operations)
    database
      .query<
        never,
        [
          string,
          string,
          string | null,
          string,
          number,
          string,
          string,
          string,
          string | null,
          string | null,
          string,
          string,
          string,
          number,
        ]
      >(
        `INSERT INTO delegation_batch
          (id, parent_id, invocation_id, canonical_request, admission_sequence, agent_id, provider_id, model_id,
           variant, shared_context, files, agents, skills, admitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        batchID,
        request.parentID,
        request.invocationID ?? null,
        request.canonical,
        sequence,
        request.agent,
        request.model.providerID,
        request.model.modelID,
        request.model.variant ?? null,
        request.context ?? null,
        JSON.stringify(request.files),
        JSON.stringify(request.agents),
        JSON.stringify(request.skills),
        request.admittedAt,
      )
    const insertOperation = database.query<never, [string, string, number, string]>(
      "INSERT INTO delegation_operation (id, batch_id, operation_index, operation_text, state) VALUES (?, ?, ?, ?, 'queued')",
    )
    operations.forEach((operation) => insertOperation.run(operation.id, batchID, operation.index, operation.text))
    database
      .query<never, [string, string, number, string, string, string]>(
        `INSERT INTO delegation_receipt
          (batch_id, message_id, receipt_sequence, text, description, metadata, delivery, resume, acknowledged)
         VALUES (?, ?, ?, ?, ?, ?, 'steer', 0, 0)`,
      )
      .run(batchID, receiptID, sequence, receiptText, "Delegation admitted", JSON.stringify(metadata))
    return loadAdmission(database, batchID, true)
  })
  const claimQueued = database.transaction((limit: number, claimedAt: number) => {
    const candidates = database
      .query<OperationRow, [number]>(
        `WITH ranked AS (
           SELECT o.id,
                  ROW_NUMBER() OVER (
                    PARTITION BY b.parent_id
                    ORDER BY b.admission_sequence, o.operation_index
                  ) AS position,
                  (SELECT COUNT(*)
                   FROM delegation_operation active
                   JOIN delegation_batch active_batch ON active_batch.id = active.batch_id
                   WHERE active_batch.parent_id = b.parent_id
                     AND active.state IN ('starting', 'running', 'waiting')) AS active
           FROM delegation_operation o
           JOIN delegation_batch b ON b.id = o.batch_id
           JOIN delegation_receipt r ON r.batch_id = b.id
           WHERE o.state = 'queued' AND r.acknowledged = 1
             AND NOT EXISTS (
               SELECT 1 FROM delegation_recovery recovery
               WHERE recovery.parent_id = b.parent_id AND recovery.acknowledged = 0
             )
         )
         SELECT o.*, b.parent_id, b.agent_id, b.provider_id, b.model_id, b.variant, b.shared_context, b.admitted_at,
                b.files, b.agents, b.skills
         FROM ranked
         JOIN delegation_operation o ON o.id = ranked.id
         JOIN delegation_batch b ON b.id = o.batch_id
         WHERE ranked.position <= MAX(0, ? - ranked.active)
         ORDER BY b.parent_id, b.admission_sequence, o.operation_index`,
      )
      .all(limit)
    const claim = database.query<never, [number, string]>(
      `UPDATE delegation_operation
       SET state = 'starting', permit_claimed_at = MAX(?, (SELECT admitted_at FROM delegation_batch WHERE id = batch_id))
       WHERE id = ? AND state = 'queued'`,
    )
    return candidates.flatMap((candidate) => {
      if (claim.run(claimedAt, candidate.id).changes !== 1) return []
      return [operationRecord({ ...candidate, state: "starting" })]
    })
  })
  const requestCancellation = database.transaction((operationID: string, cancelledAt: number) => {
    const current = loadOperation(database, "o.id", operationID)
    if (
      !current ||
      terminal(current.state) ||
      current.completionObservedAt !== undefined ||
      current.cancellationRequested
    )
      return { ...(current ? { operation: current } : {}), requested: false }
    if (current.state === "queued") {
      database.query("UPDATE delegation_operation SET cancel_requested = 1 WHERE id = ?").run(operationID)
      transitionOperation(database, operationID, ["queued"], "interrupted", {
        terminalAt: cancelledAt,
        reason: "cancelled before start",
        reasonCode: "cancelled_before_start",
      })
    } else {
      database
        .query(
          "UPDATE delegation_operation SET cancel_requested = 1 WHERE id = ? AND state IN ('starting', 'running', 'waiting')",
        )
        .run(operationID)
    }
    return { operation: loadOperation(database, "o.id", operationID), requested: true }
  })
  const startPermissionWait = database.transaction((operationID: string, startedAt: number) => {
    const operation = loadOperation(database, "o.id", operationID)
    if (!operation || terminal(operation.state)) return false
    const open = database
      .query<
        { sequence: number },
        [string]
      >("SELECT sequence FROM delegation_permission_wait WHERE operation_id = ? AND ended_at IS NULL")
      .get(operationID)
    if (open) return false
    const sequence =
      database
        .query<
          { sequence: number },
          [string]
        >("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM delegation_permission_wait WHERE operation_id = ?")
        .get(operationID)?.sequence ?? 1
    database
      .query("INSERT INTO delegation_permission_wait (operation_id, sequence, started_at) VALUES (?, ?, ?)")
      .run(
        operationID,
        sequence,
        normalizeTime(startedAt, operation.executionStartedAt, operation.permitClaimedAt, operation.admittedAt),
      )
    database
      .query(
        "UPDATE delegation_operation SET state = 'waiting' WHERE id = ? AND state IN ('starting', 'running', 'waiting')",
      )
      .run(operationID)
    return true
  })
  const endPermissionWait = database.transaction(
    (operationID: string, endedAt: number, reason: PermissionWaitCloseReason) => {
      const operation = loadOperation(database, "o.id", operationID)
      if (!operation || terminal(operation.state)) return false
      if (!closePermissionWait(database, operationID, endedAt, reason)) return false
      database
        .query("UPDATE delegation_operation SET state = ? WHERE id = ? AND state = 'waiting'")
        .run(operation.executionStartedAt === undefined ? "starting" : "running", operationID)
      return true
    },
  )
  const removeParent = database.transaction((parentID: string) => {
    const batches = database
      .query<{ id: string }, [string]>("SELECT id FROM delegation_batch WHERE parent_id = ?")
      .all(parentID)
    const removeOperations = database.query("DELETE FROM delegation_operation WHERE batch_id = ?")
    const removeReceipt = database.query("DELETE FROM delegation_receipt WHERE batch_id = ?")
    const removeBatch = database.query("DELETE FROM delegation_batch WHERE id = ?")
    database.query("DELETE FROM delegation_terminal_report WHERE parent_id = ?").run(parentID)
    database.query("DELETE FROM delegation_recovery WHERE parent_id = ?").run(parentID)
    database.query("DELETE FROM delegation_control_receipt WHERE parent_id = ?").run(parentID)
    database.query("DELETE FROM delegation_control WHERE parent_id = ?").run(parentID)
    batches.forEach((batch) => {
      removeOperations.run(batch.id)
      removeReceipt.run(batch.id)
      removeBatch.run(batch.id)
    })
  })
  const commitControl = database.transaction((request: ControlRequest) => commitControlRecord(database, request))

  const store: Store = {
    path: options.store,
    async readable() {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      verifyQuickCheck(database)
      return "ok"
    },
    async check() {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      verifyQuickCheck(database)
      return "ok"
    },
    async admissionIdentity(parentID, invocationID) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      const row = database
        .query<{ agent_id: string; provider_id: string; model_id: string; variant: string | null }, [string, string]>(
          `SELECT agent_id, provider_id, model_id, variant
           FROM delegation_batch WHERE parent_id = ? AND invocation_id = ?`,
        )
        .get(parentID, invocationID)
      if (!row) return undefined
      return {
        agent: row.agent_id,
        model: {
          providerID: row.provider_id,
          modelID: row.model_id,
          ...(row.variant === null ? {} : { variant: row.variant }),
        },
      }
    },
    async admit(request) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      return admit(request)
    },
    async receiptReady(batchID) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      const result = database
        .query<{ ready: number }, [string]>(
          `SELECT NOT EXISTS (
             SELECT 1
             FROM delegation_batch earlier
             JOIN delegation_receipt receipt ON receipt.batch_id = earlier.id
             WHERE earlier.parent_id = current.parent_id
               AND earlier.admission_sequence < current.admission_sequence
               AND receipt.acknowledged = 0
           ) AS ready
           FROM delegation_batch current
           WHERE current.id = ?`,
        )
        .get(batchID)
      if (!result) throw new StorageError("store_corrupt", `Delegation batch is missing: ${batchID}`)
      return result.ready === 1
    },
    async acknowledgeReceipt(batchID) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      database.query("UPDATE delegation_receipt SET acknowledged = 1 WHERE batch_id = ?").run(batchID)
    },
    async pendingReceipts() {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return database
        .query<DeliveryRow, []>(
          `SELECT r.batch_id AS delivery_key, b.parent_id, r.message_id, r.text, r.description, r.metadata,
                  r.delivery, r.resume, r.conflicted
           FROM delegation_receipt r JOIN delegation_batch b ON b.id = r.batch_id
           WHERE r.acknowledged = 0
           ORDER BY b.parent_id, r.receipt_sequence`,
        )
        .all()
        .map(deliveryIntent)
    },
    async acknowledgeTerminal(operationID) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      database.query("UPDATE delegation_terminal_report SET acknowledged = 1 WHERE operation_id = ?").run(operationID)
    },
    async pendingTerminals() {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return database
        .query<DeliveryRow, []>(
          `SELECT operation_id AS delivery_key, parent_id, message_id, text, description, metadata, delivery, resume,
                  conflicted
           FROM delegation_terminal_report WHERE acknowledged = 0 ORDER BY parent_id, report_sequence`,
        )
        .all()
        .map(deliveryIntent)
    },
    async acknowledgeRecovery(recoveryID, parentID) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      database
        .query("UPDATE delegation_recovery SET acknowledged = 1 WHERE recovery_id = ? AND parent_id = ?")
        .run(recoveryID, parentID)
    },
    async pendingRecoveries() {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return database
        .query<DeliveryRow, []>(
          `SELECT recovery_id AS delivery_key, parent_id, message_id, text, description, metadata, delivery, resume,
                  conflicted
           FROM delegation_recovery WHERE acknowledged = 0 ORDER BY parent_id, recovery_sequence`,
        )
        .all()
        .map(deliveryIntent)
    },
    async commitControl(request) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      return commitControl(request)
    },
    async controlReady(invocationID, parentID) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      const result = database
        .query<{ ready: number }, [string, string]>(
          `SELECT NOT EXISTS (
             SELECT 1 FROM delegation_control earlier
             JOIN delegation_control_receipt receipt
               ON receipt.parent_id = earlier.parent_id AND receipt.invocation_id = earlier.invocation_id
             WHERE earlier.parent_id = current.parent_id
               AND earlier.control_sequence < current.control_sequence
               AND receipt.acknowledged = 0
           ) AS ready
           FROM delegation_control current WHERE current.parent_id = ? AND current.invocation_id = ?`,
        )
        .get(parentID, invocationID)
      if (!result) throw new StorageError("store_corrupt", "Delegation Control record is missing")
      return result.ready === 1
    },
    async pendingControls() {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return database
        .query<DeliveryRow, []>(
          `SELECT invocation_id AS delivery_key, parent_id, message_id, text, description, metadata, delivery, resume,
                  conflicted
           FROM delegation_control_receipt WHERE acknowledged = 0 ORDER BY parent_id, rowid`,
        )
        .all()
        .map(deliveryIntent)
    },
    async pendingControlRecords() {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return database
        .query<{ parent_id: string; invocation_id: string }, []>(
          `SELECT control.parent_id, control.invocation_id
           FROM delegation_control control
           JOIN delegation_control_receipt receipt
             ON receipt.parent_id = control.parent_id AND receipt.invocation_id = control.invocation_id
           WHERE receipt.acknowledged = 0 ORDER BY control.parent_id, control.control_sequence`,
        )
        .all()
        .map((row) => loadControl(database, row.parent_id, row.invocation_id, false))
    },
    async acknowledgeControl(invocationID, parentID) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      database
        .query("UPDATE delegation_control_receipt SET acknowledged = 1 WHERE invocation_id = ? AND parent_id = ?")
        .run(invocationID, parentID)
    },
    async markDeliveryConflict(kind, key, parentID) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      const target = {
        admission: ["delegation_receipt", "batch_id"],
        terminal: ["delegation_terminal_report", "operation_id"],
        recovery: ["delegation_recovery", "recovery_id"],
        control: ["delegation_control_receipt", "invocation_id"],
      } as const
      database
        .query(
          `UPDATE ${target[kind][0]} SET conflicted = 1 WHERE acknowledged = 0 AND ${target[kind][1]} = ? AND ${
            kind === "admission" || kind === "terminal" ? "1 = 1" : "parent_id = ?"
          }`,
        )
        .run(...(kind === "admission" || kind === "terminal" ? [key] : [key, parentID]))
    },
    async pendingCompletions() {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return database
        .query<OperationRow, []>(
          `SELECT o.*, b.parent_id, b.agent_id, b.provider_id, b.model_id, b.variant, b.shared_context, b.admitted_at,
                  b.files, b.agents, b.skills
           FROM delegation_operation o JOIN delegation_batch b ON b.id = o.batch_id
           WHERE o.completion_observed_at IS NOT NULL AND o.state IN ('starting', 'running', 'waiting')
           ORDER BY b.parent_id, b.admission_sequence, o.operation_index`,
        )
        .all()
        .map(operationRecord)
    },
    async startupState() {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return {
        parents: database
          .query<{ parent_id: string }, []>("SELECT DISTINCT parent_id FROM delegation_batch ORDER BY parent_id")
          .all()
          .map((row) => row.parent_id),
        active: loadActive(database),
      }
    },
    async reconcileStartup(reconciledAt) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      reconcileStartup(database, reconciledAt)
    },
    async claimQueued(limit, claimedAt) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      return claimQueued(limit, claimedAt)
    },
    async startPermissionWait(operationID, startedAt) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      return startPermissionWait(operationID, startedAt)
    },
    async endPermissionWait(operationID, endedAt, reason) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      return endPermissionWait(operationID, endedAt, reason)
    },
    async transition(operationID, expected, state, patch = {}) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      if (expected.length === 0) return false
      return transitionOperation(database, operationID, expected, state, patch)
    },
    async operation(operationID) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return loadOperation(database, "o.id", operationID)
    },
    async operationByChild(childID) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return loadOperation(database, "o.child_id", childID)
    },
    async operationsByBatch(batchID) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return database
        .query<OperationRow, [string]>(
          `SELECT o.*, b.parent_id, b.agent_id, b.provider_id, b.model_id, b.variant, b.shared_context, b.admitted_at,
                  b.files, b.agents, b.skills
           FROM delegation_operation o
           JOIN delegation_batch b ON b.id = o.batch_id
           WHERE b.id = ?
           ORDER BY o.operation_index`,
        )
        .all(batchID)
        .map(operationRecord)
    },
    async activeByParent(parentID) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return database
        .query<OperationRow, [string]>(
          `SELECT o.*, b.parent_id, b.agent_id, b.provider_id, b.model_id, b.variant, b.shared_context, b.admitted_at,
                  b.files, b.agents, b.skills
           FROM delegation_operation o
           JOIN delegation_batch b ON b.id = o.batch_id
           WHERE b.parent_id = ? AND o.state IN ('starting', 'running', 'waiting')
           ORDER BY b.admission_sequence, o.operation_index`,
        )
        .all(parentID)
        .map(operationRecord)
    },
    async workspace() {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return database.transaction(() => ({
        parents: database
          .query<{ parent_id: string }, []>("SELECT DISTINCT parent_id FROM delegation_batch ORDER BY parent_id")
          .all()
          .map((row) => ({
            parentID: row.parent_id,
            operations: loadParentOperations(database, row.parent_id).map((operation) => ({
              ...operation,
              permissionWaits: loadPermissionWaits(database, operation.id),
            })),
            receiptDelivery: Object.fromEntries(
              database
                .query<{ batch_id: string; acknowledged: number; conflicted: number }, [string]>(
                  `SELECT receipt.batch_id, receipt.acknowledged, receipt.conflicted
                   FROM delegation_receipt receipt JOIN delegation_batch batch ON batch.id = receipt.batch_id
                   WHERE batch.parent_id = ?`,
                )
                .all(row.parent_id)
                .map((receipt) => [receipt.batch_id, deliveryState(receipt.acknowledged, receipt.conflicted)]),
            ),
            delivery: deliverySummary(database, row.parent_id),
          })),
      }))()
    },
    async snapshot(input) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return database.transaction(() => delegationSnapshot(database, input))()
    },
    async workspaceSnapshots(queries) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      return database.transaction(() =>
        queries.flatMap((query) => {
          const retained = database
            .query<
              { retained: number },
              [string]
            >("SELECT 1 AS retained FROM delegation_batch WHERE parent_id = ? LIMIT 1")
            .get(query.parentID)
          if (!retained) return []
          const focusDepth = query.focusChildID
            ? childHistoryDepth(database, query.parentID, query.focusChildID)
            : query.focusOperationID
              ? operationHistoryDepth(database, query.parentID, query.focusOperationID)
              : undefined
          return [
            {
              parentID: query.parentID,
              snapshot: delegationSnapshot(database, {
                ...query,
                limit: Math.max(query.limit ?? 50, focusDepth ?? 0),
              }),
            },
          ]
        }),
      )()
    },
    async requestCancellation(operationID, cancelledAt) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      return requestCancellation(operationID, cancelledAt)
    },
    async removeParent(parentID) {
      if (closed) throw new StorageError("store_closed", "Delegation coordinator store is closed")
      await owner.check()
      removeParent(parentID)
    },
    async close() {
      if (closed) return
      closed = true
      database.close()
      await owner.release()
    },
  }
  return safeStore(store)
}

function safeStore(store: Store): Store {
  return {
    path: store.path,
    readable: safeMethod(store.readable),
    check: safeMethod(store.check),
    admissionIdentity: safeMethod(store.admissionIdentity),
    admit: safeMethod(store.admit),
    receiptReady: safeMethod(store.receiptReady),
    acknowledgeReceipt: safeMethod(store.acknowledgeReceipt),
    pendingReceipts: safeMethod(store.pendingReceipts),
    acknowledgeTerminal: safeMethod(store.acknowledgeTerminal),
    pendingTerminals: safeMethod(store.pendingTerminals),
    acknowledgeRecovery: safeMethod(store.acknowledgeRecovery),
    pendingRecoveries: safeMethod(store.pendingRecoveries),
    commitControl: safeMethod(store.commitControl),
    controlReady: safeMethod(store.controlReady),
    pendingControls: safeMethod(store.pendingControls),
    pendingControlRecords: safeMethod(store.pendingControlRecords),
    acknowledgeControl: safeMethod(store.acknowledgeControl),
    markDeliveryConflict: safeMethod(store.markDeliveryConflict),
    pendingCompletions: safeMethod(store.pendingCompletions),
    startupState: safeMethod(store.startupState),
    reconcileStartup: safeMethod(store.reconcileStartup),
    claimQueued: safeMethod(store.claimQueued),
    startPermissionWait: safeMethod(store.startPermissionWait),
    endPermissionWait: safeMethod(store.endPermissionWait),
    transition: safeMethod(store.transition),
    operation: safeMethod(store.operation),
    operationByChild: safeMethod(store.operationByChild),
    operationsByBatch: safeMethod(store.operationsByBatch),
    activeByParent: safeMethod(store.activeByParent),
    workspaceSnapshots: safeMethod(store.workspaceSnapshots),
    workspace: safeMethod(store.workspace),
    snapshot: safeMethod(store.snapshot),
    requestCancellation: safeMethod(store.requestCancellation),
    removeParent: safeMethod(store.removeParent),
    close: safeMethod(store.close),
  }
}

function safeMethod<Args extends ReadonlyArray<unknown>, Result>(method: (...args: Args) => Promise<Result>) {
  return (...args: Args) => method(...args).catch(storageFailure)
}

function storageFailure(cause: unknown): never {
  if (cause instanceof StorageError) throw cause
  throw new StorageError("store_unwritable", "Delegation coordinator SQLite operation failed", { cause })
}

function commitControlRecord(database: Database, request: ControlRequest): ControlRecord {
  const existing = database
    .query<
      { canonical_request: string },
      [string, string]
    >("SELECT canonical_request FROM delegation_control WHERE parent_id = ? AND invocation_id = ?")
    .get(request.parentID, request.invocationID)
  if (existing) {
    if (existing.canonical_request !== request.canonical)
      throw new StorageError("control_conflict", "Delegation Control invocation ID was reused with different input")
    return loadControl(database, request.parentID, request.invocationID, false)
  }
  if (request.action.action === "cancel") {
    const operations = request.action.batchID
      ? database
          .query<OperationRow, [string]>(
            `SELECT o.*, b.parent_id, b.agent_id, b.provider_id, b.model_id, b.variant, b.shared_context, b.admitted_at,
                    b.files, b.agents, b.skills
             FROM delegation_operation o JOIN delegation_batch b ON b.id = o.batch_id
             WHERE b.id = ? ORDER BY o.operation_index`,
          )
          .all(request.action.batchID)
          .map(operationRecord)
      : [ownedOperation(database, request.parentID, request.action.operationID)]
    if (operations.length === 0 || operations.some((operation) => operation.parentID !== request.parentID))
      throw new StorageError("control_invalid", "Delegation target is not owned by this parent Session")
    if (
      !operations.some(
        (operation) =>
          !terminal(operation.state) && operation.completionObservedAt === undefined && !operation.cancellationRequested,
      )
    )
      throw new StorageError("control_invalid", "Delegation cancellation target is no longer cancellable")
    operations.forEach((operation) => {
      if (terminal(operation.state) || operation.cancellationRequested) return
      database.query("UPDATE delegation_operation SET cancel_requested = 1 WHERE id = ?").run(operation.id)
      if (operation.state === "queued")
        transitionOperation(database, operation.id, ["queued"], "interrupted", {
          terminalAt: request.committedAt,
          reason: "cancelled before start",
          reasonCode: "cancelled_before_start",
        })
    })
    insertControl(database, request, {
      effect: {
        kind: "cancel",
        operationIDs: operations
          .filter((operation) => !terminal(operation.state))
          .map((operation) => operation.id),
      },
    })
    return loadControl(database, request.parentID, request.invocationID, true)
  }

  if (request.action.action === "steer") {
    const operation = ownedOperation(database, request.parentID, request.action.operationID)
    if (
      operation.completionObservedAt !== undefined ||
      (operation.state !== "running" && operation.state !== "waiting") ||
      !operation.childID
    )
      throw new StorageError("control_invalid", "Delegation operation is not running")
    insertControl(database, request, {
      effect: {
        kind: "steer",
        operationID: operation.id,
        childID: operation.childID,
        messageID: deterministicID(`delegation-control-steer-v1\0${request.parentID}\0${request.invocationID}`),
        text: request.action.text,
      },
    })
    return loadControl(database, request.parentID, request.invocationID, true)
  }

  if (request.action.action === "dismiss") {
    const operation = ownedOperation(database, request.parentID, request.action.operationID)
    if (!operation.recoveryEligible)
      throw new StorageError("control_invalid", "Delegation operation is not eligible for dismissal")
    database.query("UPDATE delegation_operation SET recovery_eligible = 0 WHERE id = ?").run(operation.id)
    insertControl(database, request, {})
    return loadControl(database, request.parentID, request.invocationID, true)
  }

  const original = ownedOperation(database, request.parentID, request.action.operationID)
  if (!original.recoveryEligible)
    throw new StorageError("control_invalid", "Delegation operation is not eligible for retry")

  const retryBatchID = `dlg_${randomUUID().replaceAll("-", "")}`
  const retryOperationID = `dop_${randomUUID().replaceAll("-", "")}`
  const sequence = nextSequence(database, "delegation_batch", "admission_sequence", request.parentID)
  database
    .query(
      `INSERT INTO delegation_batch
        (id, parent_id, invocation_id, canonical_request, admission_sequence, agent_id, provider_id, model_id,
         variant, shared_context, files, agents, skills, admitted_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      retryBatchID,
      request.parentID,
      `retry:${original.id}:${request.invocationID}`,
      sequence,
      original.agent,
      original.model.providerID,
      original.model.modelID,
      original.model.variant ?? null,
      original.context ?? null,
      JSON.stringify(original.files),
      JSON.stringify(original.agents),
      JSON.stringify(original.skills),
      request.committedAt,
    )
  database
    .query(
      `INSERT INTO delegation_operation (id, batch_id, operation_index, operation_text, state, retry_of_operation_id)
       VALUES (?, ?, 0, ?, 'queued', ?)`,
    )
    .run(retryOperationID, retryBatchID, original.text, original.id)
  const retryOperations = [{ id: retryOperationID, index: 0, text: original.text, state: "queued" as const }]
  const retryRequest: AdmissionRequest = {
    parentID: request.parentID,
    canonical: `retry:${original.id}:${request.invocationID}`,
    agent: original.agent,
    model: original.model,
    ...(original.context === undefined ? {} : { context: original.context }),
    files: original.files,
    agents: original.agents,
    skills: original.skills,
    operations: [original.text],
    admittedAt: request.committedAt,
  }
  database
    .query(
      `INSERT INTO delegation_receipt
        (batch_id, message_id, receipt_sequence, text, description, metadata, delivery, resume, acknowledged)
       VALUES (?, ?, ?, ?, ?, ?, 'steer', 0, 0)`,
    )
    .run(
      retryBatchID,
      deterministicID(`delegation-admission-v1\0${request.parentID}\0${retryBatchID}`),
      sequence,
      renderReceipt(retryBatchID, retryOperations),
      "Delegation admitted",
      JSON.stringify(receiptMetadata(retryRequest, retryBatchID, retryOperations)),
    )
  database.query("UPDATE delegation_operation SET recovery_eligible = 0 WHERE id = ?").run(original.id)
  insertControl(database, request, { retryBatchID })
  return loadControl(database, request.parentID, request.invocationID, true)
}

function ownedOperation(database: Database, parentID: string, operationID: string | undefined) {
  const operation = operationID === undefined ? undefined : loadOperation(database, "o.id", operationID)
  if (!operation || operation.parentID !== parentID)
    throw new StorageError("control_invalid", "Delegation operation is not owned by this parent Session")
  return operation
}

function insertControl(database: Database, request: ControlRequest, response: Record<string, unknown>) {
  const sequence = nextSequence(database, "delegation_control", "control_sequence", request.parentID)
  database
    .query(
      `INSERT INTO delegation_control
        (parent_id, invocation_id, canonical_request, control_sequence, action, response, committed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      request.parentID,
      request.invocationID,
      request.canonical,
      sequence,
      request.action.action,
      JSON.stringify(response),
      request.committedAt,
    )
  database
    .query(
      `INSERT INTO delegation_control_receipt
        (parent_id, invocation_id, message_id, text, description, metadata, delivery, resume, acknowledged)
       VALUES (?, ?, ?, ?, ?, ?, 'steer', 0, 0)`,
    )
    .run(
      request.parentID,
      request.invocationID,
      deterministicID(`delegation-control-v1\0${request.parentID}\0${request.invocationID}`),
      `<delegation-control action="${request.action.action}" status="committed" />`,
      "Delegation control committed",
      JSON.stringify({
        source: "delegation",
        kind: "control-receipt",
        version: 1,
        parentID: request.parentID,
        invocationID: request.invocationID,
        action: request.action.action,
        response,
        time: { committed: request.committedAt },
      }),
    )
}

function loadControl(database: Database, parentID: string, invocationID: string, created: boolean): ControlRecord {
  const row = database
    .query<
      {
        response: string
        message_id: string
        text: string
        description: string
        metadata: string
        acknowledged: number
        conflicted: number
      },
      [string, string]
    >(
      `SELECT control.response, receipt.message_id, receipt.text, receipt.description, receipt.metadata,
               receipt.acknowledged, receipt.conflicted
       FROM delegation_control control
       JOIN delegation_control_receipt receipt
         ON receipt.parent_id = control.parent_id AND receipt.invocation_id = control.invocation_id
       WHERE control.parent_id = ? AND control.invocation_id = ?`,
    )
    .get(parentID, invocationID)
  if (!row) throw new StorageError("store_corrupt", "Delegation Control record is missing")
  const response = jsonRecord(row.response)
  const retryBatchID = typeof response.retryBatchID === "string" ? response.retryBatchID : undefined
  const effect = controlEffect(response.effect)
  return {
    created,
    ...(retryBatchID === undefined ? {} : { retryBatchID }),
    ...(effect === undefined ? {} : { effect }),
    receipt: {
      key: invocationID,
      parentID,
      id: row.message_id,
      text: row.text,
      description: row.description,
      metadata: jsonRecord(row.metadata),
      delivery: "steer",
      resume: false,
      conflicted: row.conflicted === 1,
      acknowledged: row.acknowledged === 1,
    },
  }
}

function controlEffect(value: unknown): ControlRecord["effect"] {
  if (!value || typeof value !== "object" || !("kind" in value)) return undefined
  if (value.kind === "cancel" && "operationIDs" in value && Array.isArray(value.operationIDs)) {
    if (value.operationIDs.every((item) => typeof item === "string"))
      return { kind: "cancel", operationIDs: value.operationIDs }
    return undefined
  }
  if (
    value.kind === "steer" &&
    "operationID" in value &&
    typeof value.operationID === "string" &&
    "childID" in value &&
    typeof value.childID === "string" &&
    "messageID" in value &&
    typeof value.messageID === "string" &&
    "text" in value &&
    typeof value.text === "string"
  )
    return {
      kind: "steer",
      operationID: value.operationID,
      childID: value.childID,
      messageID: value.messageID,
      text: value.text,
    }
  return undefined
}

function nextSequence(
  database: Database,
  table: "delegation_batch" | "delegation_control",
  field: string,
  parentID: string,
) {
  return (
    database
      .query<
        { sequence: number },
        [string]
      >(`SELECT COALESCE(MAX(${field}), 0) + 1 AS sequence FROM ${table} WHERE parent_id = ?`)
      .get(parentID)?.sequence ?? 1
  )
}

async function verifyProfile(profile: string) {
  const marker = path.join(profile, "profile.json")
  if (!(await Bun.file(marker).exists())) {
    throw new StorageError("profile_uninitialized", "Delegation profile is not initialized")
  }
  try {
    const value: unknown = JSON.parse(await readFile(marker, "utf8"))
    if (!value || typeof value !== "object" || !("version" in value) || value.version !== PROFILE_VERSION) {
      throw new StorageError("profile_incompatible", "Delegation profile version is incompatible")
    }
  } catch (cause) {
    if (cause instanceof StorageError) throw cause
    throw new StorageError("profile_incompatible", "Delegation profile marker is invalid", { cause })
  }
}

async function openDatabase(store: string) {
  try {
    const database = new Database(store, { create: false, readwrite: true })
    try {
      verifyQuickCheck(database)
      verifySchema(database)
      database.exec("BEGIN IMMEDIATE; UPDATE delegation_meta SET value = value WHERE key = 'schema'; COMMIT;")
      return database
    } catch (cause) {
      database.close()
      throw cause
    }
  } catch (cause) {
    if (cause instanceof StorageError) throw cause
    throw new StorageError("store_unwritable", "Delegation coordinator store failed its write check", { cause })
  }
}

function verifyQuickCheck(database: Database) {
  try {
    const result = database.query<{ quick_check: string }, []>("PRAGMA quick_check").get()
    if (result?.quick_check !== "ok") {
      throw new StorageError("store_corrupt", "Delegation coordinator store failed SQLite quick_check")
    }
  } catch (cause) {
    if (cause instanceof StorageError) throw cause
    throw new StorageError("store_corrupt", "Delegation coordinator store failed SQLite quick_check", { cause })
  }
}

function verifySchema(database: Database) {
  const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()
  if (version?.user_version !== SCHEMA_VERSION) {
    throw new StorageError("store_incompatible", "Delegation coordinator store schema is incompatible")
  }
}

function migrateSchema(database: Database) {
  const version = database.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version
  if (version === SCHEMA_VERSION) return
  if (version === 7) {
    database.transaction(() => {
      const columns = new Set(
        database
          .query<{ name: string }, []>("PRAGMA table_info(delegation_operation)")
          .all()
          .map((column) => column.name),
      )
      const additions = {
        execution_ended_at: "INTEGER",
        execution_end_source: "TEXT CHECK (execution_end_source IN ('session_event', 'startup_reconciliation'))",
        terminal_reason_code:
          "TEXT CHECK (terminal_reason_code IN ('completed', 'execution_failed', 'setup_failed', 'cancelled_before_start', 'user_interrupted', 'child_deleted', 'prompt_admission_uncertain', 'service_restarted'))",
        recovery_reconciled_at: "INTEGER",
        recovery_eligible: "INTEGER NOT NULL DEFAULT 0 CHECK (recovery_eligible IN (0, 1))",
      }
      Object.entries(additions)
        .filter(([column]) => !columns.has(column))
        .forEach(([column, definition]) =>
          database.exec(`ALTER TABLE delegation_operation ADD COLUMN ${column} ${definition}`),
        )
      database.exec(`
        UPDATE delegation_operation
        SET execution_ended_at = CASE
              WHEN execution_started_at IS NULL THEN NULL
              WHEN terminal_reason = 'service restarted' THEN terminal_at
              ELSE COALESCE(completion_observed_at, terminal_at)
            END,
            execution_end_source = CASE
              WHEN execution_started_at IS NULL THEN NULL
              WHEN terminal_reason = 'service restarted' THEN 'startup_reconciliation'
              WHEN COALESCE(completion_observed_at, terminal_at) IS NOT NULL THEN 'session_event'
              ELSE NULL
            END,
            terminal_reason_code = CASE
              WHEN state = 'completed' THEN 'completed'
              WHEN terminal_reason = 'service restarted' THEN 'service_restarted'
              WHEN terminal_reason = 'cancelled before start' THEN 'cancelled_before_start'
              WHEN terminal_reason = 'prompt admission acknowledgement uncertain' THEN 'prompt_admission_uncertain'
              WHEN terminal_reason = 'child session deleted' THEN 'child_deleted'
              WHEN state = 'failed' AND execution_started_at IS NULL THEN 'setup_failed'
              WHEN state = 'failed' THEN 'execution_failed'
              ELSE 'user_interrupted'
            END,
            recovery_reconciled_at = CASE WHEN recovery_id IS NULL THEN NULL ELSE terminal_at END,
            recovery_eligible = CASE WHEN recovery_id IS NULL THEN 0 ELSE 1 END
        WHERE state IN ('completed', 'failed', 'interrupted');
        DROP TABLE IF EXISTS delegation_permission_wait;
        CREATE TABLE delegation_permission_wait (
          operation_id TEXT NOT NULL REFERENCES delegation_operation(id) ON DELETE CASCADE,
          sequence INTEGER NOT NULL,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          close_reason TEXT CHECK (close_reason IN ('replied', 'operation_concluded', 'service_restart')),
          PRIMARY KEY(operation_id, sequence),
          CHECK ((ended_at IS NULL AND close_reason IS NULL) OR (ended_at IS NOT NULL AND close_reason IS NOT NULL))
        );
        CREATE UNIQUE INDEX delegation_permission_wait_open
          ON delegation_permission_wait(operation_id) WHERE ended_at IS NULL;
        UPDATE delegation_meta SET value = '${SCHEMA_VERSION}' WHERE key = 'schema';
        PRAGMA user_version = ${SCHEMA_VERSION};
      `)
    })()
    return
  }
  if (version === 6) {
    database.transaction(() => {
      const tables = [
        "delegation_receipt",
        "delegation_terminal_report",
        "delegation_recovery",
        "delegation_control_receipt",
      ]
      tables
        .filter(
          (table) =>
            !database
              .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
              .all()
              .some((column) => column.name === "conflicted"),
        )
        .forEach((table) =>
          database.exec(
            `ALTER TABLE ${table} ADD COLUMN conflicted INTEGER NOT NULL DEFAULT 0 CHECK (conflicted IN (0, 1))`,
          ),
        )
      database.exec(`
        UPDATE delegation_meta SET value = '7' WHERE key = 'schema';
        PRAGMA user_version = 7;
      `)
    })()
    return migrateSchema(database)
  }
  if (version === 5) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE delegation_operation ADD COLUMN completion_observed_at INTEGER;
      UPDATE delegation_meta SET value = '6' WHERE key = 'schema';
      PRAGMA user_version = 6;
      COMMIT;
    `)
    return migrateSchema(database)
  }
  if (version === 4) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE delegation_operation ADD COLUMN retry_of_operation_id TEXT REFERENCES delegation_operation(id);
      ${controlSchema}
      UPDATE delegation_meta SET value = '5' WHERE key = 'schema';
      PRAGMA user_version = 5;
      COMMIT;
    `)
    return migrateSchema(database)
  }
  if (version === 2) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE delegation_operation RENAME TO delegation_operation_v2;
      CREATE TABLE delegation_operation (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL REFERENCES delegation_batch(id) ON DELETE CASCADE,
        operation_index INTEGER NOT NULL,
        operation_text TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'starting', 'running', 'waiting', 'completed', 'failed', 'interrupted')),
        child_id TEXT UNIQUE,
        prompt_id TEXT,
        prompt_admitted INTEGER NOT NULL DEFAULT 0 CHECK (prompt_admitted IN (0, 1)),
        cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
        permit_claimed_at INTEGER,
        execution_started_at INTEGER,
        terminal_at INTEGER,
        terminal_reason TEXT,
        UNIQUE(batch_id, operation_index)
      );
      INSERT INTO delegation_operation (id, batch_id, operation_index, operation_text, state)
      SELECT id, batch_id, operation_index, operation_text, state FROM delegation_operation_v2;
      DROP TABLE delegation_operation_v2;
       UPDATE delegation_meta SET value = '3' WHERE key = 'schema';
       PRAGMA user_version = 3;
       COMMIT;
    `)
    return migrateSchema(database)
  }
  if (version === 3) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE delegation_operation ADD COLUMN recovery_id TEXT;
      ALTER TABLE delegation_operation ADD COLUMN recovery_previous_state TEXT
        CHECK (recovery_previous_state IN ('starting', 'running', 'waiting'));
      ${deliverySchema}
      UPDATE delegation_meta SET value = '4' WHERE key = 'schema';
      PRAGMA user_version = 4;
      COMMIT;
    `)
    return migrateSchema(database)
  }
  if (version === 1) {
    database.exec(`
      BEGIN IMMEDIATE;
      ${admissionSchema}
      ${deliverySchema}
      ${controlSchema}
      UPDATE delegation_meta SET value = '${SCHEMA_VERSION}' WHERE key = 'schema';
      PRAGMA user_version = ${SCHEMA_VERSION};
      COMMIT;
    `)
    return
  }
  throw new StorageError("store_incompatible", "Delegation coordinator store schema is incompatible")
}

type BatchRow = {
  id: string
  parent_id: string
  admission_sequence: number
  agent_id: string
  provider_id: string
  model_id: string
  variant: string | null
  shared_context: string | null
  admitted_at: number
  message_id: string
  text: string
  description: string
  metadata: string
  delivery: string
  resume: number
  acknowledged: number
}

type OperationRow = {
  id: string
  batch_id: string
  parent_id: string
  operation_index: number
  operation_text: string
  state: OperationState
  agent_id: string
  provider_id: string
  model_id: string
  variant: string | null
  shared_context: string | null
  files: string
  agents: string
  skills: string
  child_id: string | null
  prompt_id: string | null
  prompt_admitted: number
  cancel_requested: number
  admitted_at: number
  permit_claimed_at: number | null
  execution_started_at: number | null
  execution_ended_at: number | null
  execution_end_source: ExecutionEndSource | null
  completion_observed_at: number | null
  terminal_at: number | null
  terminal_reason: string | null
  terminal_reason_code: TerminalReasonCode | null
  recovery_id: string | null
  recovery_reconciled_at: number | null
  recovery_eligible: number
  recovery_previous_state: "starting" | "running" | "waiting" | null
  retry_of_operation_id: string | null
}

type SnapshotRow = OperationRow & {
  admission_sequence: number
  fifo_position: number
  queue_position: number
  batch_operation_count: number
  batch_terminal_count: number
  batch_completed_count: number
  batch_failed_count: number
  batch_interrupted_count: number
  batch_started_at: number | null
  batch_concluded_at: number | null
  receipt_acknowledged: number
  receipt_conflicted: number
  terminal_acknowledged: number | null
  terminal_conflicted: number | null
  terminal_text: string | null
  terminal_metadata: string | null
  recovery_acknowledged: number | null
  recovery_conflicted: number | null
}

type SnapshotSummaryRow = {
  total: number
  queued: number
  starting: number
  running: number
  finalizing: number
  waiting: number
  completed: number
  failed: number
  interrupted: number
  cancellation_requested: number
  recovery_eligible: number
  actionable: number
  last_activity_at: number
}

type DeliveryRow = {
  delivery_key: string
  parent_id: string
  message_id: string
  text: string
  description: string
  metadata: string
  delivery: string
  resume: number
  conflicted: number
}

function operationRecord(row: OperationRow): OperationRecord {
  return {
    id: row.id,
    batchID: row.batch_id,
    parentID: row.parent_id,
    index: row.operation_index,
    text: row.operation_text,
    state: row.state,
    agent: row.agent_id,
    model: {
      providerID: row.provider_id,
      modelID: row.model_id,
      ...(row.variant === null ? {} : { variant: row.variant }),
    },
    ...(row.shared_context === null ? {} : { context: row.shared_context }),
    files: jsonFiles(row.files),
    agents: jsonAgents(row.agents),
    skills: jsonSkills(row.skills),
    ...(row.child_id === null ? {} : { childID: row.child_id }),
    ...(row.prompt_id === null ? {} : { promptID: row.prompt_id }),
    promptAdmitted: row.prompt_admitted === 1,
    cancellationRequested: row.cancel_requested === 1,
    admittedAt: row.admitted_at,
    ...(row.permit_claimed_at === null ? {} : { permitClaimedAt: row.permit_claimed_at }),
    ...(row.execution_started_at === null ? {} : { executionStartedAt: row.execution_started_at }),
    ...(row.execution_ended_at === null ? {} : { executionEndedAt: row.execution_ended_at }),
    ...(row.execution_end_source === null ? {} : { executionEndSource: row.execution_end_source }),
    ...(row.completion_observed_at === null ? {} : { completionObservedAt: row.completion_observed_at }),
    ...(row.terminal_at === null ? {} : { terminalAt: row.terminal_at }),
    ...(row.terminal_reason === null ? {} : { reason: row.terminal_reason }),
    ...(row.terminal_reason_code === null ? {} : { reasonCode: row.terminal_reason_code }),
    recoveryEligible: row.recovery_eligible === 1,
    ...(row.recovery_id === null ? {} : { recoveryID: row.recovery_id }),
    ...(row.recovery_reconciled_at === null ? {} : { recoveryReconciledAt: row.recovery_reconciled_at }),
    ...(row.recovery_previous_state === null ? {} : { recoveryPreviousState: row.recovery_previous_state }),
    ...(row.retry_of_operation_id === null ? {} : { retryOfOperationID: row.retry_of_operation_id }),
  }
}

function childHistoryDepth(database: Database, parentID: string, childID: string) {
  const operationID = database
    .query<{ id: string }, [string, string]>(
      `SELECT o.id FROM delegation_operation o JOIN delegation_batch b ON b.id = o.batch_id
       WHERE o.child_id = ? AND b.parent_id = ?`,
    )
    .get(childID, parentID)?.id
  return operationID ? operationHistoryDepth(database, parentID, operationID) : undefined
}

function operationHistoryDepth(database: Database, parentID: string, operationID: string) {
  return database
    .query<{ depth: number }, [string, string]>(
      `SELECT COUNT(*) AS depth
       FROM delegation_operation candidate
       JOIN delegation_batch candidate_batch ON candidate_batch.id = candidate.batch_id
       JOIN delegation_operation target ON target.id = ?
       JOIN delegation_batch target_batch ON target_batch.id = target.batch_id
       WHERE target_batch.parent_id = ? AND candidate_batch.parent_id = target_batch.parent_id
         AND (candidate_batch.admission_sequence > target_batch.admission_sequence
           OR (candidate_batch.admission_sequence = target_batch.admission_sequence
             AND candidate.operation_index <= target.operation_index))`,
    )
    .get(operationID, parentID)?.depth
}

function delegationSnapshot(database: Database, input: SnapshotQuery): DelegationSnapshot {
  const limit = input.limit ?? 50
  const cursor = input.cursor === undefined ? undefined : parseCursor(input.cursor, input.parentID)
  const conditions = [
    ...(input.batchID === undefined ? [] : ["batch_id = ?"]),
    ...(input.operationID === undefined ? [] : ["id = ?"]),
    ...(input.state === undefined ? [] : ["state = ?"]),
    ...(cursor === undefined ? [] : ["(admission_sequence < ? OR (admission_sequence = ? AND operation_index > ?))"]),
  ]
  const values: Array<string | number> = [
    input.parentID,
    ...(input.batchID === undefined ? [] : [input.batchID]),
    ...(input.operationID === undefined ? [] : [input.operationID]),
    ...(input.state === undefined ? [] : [input.state]),
    ...(cursor === undefined ? [] : [cursor.sequence, cursor.sequence, cursor.index]),
    limit + 1,
  ]
  const rows = database
    .query<SnapshotRow, Array<string | number>>(
      `WITH scoped AS (
         SELECT o.*, b.parent_id, b.admission_sequence, b.agent_id, b.provider_id, b.model_id, b.variant,
                b.shared_context, b.admitted_at, b.files, b.agents, b.skills,
                r.acknowledged AS receipt_acknowledged, r.conflicted AS receipt_conflicted,
                COUNT(*) OVER (PARTITION BY b.id) AS batch_operation_count,
                SUM(CASE WHEN o.state IN ('completed', 'failed', 'interrupted') THEN 1 ELSE 0 END)
                  OVER (PARTITION BY b.id) AS batch_terminal_count,
                SUM(CASE WHEN o.state = 'completed' THEN 1 ELSE 0 END)
                  OVER (PARTITION BY b.id) AS batch_completed_count,
                SUM(CASE WHEN o.state = 'failed' THEN 1 ELSE 0 END)
                  OVER (PARTITION BY b.id) AS batch_failed_count,
                SUM(CASE WHEN o.state = 'interrupted' THEN 1 ELSE 0 END)
                  OVER (PARTITION BY b.id) AS batch_interrupted_count,
                MIN(o.permit_claimed_at) OVER (PARTITION BY b.id) AS batch_started_at,
                MAX(o.terminal_at) OVER (PARTITION BY b.id) AS batch_concluded_at,
                ROW_NUMBER() OVER (ORDER BY b.admission_sequence, o.operation_index) AS fifo_position,
                SUM(CASE WHEN o.state = 'queued' THEN 1 ELSE 0 END)
                  OVER (ORDER BY b.admission_sequence, o.operation_index) AS queue_position
         FROM delegation_operation o
         JOIN delegation_batch b ON b.id = o.batch_id
         JOIN delegation_receipt r ON r.batch_id = b.id
         WHERE b.parent_id = ?
       )
       SELECT scoped.*, terminal.text AS terminal_text, terminal.metadata AS terminal_metadata,
              terminal.acknowledged AS terminal_acknowledged, terminal.conflicted AS terminal_conflicted,
              recovery.acknowledged AS recovery_acknowledged, recovery.conflicted AS recovery_conflicted
       FROM scoped
       LEFT JOIN delegation_terminal_report terminal ON terminal.operation_id = scoped.id
       LEFT JOIN delegation_recovery recovery
         ON recovery.recovery_id = scoped.recovery_id AND recovery.parent_id = scoped.parent_id
       ${conditions.length === 0 ? "" : `WHERE ${conditions.join(" AND ")}`}
       ORDER BY admission_sequence DESC, operation_index
       LIMIT ?`,
    )
    .all(...values)
  const page = rows.slice(0, limit)
  const batches = new Map<string, DelegationSnapshot["batches"][number]>()
  page.forEach((row) =>
    batches.set(row.batch_id, {
      id: row.batch_id,
      sequence: row.admission_sequence,
      admittedAt: row.admitted_at,
      ...(row.batch_started_at === null ? {} : { startedAt: row.batch_started_at }),
      ...(row.batch_terminal_count !== row.batch_operation_count || row.batch_concluded_at === null
        ? {}
        : { concludedAt: row.batch_concluded_at }),
      receiptDelivery: deliveryState(row.receipt_acknowledged, row.receipt_conflicted),
      status: row.batch_terminal_count === row.batch_operation_count ? "concluded" : "active",
      outcomes: {
        completed: row.batch_completed_count,
        failed: row.batch_failed_count,
        interrupted: row.batch_interrupted_count,
      },
    }),
  )
  const last = page.at(-1)
  return {
    version: 1,
    batches: [...batches.values()],
    operations: page.map((row) => ({
      ...operationRecord(row),
      permissionWaits: loadPermissionWaits(database, row.id),
      fifoPosition: row.fifo_position,
      queuePosition: row.queue_position,
      ...(row.terminal_acknowledged === null
        ? {}
        : { terminalDelivery: deliveryState(row.terminal_acknowledged, row.terminal_conflicted ?? 0) }),
      ...(row.recovery_acknowledged === null
        ? {}
        : { recoveryDelivery: deliveryState(row.recovery_acknowledged, row.recovery_conflicted ?? 0) }),
      ...(row.terminal_text === null || row.terminal_metadata === null
        ? {}
        : { terminalOutcome: { report: row.terminal_text, metadata: jsonRecord(row.terminal_metadata) } }),
    })),
    delivery: deliverySummary(database, input.parentID),
    summary: snapshotSummary(database, input.parentID),
    ...(rows.length <= limit || last === undefined
      ? {}
      : { nextCursor: renderCursor(input.parentID, last.admission_sequence, last.operation_index) }),
  }
}

function snapshotSummary(database: Database, parentID: string): DelegationSnapshot["summary"] {
  const activity =
    "COALESCE(o.terminal_at, o.completion_observed_at, o.execution_started_at, o.permit_claimed_at, b.admitted_at)"
  const summary = database
    .query<SnapshotSummaryRow, [string]>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN o.state = 'queued' THEN 1 ELSE 0 END) AS queued,
              SUM(CASE WHEN o.state NOT IN ('completed', 'failed', 'interrupted') AND o.state != 'waiting'
                        AND o.execution_ended_at IS NULL AND o.execution_started_at IS NULL
                        AND o.permit_claimed_at IS NOT NULL THEN 1 ELSE 0 END) AS starting,
              SUM(CASE WHEN o.state NOT IN ('completed', 'failed', 'interrupted') AND o.state != 'waiting'
                        AND o.execution_ended_at IS NULL AND o.execution_started_at IS NOT NULL THEN 1 ELSE 0 END) AS running,
              SUM(CASE WHEN o.state NOT IN ('completed', 'failed', 'interrupted')
                        AND o.execution_ended_at IS NOT NULL THEN 1 ELSE 0 END) AS finalizing,
              SUM(CASE WHEN o.state = 'waiting' AND o.execution_ended_at IS NULL THEN 1 ELSE 0 END) AS waiting,
              SUM(CASE WHEN o.state = 'completed' THEN 1 ELSE 0 END) AS completed,
              SUM(CASE WHEN o.state = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN o.state = 'interrupted' THEN 1 ELSE 0 END) AS interrupted,
              SUM(o.cancel_requested) AS cancellation_requested,
              SUM(o.recovery_eligible) AS recovery_eligible,
              SUM(CASE WHEN o.state NOT IN ('completed', 'failed', 'interrupted') OR o.recovery_eligible = 1
                       THEN 1 ELSE 0 END) AS actionable,
              MAX(${activity}) AS last_activity_at
       FROM delegation_operation o
       JOIN delegation_batch b ON b.id = o.batch_id
       WHERE b.parent_id = ?`,
    )
    .get(parentID)
  if (!summary) throw new StorageError("store_corrupt", `Delegation parent ${parentID} has no retained operations`)
  const newest = database
    .query<{ id: string; recovery_eligible: number; state: OperationState }, [string]>(
      `SELECT o.id, o.recovery_eligible, o.state
       FROM delegation_operation o
       JOIN delegation_batch b ON b.id = o.batch_id
       WHERE b.parent_id = ?
       ORDER BY ${activity} DESC, o.id
       LIMIT 1`,
    )
    .get(parentID)
  const newestActionable = database
    .query<{ id: string }, [string]>(
      `SELECT o.id
       FROM delegation_operation o
       JOIN delegation_batch b ON b.id = o.batch_id
       WHERE b.parent_id = ?
         AND (o.state NOT IN ('completed', 'failed', 'interrupted') OR o.recovery_eligible = 1)
       ORDER BY ${activity} DESC, o.id
       LIMIT 1`,
    )
    .get(parentID)
  return {
    total: summary.total,
    queued: summary.queued,
    starting: summary.starting,
    running: summary.running,
    finalizing: summary.finalizing,
    waiting: summary.waiting,
    completed: summary.completed,
    failed: summary.failed,
    interrupted: summary.interrupted,
    cancellationRequested: summary.cancellation_requested,
    recoveryEligible: summary.recovery_eligible,
    actionable: summary.actionable,
    lastActivityAt: summary.last_activity_at,
    ...(newest ? { newestOperationID: newest.id } : {}),
    ...(newestActionable ? { newestActionableOperationID: newestActionable.id } : {}),
  }
}

function parseCursor(value: string, parentID: string) {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString()) as unknown
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("parentID" in parsed) ||
      parsed.parentID !== parentID ||
      !("sequence" in parsed) ||
      !Number.isSafeInteger(parsed.sequence) ||
      !("index" in parsed) ||
      !Number.isSafeInteger(parsed.index)
    )
      throw new Error("invalid cursor")
    return { sequence: parsed.sequence as number, index: parsed.index as number }
  } catch {
    throw new StorageError("store_corrupt", "Delegation snapshot cursor is invalid")
  }
}

function renderCursor(parentID: string, sequence: number, index: number) {
  return Buffer.from(JSON.stringify({ version: 1, parentID, sequence, index })).toString("base64url")
}

function deliveryIntent(row: DeliveryRow): DeliveryIntent {
  return {
    key: row.delivery_key,
    parentID: row.parent_id,
    id: row.message_id,
    text: row.text,
    description: row.description,
    metadata: jsonRecord(row.metadata),
    delivery: "steer",
    resume: row.resume === 1,
    conflicted: row.conflicted === 1,
  }
}

function deliveryState(acknowledged: number, conflicted: number): DeliveryState {
  if (acknowledged === 1) return "acknowledged"
  if (conflicted === 1) return "conflicted"
  return "pending"
}

function deliverySummary(database: Database, parentID: string): DelegationSnapshot["delivery"] {
  const rows = database
    .query<{ kind: DeliveryKind; acknowledged: number; conflicted: number }, [string, string, string, string]>(
      `SELECT 'admission' AS kind, receipt.acknowledged, receipt.conflicted
       FROM delegation_receipt receipt JOIN delegation_batch batch ON batch.id = receipt.batch_id
       WHERE batch.parent_id = ?
       UNION ALL
       SELECT 'terminal', acknowledged, conflicted FROM delegation_terminal_report WHERE parent_id = ?
       UNION ALL
       SELECT 'recovery', acknowledged, conflicted FROM delegation_recovery WHERE parent_id = ?
       UNION ALL
       SELECT 'control', acknowledged, conflicted FROM delegation_control_receipt WHERE parent_id = ?`,
    )
    .all(parentID, parentID, parentID, parentID)
  const summary = () => ({ pending: 0, conflicted: 0 })
  const result: Record<DeliveryKind, { pending: number; conflicted: number }> = {
    admission: summary(),
    terminal: summary(),
    recovery: summary(),
    control: summary(),
  }
  rows.forEach((row) => {
    if (row.conflicted === 1) result[row.kind].conflicted++
    else if (row.acknowledged === 0) result[row.kind].pending++
  })
  return result
}

function loadOperation(database: Database, field: "o.id" | "o.child_id", value: string) {
  const row = database
    .query<OperationRow, [string]>(
      `SELECT o.*, b.parent_id, b.agent_id, b.provider_id, b.model_id, b.variant, b.shared_context, b.admitted_at,
              b.files, b.agents, b.skills
       FROM delegation_operation o
       JOIN delegation_batch b ON b.id = o.batch_id
       WHERE ${field} = ?`,
    )
    .get(value)
  return row ? operationRecord(row) : undefined
}

function loadParentOperations(database: Database, parentID: string) {
  return database
    .query<OperationRow, [string]>(
      `SELECT o.*, b.parent_id, b.agent_id, b.provider_id, b.model_id, b.variant, b.shared_context, b.admitted_at,
              b.files, b.agents, b.skills
       FROM delegation_operation o
       JOIN delegation_batch b ON b.id = o.batch_id
       WHERE b.parent_id = ?
       ORDER BY b.admission_sequence, o.operation_index`,
    )
    .all(parentID)
    .map(operationRecord)
}

function loadPermissionWaits(database: Database, operationID: string): ReadonlyArray<PermissionWait> {
  return database
    .query<
      { sequence: number; started_at: number; ended_at: number | null; close_reason: PermissionWaitCloseReason | null },
      [string]
    >(
      `SELECT sequence, started_at, ended_at, close_reason FROM delegation_permission_wait
       WHERE operation_id = ? ORDER BY sequence`,
    )
    .all(operationID)
    .map((row) => ({
      sequence: row.sequence,
      startedAt: row.started_at,
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      ...(row.close_reason === null ? {} : { closeReason: row.close_reason }),
    }))
}

function closePermissionWait(
  database: Database,
  operationID: string,
  endedAt: number,
  reason: PermissionWaitCloseReason,
) {
  const open = database
    .query<
      { sequence: number; started_at: number },
      [string]
    >("SELECT sequence, started_at FROM delegation_permission_wait WHERE operation_id = ? AND ended_at IS NULL")
    .get(operationID)
  if (!open) return false
  database
    .query(
      `UPDATE delegation_permission_wait SET ended_at = ?, close_reason = ?
       WHERE operation_id = ? AND sequence = ? AND ended_at IS NULL`,
    )
    .run(normalizeTime(endedAt, open.started_at), reason, operationID, open.sequence)
  return true
}

function normalizeTime(value: number, ...floors: ReadonlyArray<number | undefined>) {
  return Math.max(value, ...floors.filter((floor): floor is number => floor !== undefined))
}

function inferReasonCode(state: OperationState, operation: OperationRecord): TerminalReasonCode {
  if (state === "completed") return "completed"
  if (state === "failed") return operation.executionStartedAt === undefined ? "setup_failed" : "execution_failed"
  return "user_interrupted"
}

function terminal(state: OperationState) {
  return state === "completed" || state === "failed" || state === "interrupted"
}

function transitionOperation(
  database: Database,
  operationID: string,
  expected: ReadonlyArray<OperationState>,
  state: OperationState,
  patch: TransitionPatch,
) {
  if (expected.length === 0) return false
  return database.transaction(() => {
    const current = loadOperation(database, "o.id", operationID)
    if (!current || terminal(current.state) || !expected.includes(current.state)) return false
    const executionStartedAt =
      patch.executionStartedAt === undefined
        ? undefined
        : normalizeTime(patch.executionStartedAt, current.permitClaimedAt, current.admittedAt)
    const executionEndedAt =
      patch.executionEndedAt === undefined
        ? undefined
        : normalizeTime(
            patch.executionEndedAt,
            current.executionStartedAt,
            executionStartedAt,
            current.permitClaimedAt,
            current.admittedAt,
          )
    const permissionWaitStartedAt = terminal(state)
      ? database
          .query<
            { started_at: number },
            [string]
          >("SELECT started_at FROM delegation_permission_wait WHERE operation_id = ? AND ended_at IS NULL")
          .get(operationID)?.started_at
      : undefined
    const terminalAt =
      patch.terminalAt === undefined
        ? undefined
        : normalizeTime(
            patch.terminalAt,
            current.executionEndedAt,
            executionEndedAt,
            current.executionStartedAt,
            executionStartedAt,
            permissionWaitStartedAt,
            current.permitClaimedAt,
            current.admittedAt,
          )
    const values: Array<string | number | null> = [state]
    const immutable = new Set([
      "execution_started_at",
      "execution_ended_at",
      "execution_end_source",
      "completion_observed_at",
      "terminal_at",
      "terminal_reason",
      "terminal_reason_code",
    ])
    const changes = Object.entries({
      child_id: patch.childID,
      prompt_id: patch.promptID,
      prompt_admitted: patch.promptAdmitted === undefined ? undefined : Number(patch.promptAdmitted),
      execution_started_at: executionStartedAt,
      execution_ended_at: executionEndedAt,
      execution_end_source: patch.executionEndSource,
      completion_observed_at: patch.completionObservedAt,
      terminal_at: terminalAt,
      terminal_reason: patch.reason,
      terminal_reason_code: patch.reasonCode ?? (terminal(state) ? inferReasonCode(state, current) : undefined),
    }).flatMap(([column, value]) => {
      if (value === undefined) return []
      values.push(value)
      return [`${column} = ${immutable.has(column) ? `COALESCE(${column}, ?)` : "?"}`]
    })
    values.push(operationID, ...expected)
    const placeholders = expected.map(() => "?").join(", ")
    if (
      database
        .query(
          `UPDATE delegation_operation SET ${["state = ?", ...changes].join(", ")} WHERE id = ? AND state IN (${placeholders})`,
        )
        .run(...values).changes !== 1
    )
      return false
    if (!terminal(state)) return true
    const operation = loadOperation(database, "o.id", operationID)
    if (!operation) throw new StorageError("store_corrupt", `Delegation operation is missing: ${operationID}`)
    const sequence =
      database
        .query<
          { sequence: number },
          [string]
        >("SELECT COALESCE(MAX(report_sequence), 0) + 1 AS sequence FROM delegation_terminal_report WHERE parent_id = ?")
        .get(operation.parentID)?.sequence ?? 1
    closePermissionWait(
      database,
      operation.id,
      operation.terminalAt ?? terminalAt ?? operation.admittedAt,
      "operation_concluded",
    )
    const metadata = terminalMetadata(operation)
    const outcome =
      state === "completed" ? patch.outcome || "Child completed without a final response." : (operation.reason ?? state)
    database
      .query<never, [string, string, string, number, string, string, string]>(
        `INSERT INTO delegation_terminal_report
          (operation_id, parent_id, message_id, report_sequence, text, description, metadata, delivery, resume, acknowledged)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'steer', 1, 0)`,
      )
      .run(
        operation.id,
        operation.parentID,
        deterministicID(`delegation-terminal-v1\0${operation.parentID}\0${operation.id}`),
        sequence,
        renderTerminal(operation, outcome),
        operation.text,
        JSON.stringify(metadata),
      )
    return true
  })()
}

function terminalMetadata(operation: OperationRecord) {
  return {
    source: "delegation",
    kind: "terminal-outcome",
    version: 1,
    parentID: operation.parentID,
    batchID: operation.batchID,
    operationID: operation.id,
    ...(operation.childID === undefined ? {} : { childID: operation.childID }),
    operationIndex: operation.index,
    operationText: operation.text,
    agent: operation.agent,
    model: operation.model,
    state: operation.state,
    time: {
      admitted: operation.admittedAt,
      ...(operation.permitClaimedAt === undefined ? {} : { permitClaimed: operation.permitClaimedAt }),
      ...(operation.executionStartedAt === undefined ? {} : { executionStarted: operation.executionStartedAt }),
      ...(operation.executionEndedAt === undefined ? {} : { executionEnded: operation.executionEndedAt }),
      ...(operation.terminalAt === undefined ? {} : { terminal: operation.terminalAt }),
    },
    ...(operation.executionEndSource === undefined ? {} : { executionEndSource: operation.executionEndSource }),
    ...(operation.reasonCode === undefined ? {} : { reasonCode: operation.reasonCode }),
    ...(operation.state === "completed" || operation.reason === undefined ? {} : { reason: operation.reason }),
  }
}

function renderTerminal(operation: OperationRecord, outcome: string) {
  return `<delegation batch="${xml(operation.batchID)}" operation="${xml(operation.text)}"${
    operation.childID === undefined ? "" : ` child="${xml(operation.childID)}"`
  } state="${operation.state}">\n${outcome}\n</delegation>`
}

function reconcileStartup(database: Database, reconciledAt: number) {
  database.transaction(() => {
    const active = loadActive(database).filter((operation) => operation.completionObservedAt === undefined)
    const queued = database
      .query<{ parent_id: string; count: number; receipt_pending_count: number }, []>(
        `SELECT b.parent_id, COUNT(*) AS count,
                SUM(CASE WHEN r.acknowledged = 0 THEN 1 ELSE 0 END) AS receipt_pending_count
         FROM delegation_operation o
         JOIN delegation_batch b ON b.id = o.batch_id
         JOIN delegation_receipt r ON r.batch_id = b.id
         WHERE o.state = 'queued'
         GROUP BY b.parent_id`,
      )
      .all()
    const parents = new Set([...active.map((operation) => operation.parentID), ...queued.map((row) => row.parent_id)])
    if (parents.size === 0) return
    const pending = new Set(
      database
        .query<{ parent_id: string }, []>("SELECT parent_id FROM delegation_recovery WHERE acknowledged = 0")
        .all()
        .map((row) => row.parent_id),
    )
    const recoveryID = `rcv_${randomUUID().replaceAll("-", "")}`
    const update = database.query<
      never,
      [number, number | null, ExecutionEndSource | null, string, number, string, string]
    >(
      `UPDATE delegation_operation
       SET state = 'interrupted', terminal_at = ?, execution_ended_at = COALESCE(execution_ended_at, ?),
            execution_end_source = COALESCE(execution_end_source, ?), terminal_reason = 'service restarted',
            terminal_reason_code = 'service_restarted', recovery_id = ?, recovery_reconciled_at = ?,
            recovery_eligible = 1, recovery_previous_state = ?
       WHERE id = ? AND state IN ('starting', 'running', 'waiting')`,
    )
    active.forEach((operation) => {
      const concludedAt = normalizeTime(
        reconciledAt,
        operation.executionStartedAt,
        operation.permitClaimedAt,
        operation.admittedAt,
      )
      closePermissionWait(database, operation.id, concludedAt, "service_restart")
      update.run(
        concludedAt,
        operation.executionStartedAt === undefined ? null : concludedAt,
        operation.executionStartedAt === undefined ? null : "startup_reconciliation",
        recoveryID,
        concludedAt,
        operation.state,
        operation.id,
      )
    })
    parents.forEach((parentID) => {
      const interrupted = active.filter((operation) => operation.parentID === parentID)
      if (interrupted.length === 0 && pending.has(parentID)) return
      const waiting = queued.find((row) => row.parent_id === parentID)
      const sequence =
        database
          .query<
            { sequence: number },
            [string]
          >("SELECT COALESCE(MAX(recovery_sequence), 0) + 1 AS sequence FROM delegation_recovery WHERE parent_id = ?")
          .get(parentID)?.sequence ?? 1
      const metadata = recoveryMetadata(parentID, recoveryID, interrupted, waiting, reconciledAt)
      database
        .query<never, [string, string, number, string, string, string, string]>(
          `INSERT INTO delegation_recovery
            (recovery_id, parent_id, recovery_sequence, message_id, text, description, metadata, delivery, resume, acknowledged)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'steer', 0, 0)`,
        )
        .run(
          recoveryID,
          parentID,
          sequence,
          deterministicID(`delegation-recovery-v1\0${parentID}\0${recoveryID}`),
          renderRecovery(interrupted, waiting?.count ?? 0),
          "Delegation recovered",
          JSON.stringify(metadata),
        )
    })
  })()
}

function loadActive(database: Database) {
  return database
    .query<OperationRow, []>(
      `SELECT o.*, b.parent_id, b.agent_id, b.provider_id, b.model_id, b.variant, b.shared_context, b.admitted_at,
              b.files, b.agents, b.skills
       FROM delegation_operation o JOIN delegation_batch b ON b.id = o.batch_id
       WHERE o.state IN ('starting', 'running', 'waiting')
       ORDER BY b.parent_id, b.admission_sequence, o.operation_index`,
    )
    .all()
    .map(operationRecord)
}

function recoveryMetadata(
  parentID: string,
  recoveryID: string,
  interrupted: ReadonlyArray<OperationRecord>,
  queued: { readonly count: number; readonly receipt_pending_count: number } | undefined,
  reconciledAt: number,
) {
  return {
    source: "delegation",
    kind: "recovery-notice",
    version: 1,
    parentID,
    recoveryID,
    interrupted: interrupted.map((operation) => ({
      batchID: operation.batchID,
      operationID: operation.id,
      operationIndex: operation.index,
      operationText: operation.text,
      ...(operation.childID === undefined ? {} : { childID: operation.childID }),
      previousState: operation.state,
      reason: "service restarted",
    })),
    queued: { count: queued?.count ?? 0, receiptPendingCount: queued?.receipt_pending_count ?? 0 },
    time: { reconciled: reconciledAt },
  }
}

function renderRecovery(interrupted: ReadonlyArray<OperationRecord>, queued: number) {
  return [
    '<delegation-recovery reason="service restarted">',
    ...interrupted.map(
      (operation) =>
        `<operation batch="${xml(operation.batchID)}" id="${xml(operation.id)}" index="${operation.index}" previous-state="${operation.state}"${
          operation.childID === undefined ? "" : ` child="${xml(operation.childID)}"`
        }>${xml(operation.text)}</operation>`,
    ),
    "Interrupted child Sessions may contain completed output; inspect them before retrying.",
    `Queued operations: ${queued}. They resume only after this notice and all required admission receipts are durably delivered.`,
    "</delegation-recovery>",
  ].join("\n")
}

function deterministicID(value: string) {
  return "msg_" + createHash("sha256").update(value).digest("hex")
}

function loadAdmission(database: Database, batchID: string, created: boolean): AdmissionRecord {
  const batch = database
    .query<BatchRow, [string]>(
      `SELECT b.id, b.parent_id, b.admission_sequence, b.agent_id, b.provider_id, b.model_id, b.variant,
              b.shared_context, b.admitted_at, r.message_id, r.text, r.description, r.metadata, r.delivery,
              r.resume, r.acknowledged
       FROM delegation_batch b JOIN delegation_receipt r ON r.batch_id = b.id WHERE b.id = ?`,
    )
    .get(batchID)
  if (!batch) throw new StorageError("store_corrupt", `Delegation batch is missing: ${batchID}`)
  const operations = database
    .query<{ id: string; operation_index: number; operation_text: string; state: string }, [string]>(
      "SELECT id, operation_index, operation_text, state FROM delegation_operation WHERE batch_id = ? ORDER BY operation_index",
    )
    .all(batchID)
    .map((operation) => ({
      id: operation.id,
      index: operation.operation_index,
      text: operation.operation_text,
      state: "queued" as const,
    }))
  return {
    created,
    batch: {
      id: batch.id,
      parentID: batch.parent_id,
      sequence: batch.admission_sequence,
      agent: batch.agent_id,
      model: {
        providerID: batch.provider_id,
        modelID: batch.model_id,
        ...(batch.variant === null ? {} : { variant: batch.variant }),
      },
      ...(batch.shared_context === null ? {} : { context: batch.shared_context }),
      admittedAt: batch.admitted_at,
      operations,
    },
    receipt: {
      id: batch.message_id,
      text: batch.text,
      description: "Delegation admitted",
      metadata: jsonRecord(batch.metadata),
      delivery: "steer",
      resume: false,
      acknowledged: batch.acknowledged === 1,
    },
  }
}

function receiptMetadata(
  request: AdmissionRequest,
  batchID: string,
  operations: AdmissionRecord["batch"]["operations"],
) {
  return {
    source: "delegation",
    kind: "admission-receipt",
    version: 1,
    parentID: request.parentID,
    batchID,
    agent: request.agent,
    model: request.model,
    operations: operations.map((operation) => ({
      operationID: operation.id,
      operationIndex: operation.index,
      operationText: operation.text,
      state: operation.state,
    })),
    time: { admitted: request.admittedAt },
  }
}

function renderReceipt(batchID: string, operations: AdmissionRecord["batch"]["operations"]) {
  return [
    `<delegation batch="${xml(batchID)}" state="queued">`,
    ...operations.map(
      (operation) =>
        `<operation id="${xml(operation.id)}" index="${operation.index}">${xml(operation.text)}</operation>`,
    ),
    "</delegation>",
  ].join("\n")
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

function jsonRecord(value: string) {
  try {
    return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(value))
  } catch (cause) {
    throw new StorageError("store_corrupt", "Delegation receipt metadata is invalid", { cause })
  }
}

function jsonFiles(value: string) {
  try {
    return Schema.decodeUnknownSync(Schema.Array(PromptInput.FileAttachment))(JSON.parse(value))
  } catch (cause) {
    throw new StorageError("store_corrupt", "Delegation operation envelope is invalid", { cause })
  }
}

function jsonAgents(value: string) {
  try {
    return Schema.decodeUnknownSync(Schema.Array(AgentAttachment))(JSON.parse(value))
  } catch (cause) {
    throw new StorageError("store_corrupt", "Delegation operation envelope is invalid", { cause })
  }
}

function jsonSkills(value: string) {
  try {
    return Schema.decodeUnknownSync(Schema.Array(PromptInput.SkillAttachment))(JSON.parse(value))
  } catch (cause) {
    throw new StorageError("store_corrupt", "Delegation operation envelope is invalid", { cause })
  }
}

const admissionSchema = `
  CREATE TABLE delegation_batch (
    id TEXT PRIMARY KEY,
    parent_id TEXT NOT NULL,
    invocation_id TEXT,
    canonical_request TEXT NOT NULL,
    admission_sequence INTEGER NOT NULL,
    agent_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    model_id TEXT NOT NULL,
    variant TEXT,
    shared_context TEXT,
    files TEXT NOT NULL,
    agents TEXT NOT NULL,
    skills TEXT NOT NULL,
    admitted_at INTEGER NOT NULL,
    UNIQUE(parent_id, invocation_id),
    UNIQUE(parent_id, admission_sequence)
  );
  CREATE TABLE delegation_operation (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES delegation_batch(id) ON DELETE CASCADE,
    operation_index INTEGER NOT NULL,
    operation_text TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'starting', 'running', 'waiting', 'completed', 'failed', 'interrupted')),
    child_id TEXT UNIQUE,
    prompt_id TEXT,
    prompt_admitted INTEGER NOT NULL DEFAULT 0 CHECK (prompt_admitted IN (0, 1)),
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    permit_claimed_at INTEGER,
    execution_started_at INTEGER,
    execution_ended_at INTEGER,
    execution_end_source TEXT CHECK (execution_end_source IN ('session_event', 'startup_reconciliation')),
    completion_observed_at INTEGER,
    terminal_at INTEGER,
    terminal_reason TEXT,
    terminal_reason_code TEXT CHECK (terminal_reason_code IN ('completed', 'execution_failed', 'setup_failed',
      'cancelled_before_start', 'user_interrupted', 'child_deleted', 'prompt_admission_uncertain', 'service_restarted')),
    recovery_id TEXT,
    recovery_reconciled_at INTEGER,
    recovery_eligible INTEGER NOT NULL DEFAULT 0 CHECK (recovery_eligible IN (0, 1)),
    recovery_previous_state TEXT CHECK (recovery_previous_state IN ('starting', 'running', 'waiting')),
    retry_of_operation_id TEXT REFERENCES delegation_operation(id),
    UNIQUE(batch_id, operation_index)
  );
  CREATE TABLE delegation_permission_wait (
    operation_id TEXT NOT NULL REFERENCES delegation_operation(id) ON DELETE CASCADE,
    sequence INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    close_reason TEXT CHECK (close_reason IN ('replied', 'operation_concluded', 'service_restart')),
    PRIMARY KEY(operation_id, sequence),
    CHECK ((ended_at IS NULL AND close_reason IS NULL) OR (ended_at IS NOT NULL AND close_reason IS NOT NULL))
  );
  CREATE UNIQUE INDEX delegation_permission_wait_open
    ON delegation_permission_wait(operation_id) WHERE ended_at IS NULL;
  CREATE TABLE delegation_receipt (
    batch_id TEXT PRIMARY KEY REFERENCES delegation_batch(id) ON DELETE CASCADE,
    message_id TEXT NOT NULL UNIQUE,
    receipt_sequence INTEGER NOT NULL,
    text TEXT NOT NULL,
    description TEXT NOT NULL,
    metadata TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery = 'steer'),
    resume INTEGER NOT NULL CHECK (resume = 0),
    acknowledged INTEGER NOT NULL CHECK (acknowledged IN (0, 1)),
    conflicted INTEGER NOT NULL DEFAULT 0 CHECK (conflicted IN (0, 1))
  );
`

const deliverySchema = `
  CREATE TABLE delegation_terminal_report (
    operation_id TEXT PRIMARY KEY REFERENCES delegation_operation(id) ON DELETE CASCADE,
    parent_id TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    report_sequence INTEGER NOT NULL,
    text TEXT NOT NULL,
    description TEXT NOT NULL,
    metadata TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery = 'steer'),
    resume INTEGER NOT NULL CHECK (resume = 1),
    acknowledged INTEGER NOT NULL CHECK (acknowledged IN (0, 1)),
    conflicted INTEGER NOT NULL DEFAULT 0 CHECK (conflicted IN (0, 1)),
    UNIQUE(parent_id, report_sequence)
  );
  CREATE TABLE delegation_recovery (
    recovery_id TEXT NOT NULL,
    parent_id TEXT NOT NULL,
    recovery_sequence INTEGER NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    description TEXT NOT NULL,
    metadata TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery = 'steer'),
    resume INTEGER NOT NULL CHECK (resume = 0),
    acknowledged INTEGER NOT NULL CHECK (acknowledged IN (0, 1)),
    conflicted INTEGER NOT NULL DEFAULT 0 CHECK (conflicted IN (0, 1)),
    PRIMARY KEY(recovery_id, parent_id),
    UNIQUE(parent_id, recovery_sequence)
  );
`

const controlSchema = `
  CREATE TABLE delegation_control (
    parent_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    canonical_request TEXT NOT NULL,
    control_sequence INTEGER NOT NULL,
    action TEXT NOT NULL,
    response TEXT NOT NULL,
    committed_at INTEGER NOT NULL,
    PRIMARY KEY(parent_id, invocation_id),
    UNIQUE(parent_id, control_sequence)
  );
  CREATE TABLE delegation_control_receipt (
    parent_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    text TEXT NOT NULL,
    description TEXT NOT NULL,
    metadata TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery = 'steer'),
    resume INTEGER NOT NULL CHECK (resume = 0),
    acknowledged INTEGER NOT NULL CHECK (acknowledged IN (0, 1)),
    conflicted INTEGER NOT NULL DEFAULT 0 CHECK (conflicted IN (0, 1)),
    PRIMARY KEY(parent_id, invocation_id),
    FOREIGN KEY(parent_id, invocation_id) REFERENCES delegation_control(parent_id, invocation_id) ON DELETE CASCADE
  );
`

async function claimOwner(store: string) {
  const directory = `${store}.owner`
  const token = randomUUID()
  const claim = async () => {
    await mkdir(directory)
    await Bun.write(path.join(directory, "owner.json"), JSON.stringify({ pid: process.pid, token }))
  }

  try {
    await claim()
  } catch (cause) {
    if (!hasCode(cause, "EEXIST")) {
      throw new StorageError("store_unwritable", "Cannot claim Delegation coordinator ownership", { cause })
    }
    const owner = await ownerRecord(directory)
    if (owner === undefined && !(await staleGuard(directory))) {
      throw new StorageError("store_owned", "Delegation coordinator ownership is being initialized")
    }
    if (owner !== undefined && processAlive(owner.pid)) {
      throw new StorageError("store_owned", "Delegation coordinator store is owned by another runtime")
    }
    const reclaim = `${directory}.reclaim`
    try {
      await mkdir(reclaim)
    } catch (reclaimCause) {
      if (!(await staleGuard(reclaim)))
        throw new StorageError("store_owned", "Delegation coordinator ownership is being reclaimed", {
          cause: reclaimCause,
        })
      await rm(reclaim, { recursive: true, force: true })
      try {
        await mkdir(reclaim)
      } catch (retryCause) {
        throw new StorageError("store_owned", "Delegation coordinator ownership changed while recovering", {
          cause: retryCause,
        })
      }
    }
    try {
      const current = await ownerRecord(directory)
      if (
        (current === undefined && !(await staleGuard(directory))) ||
        (current !== undefined && processAlive(current.pid))
      )
        throw new StorageError("store_owned", "Delegation coordinator ownership changed while recovering")
      await rm(directory, { recursive: true, force: true })
      try {
        await claim()
      } catch (retryCause) {
        throw new StorageError("store_owned", "Delegation coordinator ownership changed while recovering", {
          cause: retryCause,
        })
      }
    } finally {
      await rm(reclaim, { recursive: true, force: true })
    }
  }

  return {
    async check() {
      const owner = await ownerRecord(directory)
      if (owner?.pid !== process.pid || owner.token !== token)
        throw new StorageError("store_owned", "Delegation coordinator ownership was lost")
    },
    async release() {
      const owner = await ownerRecord(directory)
      if (owner?.pid !== process.pid || owner.token !== token) return
      await rm(directory, { recursive: true, force: true })
    },
  }
}

async function staleGuard(target: string) {
  try {
    return Date.now() - (await stat(target)).mtimeMs >= OWNER_INITIALIZATION_GRACE
  } catch {
    return true
  }
}

async function ownerRecord(directory: string) {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(directory, "owner.json"), "utf8"))
    if (value && typeof value === "object" && "pid" in value && typeof value.pid === "number")
      return {
        pid: value.pid,
        ...("token" in value && typeof value.token === "string" ? { token: value.token } : {}),
      }
  } catch {}
  return undefined
}

function processAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function hasCode(cause: unknown, code: string) {
  return cause instanceof Error && "code" in cause && cause.code === code
}

import type { LocationRef } from "@opencode-ai/client"
import {
  supervisionView,
  type Filters,
  type ParentSummary,
  type ProjectedOperation,
  type WorkspaceResult,
} from "./supervision.js"

export type ScrollAnchor = {
  readonly itemID: string
  readonly offset: number
}

export type PresentationState = {
  readonly filters: Filters
  readonly selectedParentID?: string
  readonly selectedOperationID?: string
  readonly paneSizes: {
    readonly wide: { readonly parents?: number; readonly inspector?: number }
    readonly medium: { readonly inspector?: number }
    readonly narrow: Record<string, never>
  }
  readonly listAnchors: Readonly<Record<string, ScrollAnchor | undefined>>
  readonly detailAnchors: Readonly<Record<string, ScrollAnchor | undefined>>
  readonly detailOrder: Readonly<Record<string, ReadonlyArray<string> | undefined>>
  readonly parentOrder: ReadonlyArray<string>
  readonly operationOrder: Readonly<Record<string, ReadonlyArray<string> | undefined>>
}

export type PresentationMemory = {
  locations: Record<string, PresentationState | undefined>
}

export function emptyPresentationState(): PresentationState {
  return {
    filters: { search: "", actionableOnly: false },
    paneSizes: { wide: {}, medium: {}, narrow: {} },
    listAnchors: {},
    detailAnchors: {},
    detailOrder: {},
    parentOrder: [],
    operationOrder: {},
  }
}

export function locationIdentity(location: LocationRef) {
  return JSON.stringify([location.directory, location.workspaceID ?? null])
}

export function sanitizePresentationState(value: unknown, width = Number.MAX_SAFE_INTEGER): PresentationState {
  if (!record(value)) return emptyPresentationState()
  const filters = record(value.filters) ? value.filters : {}
  const paneSizes = record(value.paneSizes) ? value.paneSizes : {}
  const wide = record(paneSizes.wide) ? paneSizes.wide : {}
  const medium = record(paneSizes.medium) ? paneSizes.medium : {}
  return {
    filters: {
      search: typeof filters.search === "string" ? filters.search : "",
      actionableOnly: typeof filters.actionableOnly === "boolean" ? filters.actionableOnly : false,
    },
    ...(typeof value.selectedParentID === "string" ? { selectedParentID: value.selectedParentID } : {}),
    ...(typeof value.selectedOperationID === "string" ? { selectedOperationID: value.selectedOperationID } : {}),
    paneSizes: {
      wide: {
        ...dimension(wide.parents, width, "parents"),
        ...dimension(wide.inspector, width, "inspector"),
      },
      medium: dimension(medium.inspector, width, "inspector"),
      narrow: {},
    },
    listAnchors: anchors(value.listAnchors),
    detailAnchors: anchors(value.detailAnchors),
    detailOrder: record(value.detailOrder)
      ? Object.fromEntries(Object.entries(value.detailOrder).map(([key, order]) => [key, strings(order)]))
      : {},
    parentOrder: strings(value.parentOrder),
    operationOrder: record(value.operationOrder)
      ? Object.fromEntries(Object.entries(value.operationOrder).map(([key, order]) => [key, strings(order)]))
      : {},
  }
}

export function reconcilePresentationState(
  input: PresentationState,
  parents: ReadonlyArray<ParentSummary>,
  entrySessionID?: string,
) {
  return reconcileSelection(input, parents, entrySessionID ? explicitSelection(parents, entrySessionID) : undefined)
}

export function revealOperation(input: PresentationState, parents: ReadonlyArray<ParentSummary>, operationID: string) {
  const parent = parents.find((candidate) => candidate.operations.some((operation) => operation.id === operationID))
  return reconcileSelection(input, parents, parent ? { parentID: parent.session.id, operationID } : undefined)
}

export function retryForOperation(parents: ReadonlyArray<ParentSummary>, operationID: string) {
  return parents
    .flatMap((parent) => parent.operations)
    .find((operation) => operation.retryOfOperationID === operationID)
}

function reconcileSelection(
  input: PresentationState,
  parents: ReadonlyArray<ParentSummary>,
  explicit: { readonly parentID: string; readonly operationID?: string } | undefined,
) {
  const restored = sanitizePresentationState(input)
  const adjustedFilters: Array<keyof Filters> = []
  const searchExcludes =
    explicit &&
    restored.filters.search !== "" &&
    !selectionVisible(parents, { search: restored.filters.search, actionableOnly: false }, explicit)
  if (searchExcludes) adjustedFilters.push("search")
  const actionableExcludes =
    explicit &&
    restored.filters.actionableOnly &&
    !selectionVisible(parents, { search: "", actionableOnly: true }, explicit)
  if (actionableExcludes) adjustedFilters.push("actionableOnly")
  const filters = {
    search: searchExcludes ? "" : restored.filters.search,
    actionableOnly: actionableExcludes ? false : restored.filters.actionableOnly,
  }
  const visible = visibleParents(parents, filters)
  const requestedParentID = explicit?.parentID ?? restored.selectedParentID
  const selectedParent = visible.find((parent) => parent.session.id === requestedParentID) ?? fallbackParent(visible)
  const requestedOperationID = explicit?.operationID ?? restored.selectedOperationID
  const selectedOperationID = selectedParent
    ? selectedParent.operations.some((operation) => operation.id === requestedOperationID)
      ? requestedOperationID
      : (nearest(
          restored.operationOrder[selectedParent.session.id] ?? [],
          requestedOperationID,
          selectedParent.operations.map((item) => item.id),
        ) ??
        [selectedParent.newestActionableOperationID, selectedParent.newestOperationID].find((id) =>
          selectedParent.operations.some((operation) => operation.id === id),
        ) ??
        selectedParent.operations[0]?.id)
    : undefined
  const visibleOperations = new Map(
    visible.flatMap((parent) => parent.operations.map((operation) => [operation.id, operation] as const)),
  )
  const listAnchors = Object.fromEntries(
    visible.flatMap((parent) => {
      const anchor = restored.listAnchors[parent.session.id]
      if (!anchor) return []
      const ids = parent.operations.map((operation) => operation.id)
      const itemID = ids.includes(anchor.itemID)
        ? anchor.itemID
        : nearest(restored.operationOrder[parent.session.id] ?? [], anchor.itemID, ids)
      return itemID ? [[parent.session.id, { itemID, offset: clampOffset(anchor.offset) }]] : []
    }),
  )
  const detailAnchors = Object.fromEntries(
    Object.entries(restored.detailAnchors).flatMap(([operationID, anchor]) => {
      const operation = visibleOperations.get(operationID)
      if (!anchor || !operation) return []
      const ids = inspectorItems(operation)
      const itemID = ids.includes(anchor.itemID)
        ? anchor.itemID
        : (nearest(restored.detailOrder[operationID] ?? [], anchor.itemID, ids) ?? ids[0])
      return itemID ? [[operationID, { itemID, offset: clampOffset(anchor.offset) }]] : []
    }),
  )
  return {
    adjustedFilters,
    state: {
      ...restored,
      filters,
      ...(selectedParent ? { selectedParentID: selectedParent.session.id } : { selectedParentID: undefined }),
      ...(selectedOperationID ? { selectedOperationID } : { selectedOperationID: undefined }),
      listAnchors,
      detailAnchors,
      detailOrder: Object.fromEntries(
        [...visibleOperations.entries()].map(([operationID, operation]) => [operationID, inspectorItems(operation)]),
      ),
      parentOrder: visible.map((parent) => parent.session.id),
      operationOrder: Object.fromEntries(
        visible.map((parent) => [parent.session.id, parent.operations.map((operation) => operation.id)]),
      ),
    },
  }
}

function visibleParents(parents: ReadonlyArray<ParentSummary>, filters: Filters) {
  const result: WorkspaceResult = {
    type: "workspace",
    generation: 0,
    health: { status: "healthy" },
    observedAt: 0,
    parents: [...parents],
  }
  const view = supervisionView(result, undefined, filters)
  return view.type === "ready" ? view.parents : []
}

function explicitSelection(parents: ReadonlyArray<ParentSummary>, sessionID: string) {
  const child = parents
    .flatMap((parent) => parent.operations.map((operation) => ({ parent, operation })))
    .find((item) => item.operation.childID === sessionID)
  if (child) return { parentID: child.parent.session.id, operationID: child.operation.id }
  const parent = parents.find((item) => item.session.id === sessionID)
  if (!parent) return
  return {
    parentID: parent.session.id,
    operationID:
      [parent.newestActionableOperationID, parent.newestOperationID].find((id) =>
        parent.operations.some((item) => item.id === id),
      ) ?? parent.operations[0]?.id,
  }
}

function inspectorItems(operation: ProjectedOperation) {
  return [
    "identity",
    "context",
    "model",
    "state",
    "timeline",
    ...(operation.timeline.executionEndSource ? ["execution-end"] : []),
    ...(operation.outcome ? ["outcome"] : []),
    ...(operation.recovery ? ["recovery"] : []),
    ...(operation.retryOfOperationID ? ["retry"] : []),
  ]
}

function selectionVisible(
  parents: ReadonlyArray<ParentSummary>,
  filters: Filters,
  selection: { readonly parentID: string; readonly operationID?: string },
) {
  const parent = visibleParents(parents, filters).find((item) => item.session.id === selection.parentID)
  if (!parent) return false
  return !selection.operationID || parent.operations.some((operation) => operation.id === selection.operationID)
}

function fallbackParent(parents: ReadonlyArray<ParentSummary>) {
  return (
    parents.find((parent) =>
      parent.operations.some((operation) => operation.presentationState !== "terminal" || operation.recovery?.eligible),
    ) ??
    parents.find((parent) => parent.operations.length > 0) ??
    parents[0]
  )
}

function nearest(previous: ReadonlyArray<string>, selected: string | undefined, current: ReadonlyArray<string>) {
  const index = selected ? previous.indexOf(selected) : -1
  if (index < 0) return
  return Array.from({ length: previous.length }, (_, distance) => distance + 1)
    .flatMap((distance) => [previous[index + distance], previous[index - distance]])
    .find((item): item is string => item !== undefined && current.includes(item))
}

function anchors(value: unknown): Record<string, ScrollAnchor | undefined> {
  if (!record(value)) return {}
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, anchor]) =>
      record(anchor) && typeof anchor.itemID === "string"
        ? [[key, { itemID: anchor.itemID, offset: clampOffset(anchor.offset) }]]
        : [],
    ),
  )
}

function dimension(value: unknown, width: number, key: string) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return {}
  return { [key]: Math.min(value, Math.max(0, width)) }
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function clampOffset(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0
  return Math.max(-1, Math.min(1, value))
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

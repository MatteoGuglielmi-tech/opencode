/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import type { Context, Destination, Route } from "@opencode-ai/plugin/tui/context"
import { isPermissionNotFoundError, type PermissionReply, type PermissionRequest } from "@opencode-ai/client"
import { useTerminalDimensions } from "@opentui/solid"
import { randomUUID } from "node:crypto"
import { batch, createEffect, createMemo, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js"
import {
  loadSupervision,
  loadSupervisionPage,
  mergeHistoryPage,
  type ProjectedOperation,
  supervisionView,
  type WorkspaceResult,
} from "./supervision.js"
import { createSupervisionSynchronization, type SynchronizationFailure } from "./synchronization.js"
import {
  batchCancellationCounts,
  createSupervisionControls,
  operationControls,
  recoveryControls,
  type PendingSupervisionControl,
  type SupervisionControlAction,
  type SupervisionControlResult,
} from "./supervision-controls.js"
import {
  locationIdentity,
  reconcilePresentationState,
  revealOperation,
  retryForOperation,
  sanitizePresentationState,
  type PresentationMemory,
  type PresentationState,
} from "./presentation.js"
import {
  createPermissionControls,
  permissionChoices,
  permissionDecisionsEnabled,
  permissionInspector,
  permissionReplyLabel,
  permissionRequestForSubmission,
  type PermissionControlResult,
  type PendingPermissionControl,
} from "./permission-controls.js"
import { layoutFor, resizeLayout, type Separator } from "./responsive.js"
import { autoDirection, directionFor, horizontalDelta, ltrDirection, resizeDelta, rowDirection } from "./direction.js"

const PAGE = "supervision"
const ID = "opencode.delegation"

export function openSupervision(route: Route): Destination | undefined {
  if (route.type === "plugin" && route.id === ID && route.name === PAGE) return
  const returnRoute: Route = { ...route, ...(route.type === "plugin" && route.data ? { data: { ...route.data } } : {}) }
  return {
    type: "plugin",
    name: PAGE,
    data: {
      ...(route.type === "session" ? { entrySessionID: route.sessionID } : {}),
      returnRoute,
    },
  }
}

export function returnFromSupervision(
  route: Route,
  sessionExists: (sessionID: string) => boolean,
  pluginExists: (id: string, name: string) => boolean = () => true,
): Route {
  if (route.type !== "plugin" || route.id !== ID || route.name !== PAGE) return { type: "home" }
  const target = routeValue(route.data?.returnRoute)
  if (!target) return { type: "home" }
  if (target.type === "session" && !sessionExists(target.sessionID)) return { type: "home" }
  if (target.type === "plugin" && !pluginExists(target.id, target.name)) return { type: "home" }
  if (target.type === "plugin" && target.id === ID && target.name === PAGE) return { type: "home" }
  return target
}

export function openChildSession(context: Context, childID: string) {
  context.ui.tabs.open(context.data.session.root(childID))
  context.ui.router.navigate({ type: "session", sessionID: childID })
}

function SupervisionPage(props: {
  readonly context: Context
  readonly memory: PresentationMemory
  readonly updateMemory: (mutation: (draft: PresentationMemory) => void) => void
}) {
  const entry = () => {
    const route = props.context.ui.router.current()
    if (route.type !== "plugin" || route.id !== ID || route.name !== PAGE) return
    const value = route.data?.entrySessionID
    return typeof value === "string" ? value : undefined
  }
  const [current, setCurrent] = createSignal<WorkspaceResult>()
  const [freshness, setFreshness] = createSignal<"loading" | "live" | "stale" | "degraded">("loading")
  const [refreshFailure, setRefreshFailure] = createSignal<SynchronizationFailure>()
  const [permissions, setPermissions] = createSignal<ReadonlyMap<string, ReadonlyArray<PermissionRequest>>>(new Map())
  const location = props.context.location ?? props.context.data.location.default()
  const memoryKey = locationIdentity(location)
  const dimensions = useTerminalDimensions()
  const direction = () => directionFor(props.context.options?.direction)
  const configureDialog = () => {
    props.context.ui.dialog.set({ direction: direction() })
    return props.context.ui.dialog
  }
  const restored = sanitizePresentationState(props.memory.locations[memoryKey], dimensions().width)
  const [search, setSearch] = createSignal(restored.filters.search)
  const [actionableOnly, setActionableOnly] = createSignal(restored.filters.actionableOnly)
  const [selectedParentID, setSelectedParentID] = createSignal(restored.selectedParentID)
  const [selectedOperationID, setSelectedOperationID] = createSignal(restored.selectedOperationID)
  let presentation = restored
  let adjustmentReported = false
  let pendingEntry = entry()
  const [paginationFailure, setPaginationFailure] = createSignal<{
    readonly parentID: string
    readonly cursor: string
  }>()
  const [loadingParent, setLoadingParent] = createSignal<string>()
  const [paging, setPaging] = createSignal(false)
  const [pendingControls, setPendingControls] = createSignal<ReadonlyArray<PendingSupervisionControl>>([])
  const [pendingPermissions, setPendingPermissions] = createSignal<ReadonlyArray<PendingPermissionControl>>([])
  const [steerDrafts, setSteerDrafts] = createSignal<Readonly<Record<string, string>>>({})
  const [confirmedGeneration, setConfirmedGeneration] = createSignal(0)
  const [wideParents, setWideParents] = createSignal(restored.paneSizes.wide.parents)
  const [wideInspector, setWideInspector] = createSignal(restored.paneSizes.wide.inspector)
  const [mediumInspector, setMediumInspector] = createSignal(restored.paneSizes.medium.inspector)
  const [stage, setStage] = createSignal<"parents" | "timeline" | "inspector">("parents")
  const [focus, setFocus] = createSignal<
    "parents" | "parentSelector" | "parentSeparator" | "timeline" | "timelineSeparator" | "inspector"
  >("parents")
  const layout = createMemo(() =>
    layoutFor(
      dimensions().width,
      dimensions().width >= 120
        ? { parents: wideParents(), inspector: wideInspector() }
        : { inspector: mediumInspector() },
    ),
  )
  let timelineScroll: { scrollBy(offset: number): void } | undefined
  let inspectorScroll: { scrollBy(offset: number): void } | undefined
  let dragX: number | undefined
  let dragging: Separator | undefined
  const synchronization = createSupervisionSynchronization<PermissionRequest>({
    load: (request) => loadSupervision(props.context.client, location, entry(), request),
    permissions: async (childIDs) => {
      await Promise.all(childIDs.map((sessionID) => props.context.data.session.permission.sync(sessionID)))
      return new Map(
        childIDs.map((sessionID) => [sessionID, [...(props.context.data.session.permission.list(sessionID) ?? [])]]),
      )
    },
    publish(state) {
      batch(() => {
        setFreshness(state.freshness)
        setRefreshFailure(state.freshness === "stale" ? state.failure : undefined)
        if (!state.combined) return
        setPermissions(state.combined.permissions)
        setCurrent(state.combined.workspace)
      })
    },
    unresolvedLocal: () => pendingControls().length > 0 || pendingPermissions().length > 0,
  })
  const controls = createSupervisionControls({
    invocationID: () => `ctl_${randomUUID().replaceAll("-", "")}`,
    invoke: (input) =>
      props.context.client.session.command({
        sessionID: input.parentID,
        id: input.invocationID,
        command: "delegation",
        arguments: input.arguments,
        delivery: "steer",
        resume: false,
      }),
    reconcile: async () => {
      const state = await synchronization.reconcile()
      if (state.freshness !== "live") throw new Error("Authoritative Delegation reconciliation is unavailable")
    },
    publish: setPendingControls,
  })
  const permissionControls = createPermissionControls({
    invoke: (input) => props.context.client.permission.reply(input),
    reconcile: async () => {
      const state = await synchronization.reconcile()
      if (state.freshness !== "live") throw new Error("Authoritative permission reconciliation is unavailable")
    },
    exists: (sessionID, requestID) =>
      permissions()
        .get(sessionID)
        ?.some((request) => request.id === requestID) ?? false,
    notFound: isPermissionNotFoundError,
    publish: setPendingPermissions,
  })
  synchronization.start()
  const stopEvents = props.context.data.listen((event) => {
    if (
      event.details.type === "server.connected" ||
      event.details.type.startsWith("session.") ||
      event.details.type.startsWith("permission.")
    )
      synchronization.request()
  })
  const onFocus = () => synchronization.request()
  props.context.renderer.on("focus", onFocus)
  onCleanup(() => {
    synchronization.stop()
    stopEvents()
    props.context.renderer.off("focus", onFocus)
  })
  const view = createMemo(() =>
    supervisionView(current(), undefined, {
      search: search(),
      actionableOnly: actionableOnly(),
    }),
  )
  const ready = createMemo(() => {
    const current = view()
    if (current.type === "ready") return current
  })
  const selectedParent = createMemo(() => {
    const visible = ready()?.parents
    if (!visible) return
    return visible.find((parent) => parent.session.id === selectedParentID())?.session.id ?? visible[0]?.session.id
  })
  const selectedOperation = createMemo(() => {
    const parent = ready()?.parents.find((candidate) => candidate.session.id === selectedParent())
    return parent?.operations.find((operation) => operation.id === selectedOperationID()) ?? parent?.operations[0]
  })
  const selectedBatchOperations = createMemo(() => {
    const operation = selectedOperation()
    const parent = ready()?.parents.find((candidate) => candidate.session.id === operation?.parentID)
    return parent?.operations.filter((candidate) => candidate.batchID === operation?.batchID) ?? []
  })
  const observedAt = createMemo(() => {
    const result = current()
    return result?.type === "workspace" ? result.observedAt : 0
  })
  const selectedOperationKey = createMemo(() => selectedOperation()?.id)
  const selectedPermissions = createMemo(() => {
    const childID = selectedOperation()?.childID
    return childID ? (permissions().get(childID) ?? []) : []
  })
  const pendingFor = (operationID: string) =>
    pendingControls().find((control) => control.operationIDs.includes(operationID))
  const cancellationPendingFor = (operationID: string) =>
    pendingControls().some(
      (control) => control.operationIDs.includes(operationID) && control.action.type.startsWith("cancel-"),
    )
  const recoveryEnabled = (operation: ProjectedOperation, action: "retry" | "dismiss") =>
    synchronization.mutationsEnabled() && recoveryControls(operation, Boolean(pendingFor(operation.id)))[action]
  const linkedRetry = createMemo(() => {
    const operation = selectedOperation()
    const result = current()
    return !operation || result?.type !== "workspace" ? undefined : retryForOperation(result.parents, operation.id)
  })
  const health = createMemo(() => {
    const result = current()
    if (result?.type === "workspace" && result.health.status === "degraded") return result.health
  })
  createEffect(() => {
    const result = current()
    if (result?.type !== "workspace") return
    const input: PresentationState = {
      ...presentation,
      filters: { search: search(), actionableOnly: actionableOnly() },
      selectedParentID: selectedParentID(),
      selectedOperationID: selectedOperationID(),
    }
    const reconciled = reconcilePresentationState(input, result.parents, pendingEntry)
    pendingEntry = undefined
    presentation = reconciled.state
    setSearch(reconciled.state.filters.search)
    setActionableOnly(reconciled.state.filters.actionableOnly)
    setSelectedParentID(reconciled.state.selectedParentID)
    setSelectedOperationID(reconciled.state.selectedOperationID)
    props.updateMemory((draft) => {
      draft.locations[memoryKey] = reconciled.state
    })
    if (adjustmentReported || reconciled.adjustedFilters.length === 0) return
    adjustmentReported = true
    props.context.ui.toast.show({
      variant: "info",
      message: `Adjusted ${reconciled.adjustedFilters.join(" and ")} filters to show this Session.`,
    })
  })
  const loadOlder = async () => {
    const result = current()
    if (result?.type !== "workspace") return
    const available = result.parents.filter((parent) => parent.nextCursor)
    if (available.length === 0 || paging()) return
    setPaging(true)
    const parentID =
      available.length === 1
        ? available[0].session.id
        : await configureDialog().select({
            title: "Load older Delegation history",
            current: selectedParent(),
            options: available.map((parent) => ({
              title: parent.session.title ? autoDirection(parent.session.title) : ltrDirection(parent.session.id),
              value: parent.session.id,
              description: `${ltrDirection(parent.operations.length)} loaded / ${ltrDirection(parent.counts.total)} retained`,
            })),
          })
    const parent = available.find((candidate) => candidate.session.id === parentID)
    if (!parent?.nextCursor) {
      setPaging(false)
      return
    }
    const failed = paginationFailure()
    const cursor =
      failed?.parentID === parent.session.id && failed.cursor === parent.nextCursor ? failed.cursor : parent.nextCursor
    setLoadingParent(parent.session.id)
    return synchronization
      .serialize(async () => {
        const latest = current()
        if (latest?.type !== "workspace") return
        const latestParent = latest.parents.find((candidate) => candidate.session.id === parent.session.id)
        if (!latestParent?.nextCursor) return
        const page = await loadSupervisionPage(props.context.client, {
          location,
          generation: latest.generation,
          parentID: latestParent.session.id,
          cursor: latestParent.nextCursor,
          limit: Math.max(1, latestParent.operations.length),
        })
        setCurrent((value) => (value?.type === "workspace" ? mergeHistoryPage(value, page) : value))
      })
      .then(
        () => setPaginationFailure(undefined),
        () => setPaginationFailure({ parentID: parent.session.id, cursor }),
      )
      .finally(() => {
        setLoadingParent(undefined)
        setPaging(false)
      })
  }
  const reportControl = (result: SupervisionControlResult, committed: string, operationID?: string) => {
    if (result.status === "committed") {
      props.context.ui.toast.show({ variant: "success", message: committed })
      return true
    }
    if (result.status === "blocked") {
      props.context.ui.toast.show({ variant: "info", message: "This operation already has a Control pending." })
      return false
    }
    if (result.status === "reconciled") {
      const result = current()
      const state =
        (result?.type === "workspace" ? result.parents : [])
          .flatMap((parent) => parent.operations)
          .find((operation) => operation.id === operationID)?.presentationState ?? "unavailable"
      props.context.ui.toast.show({
        variant: "info",
        message: `Control was not applied; the operation is now ${state}.`,
      })
      return false
    }
    if (result.status === "conflict" || result.status === "defect") {
      props.context.ui.toast.show({
        variant: "error",
        message: `Delegation Control defect (${result.invocationID}): ${result.detail}`,
      })
      return false
    }
    props.context.ui.toast.show({
      variant: "warning",
      message: `Control ${result.invocationID} is still confirming: ${result.detail}`,
    })
    return false
  }
  const reveal = (operationID: string) => {
    const result = current()
    if (result?.type !== "workspace") return
    const revealed = revealOperation(
      {
        ...presentation,
        filters: { search: search(), actionableOnly: actionableOnly() },
        selectedParentID: selectedParentID(),
        selectedOperationID: selectedOperationID(),
      },
      result.parents,
      operationID,
    )
    batch(() => {
      setSearch(revealed.state.filters.search)
      setActionableOnly(revealed.state.filters.actionableOnly)
      setSelectedParentID(revealed.state.selectedParentID)
      setSelectedOperationID(revealed.state.selectedOperationID)
    })
    if (revealed.adjustedFilters.length === 0) return
    props.context.ui.toast.show({
      variant: "info",
      message: `Adjusted ${revealed.adjustedFilters.join(" and ")} filters to reveal this operation.`,
    })
  }
  createEffect(() => {
    const result = current()
    if (result?.type !== "workspace" || freshness() !== "live" || result.generation === confirmedGeneration()) return
    setConfirmedGeneration(result.generation)
    const unresolved = controls.pending()
    if (unresolved.length > 0)
      void controls.confirm().then((results) =>
        results.forEach((control) => {
          if (control.status === "uncertain") return
          const action = unresolved.find((candidate) => candidate.invocationID === control.invocationID)?.action
          if (
            !reportControl(
              control,
              controlCommittedMessage(action),
              action && "operationID" in action ? action.operationID : undefined,
            )
          )
            return
          if (action?.type === "retry") reveal(action.operationID)
          if (action?.type !== "steer") return
          setSteerDrafts((drafts) => ({ ...drafts, [action.operationID]: "" }))
        }),
      )
    if (permissionControls.pending().length > 0)
      void permissionControls.confirm().then((results) => results.forEach(reportPermission))
  })
  const reportPermission = (result: PermissionControlResult) => {
    if (result.status === "applied") {
      props.context.ui.toast.show({ variant: "success", message: "Permission decision applied." })
      return
    }
    if (result.status === "expired") {
      props.context.ui.toast.show({ variant: "info", message: "Permission expired; no decision was applied." })
      return
    }
    if (result.status === "blocked") {
      props.context.ui.toast.show({ variant: "info", message: "This permission request already has a reply pending." })
      return
    }
    props.context.ui.toast.show({
      variant: "warning",
      message:
        result.status === "resolved"
          ? "Permission request is no longer open; the uncertain reply was not replayed."
          : `Permission reply is uncertain and was not replayed${result.detail ? `: ${result.detail}` : "."}`,
    })
  }
  const replyPermission = async (selectedRequest?: PermissionRequest, selectedReply?: PermissionReply) => {
    const operation = selectedOperation()
    if (
      !permissionDecisionsEnabled(operation, freshness(), operation && cancellationPendingFor(operation.id)) ||
      !operation?.childID
    )
      return
    const available = selectedPermissions().filter((request) => !permissionControls.isPending(request.id))
    if (available.length === 0) return
    const requestID =
      selectedRequest?.id ??
      (await configureDialog().select({
        title: "Resolve child Session permission",
        options: available.map((request) => ({
          title: `${autoDirection(request.action)} (${ltrDirection(request.id)})`,
          value: request.id,
          description: ltrDirection(request.resources.join(", ")),
        })),
      }))
    const request = available.find((candidate) => candidate.id === requestID)
    if (!request) return
    const reply =
      selectedReply ??
      (await configureDialog().select<PermissionReply>({
        title: `Permission ${ltrDirection(request.id)}`,
        options: permissionChoices(request).map((value) => ({
          title: permissionReplyLabel(value),
          value,
        })),
      }))
    if (!reply) return
    const message =
      reply === "reject"
        ? await configureDialog().prompt({
            title: "Reject permission",
            description: "Tell OpenCode what to do differently",
          })
        : undefined
    if (reply === "reject" && message === undefined) return
    const state = await synchronization.reconcile()
    const latest =
      state.combined?.workspace.parents
        .flatMap((parent) => parent.operations)
        .find((candidate) => candidate.id === operation.id)
    const latestRequest = permissionRequestForSubmission({
      operation: latest,
      freshness: state.freshness,
      cancellationPending: cancellationPendingFor(operation.id),
      requests: latest?.childID ? (state.combined?.permissions.get(latest.childID) ?? []) : [],
      requestID: request.id,
      reply,
    })
    if (!latest?.childID || !latestRequest || permissionControls.isPending(request.id)) {
      props.context.ui.toast.show({ variant: "info", message: "Permission state changed; no decision was applied." })
      return
    }
    reportPermission(
      await permissionControls.submit({
        sessionID: latest.childID,
        requestID: latestRequest.id,
        reply,
        ...(message ? { message } : {}),
      }),
    )
  }
  const cancelOperation = async () => {
    const operation = selectedOperation()
    if (
      !operation ||
      !synchronization.mutationsEnabled() ||
      !operationControls(operation, Boolean(pendingFor(operation.id))).cancel
    )
      return
    const complete = synchronization.trackAction()
    const result = await controls
      .submit({
        action: { type: "cancel-operation", parentID: operation.parentID, operationID: operation.id },
        operationIDs: [operation.id],
      })
      .finally(complete)
    reportControl(result, "Cancellation requested.", operation.id)
  }
  const cancelBatch = async () => {
    if (!synchronization.mutationsEnabled()) return
    const selected = selectedOperation()
    if (!selected) return
    await synchronization.reconcile()
    if (!synchronization.mutationsEnabled()) return
    const result = current()
    if (result?.type !== "workspace") return
    const parent = result.parents.find((candidate) => candidate.session.id === selected.parentID)
    const operations = parent?.operations.filter((operation) => operation.batchID === selected.batchID) ?? []
    if (operations.some((operation) => pendingFor(operation.id))) return
    const counts = batchCancellationCounts(operations)
    if (counts.cancellable === 0) {
      props.context.ui.toast.show({ variant: "info", message: "This batch no longer has cancellable operations." })
      return
    }
    const confirmed = await configureDialog().confirm({
      title: `Cancel batch ${ltrDirection(selected.batchID)}`,
      message: `${parent?.session.title ? autoDirection(parent.session.title) : ltrDirection(selected.parentID)}: ${ltrDirection(counts.cancellable)} cancellable, ${ltrDirection(counts.pending)} cancellation-pending, ${ltrDirection(counts.terminal)} terminal. Non-terminal members will be targeted; retained records and child Sessions remain available.`,
      label: { confirm: "Cancel batch" },
    })
    if (!confirmed) return
    await synchronization.reconcile()
    if (!synchronization.mutationsEnabled()) return
    const latest = current()
    const latestOperations =
      latest?.type === "workspace"
        ? (latest.parents
            .find((candidate) => candidate.session.id === selected.parentID)
            ?.operations.filter((operation) => operation.batchID === selected.batchID) ?? [])
        : []
    const latestCounts = batchCancellationCounts(latestOperations)
    if (
      latestCounts.cancellable !== counts.cancellable ||
      latestCounts.pending !== counts.pending ||
      latestCounts.terminal !== counts.terminal
    ) {
      props.context.ui.toast.show({ variant: "info", message: "Batch state changed; review the refreshed counts." })
      return cancelBatch()
    }
    if (latestOperations.some((operation) => pendingFor(operation.id))) return
    const complete = synchronization.trackAction()
    const control = await controls
      .submit({
        action: { type: "cancel-batch", parentID: selected.parentID, batchID: selected.batchID },
        operationIDs: latestCounts.targets,
      })
      .finally(complete)
    reportControl(control, "Batch cancellation requested.", selected.id)
  }
  const steerOperation = async () => {
    const operation = selectedOperation()
    if (
      !operation ||
      !synchronization.mutationsEnabled() ||
      !operationControls(operation, Boolean(pendingFor(operation.id))).steer
    )
      return
    const text = await configureDialog().prompt({
      title: "Steer child Session",
      description: "Guidance is retained until commitment is confirmed.",
      value: steerDrafts()[operation.id] ?? "",
    })
    if (text === undefined) return
    setSteerDrafts((drafts) => ({ ...drafts, [operation.id]: text }))
    if (!text.trim()) return
    const complete = synchronization.trackAction()
    const result = await controls
      .submit({
        action: { type: "steer", parentID: operation.parentID, operationID: operation.id, text: text.trim() },
        operationIDs: [operation.id],
      })
      .finally(complete)
    if (!reportControl(result, "Guidance committed.", operation.id)) return
    setSteerDrafts((drafts) => ({ ...drafts, [operation.id]: "" }))
  }
  const retryOperation = async () => {
    const operation = selectedOperation()
    if (!operation || !recoveryEnabled(operation, "retry")) return
    const complete = synchronization.trackAction()
    if (
      !reportControl(
        await controls
          .submit({
            action: { type: "retry", parentID: operation.parentID, operationID: operation.id },
            operationIDs: [operation.id],
          })
          .finally(complete),
        "Retry admitted.",
        operation.id,
      )
    )
      return
    reveal(operation.id)
  }
  const dismissRecovery = async () => {
    const operation = selectedOperation()
    if (!operation || !recoveryEnabled(operation, "dismiss")) return
    const confirmed = await configureDialog().confirm({
      title: "Dismiss recovery",
      message:
        "Permanently consume this operation's recovery eligibility? The operation, timeline, Recovery notice, and child Session remain retained.",
      label: { confirm: "Dismiss recovery" },
    })
    if (!confirmed) return
    await synchronization.reconcile()
    if (!synchronization.mutationsEnabled()) return
    const latest = current()
    const candidate =
      latest?.type === "workspace"
        ? latest.parents.flatMap((parent) => parent.operations).find((item) => item.id === operation.id)
        : undefined
    if (!candidate || !recoveryEnabled(candidate, "dismiss")) {
      props.context.ui.toast.show({
        variant: "info",
        message: "Recovery eligibility changed; no dismissal was applied.",
      })
      return
    }
    const complete = synchronization.trackAction()
    reportControl(
      await controls
        .submit({
          action: { type: "dismiss-recovery", parentID: candidate.parentID, operationID: candidate.id },
          operationIDs: [candidate.id],
        })
        .finally(complete),
      "Recovery dismissed.",
      candidate.id,
    )
  }
  const selectedParentRecord = createMemo(() =>
    ready()?.parents.find((candidate) => candidate.session.id === selectedParent()),
  )
  const focusOrder = () => {
    if (layout().composition === "wide")
      return ["parents", "parentSeparator", "timeline", "timelineSeparator", "inspector"] as const
    if (layout().composition === "medium")
      return ["parentSelector", "timeline", "timelineSeparator", "inspector"] as const
    return [stage()] as const
  }
  createEffect(() => {
    const order = focusOrder()
    if (!order.includes(focus() as never)) setFocus(order[0])
  })
  const rememberLayout = (separator: Separator, delta: number) => {
    const next = resizeLayout(layout(), separator, delta)
    if (next.composition === "wide") {
      setWideParents(next.parents)
      setWideInspector(next.inspector)
    }
    if (next.composition === "medium") setMediumInspector(next.inspector)
    const paneSizes = {
      ...presentation.paneSizes,
      ...(next.composition === "wide"
        ? { wide: { parents: next.parents, inspector: next.inspector } }
        : next.composition === "medium"
          ? { medium: { inspector: next.inspector } }
          : {}),
    }
    presentation = { ...presentation, paneSizes }
    props.updateMemory((draft) => {
      const current = draft.locations[memoryKey] ?? presentation
      draft.locations[memoryKey] = { ...current, paneSizes }
    })
  }
  const moveFocus = (delta: number) => {
    const order = focusOrder()
    const index = Math.max(0, order.indexOf(focus() as never))
    setFocus(order[(index + delta + order.length) % order.length])
  }
  const selectParent = (parentID: string, advance = false) => {
    setSelectedParentID(parentID)
    const parent = ready()?.parents.find((candidate) => candidate.session.id === parentID)
    if (parent && !parent.operations.some((operation) => operation.id === selectedOperationID()))
      setSelectedOperationID(parent.operations[0]?.id)
    if (advance && layout().composition === "narrow") {
      setFocus("timeline")
      setStage("timeline")
    }
  }
  const selectOperation = (operationID: string, advance = false) => {
    setSelectedOperationID(operationID)
    setFocus("timeline")
    if (advance && layout().composition === "narrow") setStage("inspector")
  }
  const moveSelection = (delta: number) => {
    if (
      focus() === "parents" ||
      focus() === "parentSelector" ||
      (layout().composition === "narrow" && stage() === "parents")
    ) {
      const parents = ready()?.parents ?? []
      const index = Math.max(0, parents.findIndex((parent) => parent.session.id === selectedParent()))
      const next = parents[index + delta]
      if (next) selectParent(next.session.id)
      return
    }
    if (focus() === "timeline" || (layout().composition === "narrow" && stage() === "timeline")) {
      const operations = selectedParentRecord()?.operations ?? []
      const index = Math.max(0, operations.findIndex((operation) => operation.id === selectedOperationKey()))
      const next = operations[index + delta]
      if (next) {
        selectOperation(next.id)
        timelineScroll?.scrollBy(delta * 2)
      }
      return
    }
    inspectorScroll?.scrollBy(delta)
  }
  const forward = () => {
    if (layout().composition === "narrow") {
      if (stage() === "parents") {
        setFocus("timeline")
        setStage("timeline")
        return
      }
      if (stage() === "timeline") {
        setFocus("inspector")
        setStage("inspector")
        return
      }
    }
    const childID = selectedOperation()?.childID
    if (childID) openChildSession(props.context, childID)
  }
  const back = () => {
    if (layout().composition === "narrow" && stage() === "inspector") {
      setFocus("timeline")
      setStage("timeline")
      return
    }
    if (layout().composition === "narrow" && stage() === "timeline") {
      setFocus("parents")
      setStage("parents")
      return
    }
    props.context.ui.router.navigate(
      returnFromSupervision(
        props.context.ui.router.current(),
        (sessionID) => Boolean(props.context.data.session.get(sessionID)),
        props.context.ui.router.exists,
      ),
    )
  }
  const selectParentDialog = async () => {
    const parentID = await configureDialog().select({
      title: "Select parent Session",
      current: selectedParent(),
      options: (ready()?.parents ?? []).map((parent) => ({
        title: parent.session.title ? autoDirection(parent.session.title) : ltrDirection(parent.session.id),
        value: parent.session.id,
        description: `${ltrDirection(parent.counts.actionable)} actionable / ${ltrDirection(parent.counts.total)} retained`,
      })),
    })
    if (parentID) selectParent(parentID)
  }
  const searchHistory = async () => {
    const value = await configureDialog().prompt({
      title: "Search Delegation history",
      description: "Search Delegation operations, identifiers, and Sessions",
      value: search(),
    })
    if (value !== undefined) setSearch(value)
  }
  const theme = props.context.theme

  function StatusBadge(badgeProps: { readonly operation: ProjectedOperation }) {
    const label = () =>
      badgeProps.operation.presentationState === "waiting"
        ? "NEEDS PERMISSION"
        : badgeProps.operation.presentationState === "terminal"
          ? badgeProps.operation.outcome?.state.toUpperCase() ?? "TERMINAL"
          : badgeProps.operation.presentationState.toUpperCase()
    const kind = () =>
      badgeProps.operation.presentationState === "waiting"
        ? "warning"
        : badgeProps.operation.presentationState === "terminal" && badgeProps.operation.outcome?.state === "completed"
          ? "success"
          : badgeProps.operation.presentationState === "terminal"
            ? "error"
            : "info"
    return (
      <text fg={theme.text.feedback[kind()].default} bg={theme.background.feedback[kind()].default} wrapMode="none">
        {` ${label()} `}
      </text>
    )
  }

  function TimelineVisual(visualProps: { readonly operation: ProjectedOperation; readonly onSelect?: () => void }) {
    const width = () => Math.max(12, Math.min(28, (layout().timeline ?? 32) - 4))
    const geometry = createMemo(() => timelineGeometry(visualProps.operation, observedAt(), width()))
    return (
      <box height={1} minWidth={0} flexDirection="row" position="relative" onMouseUp={visualProps.onSelect}>
        <For each={geometry().segments}>
          {(segment) => (
            <text fg={timelineColor(segment.label, theme)} wrapMode="none" onMouseUp={visualProps.onSelect}>
              {segment.label + "━".repeat(Math.max(1, segment.width - 1))}
            </text>
          )}
        </For>
        <For each={geometry().waits}>
          {(wait) => (
            <text position="absolute" left={wait.start} fg={theme.text.feedback.warning.default} wrapMode="none">
              {"◆".repeat(wait.width)}
            </text>
          )}
        </For>
      </box>
    )
  }

  function FactCard(cardProps: { readonly label: string; readonly value: string }) {
    return (
      <box
        width={Math.max(12, Math.floor(((layout().inspector ?? layout().timeline) - 2) / 2))}
        height={3}
        minWidth={0}
        paddingLeft={1}
        paddingRight={1}
        border={["top", "right", "bottom", "left"]}
        borderColor={theme.border.default}
      >
        <text fg={theme.text.default} wrapMode="none" truncate>
          {cardProps.label}: {cardProps.value}
        </text>
      </box>
    )
  }

  function ActionControl(actionProps: {
    readonly label: string
    readonly run: () => unknown
    readonly enabled?: boolean
    readonly variant?: "primary" | "destructive"
  }) {
    const enabled = () => actionProps.enabled !== false
    const variant = actionProps.variant ?? "primary"
    return (
      <box
        height={3}
        flexShrink={0}
        paddingLeft={1}
        paddingRight={1}
        border={["top", "right", "bottom", "left"]}
        borderColor={enabled() ? theme.text.action[variant].default : theme.border.default}
        backgroundColor={enabled() ? theme.background.action[variant].default : undefined}
        onMouseUp={() => {
          if (enabled()) actionProps.run()
        }}
      >
        <text fg={enabled() ? theme.text.action[variant].default : theme.text.subdued} wrapMode="none">
          {actionProps.label}
        </text>
      </box>
    )
  }

  function InspectorActions(actionProps: { readonly operation: ProjectedOperation }) {
    const pending = () => Boolean(pendingFor(actionProps.operation.id))
    const controls = () => operationControls(actionProps.operation, pending())
    const recovery = () => recoveryControls(actionProps.operation, pending())
    const enabled = () => synchronization.mutationsEnabled()
    return (
      <box flexDirection={rowDirection(direction())} flexWrap="wrap" flexShrink={0}>
        <Show when={actionProps.operation.childID}>
          <ActionControl label={`Open child Session ${ltrDirection("(Enter)")}`} run={forward} />
        </Show>
        <Show when={controls().cancel}>
          <ActionControl
            label={`Cancel operation ${ltrDirection("(Ctrl+X)")}`}
            run={cancelOperation}
            enabled={enabled()}
            variant="destructive"
          />
        </Show>
        <Show when={controls().steer}>
          <ActionControl
            label={`Steer child Session ${ltrDirection("(Ctrl+S)")}`}
            run={steerOperation}
            enabled={enabled()}
          />
        </Show>
        <Show when={recovery().retry}>
          <ActionControl label={`Retry ${ltrDirection("(Ctrl+T)")}`} run={retryOperation} enabled={enabled()} />
          <ActionControl
            label={`Dismiss recovery ${ltrDirection("(Ctrl+D)")}`}
            run={dismissRecovery}
            enabled={enabled()}
            variant="destructive"
          />
        </Show>
        <Show when={linkedRetry()}>
          <ActionControl
            label={`View retry ${ltrDirection("(Ctrl+V)")}`}
            run={() => {
              const retry = linkedRetry()
              if (retry) reveal(retry.id)
            }}
          />
        </Show>
      </box>
    )
  }

  props.context.keymap.layer(() => ({
    commands: [
      {
        id: "delegation.supervision.back",
        title: "Back from Delegation supervision",
        bind: "esc",
        run: back,
      },
      {
        id: "delegation.supervision.child.open",
        title: "Inspect or open child Session",
        bind: "enter",
        run: forward,
      },
      {
        id: "delegation.supervision.refresh",
        title: "Refresh Delegation supervision",
        bind: "ctrl+r",
        run() {
          synchronization.request()
        },
      },
      {
        id: "delegation.supervision.permission.reply",
        title: "Resolve child Session permission",
        bind: "ctrl+p",
        enabled: () => {
          const operation = selectedOperation()
          return Boolean(
            selectedPermissions().some((request) => !permissionControls.isPending(request.id)) &&
              permissionDecisionsEnabled(operation, freshness(), operation && cancellationPendingFor(operation.id)),
          )
        },
        run: () => replyPermission(),
      },
      {
        id: "delegation.supervision.operation.cancel",
        title: "Cancel operation",
        bind: "ctrl+x",
        enabled: () => {
          const operation = selectedOperation()
          return Boolean(
            operation &&
              synchronization.mutationsEnabled() &&
              operationControls(operation, Boolean(pendingFor(operation.id))).cancel,
          )
        },
        run: cancelOperation,
      },
      {
        id: "delegation.supervision.batch.cancel",
        title: "Cancel batch",
        bind: "ctrl+b",
        enabled: () => {
          const operations = selectedBatchOperations()
          return Boolean(
            selectedOperation() &&
              synchronization.mutationsEnabled() &&
              !operations.some((candidate) => pendingFor(candidate.id)) &&
              batchCancellationCounts(operations).cancellable > 0,
          )
        },
        run: cancelBatch,
      },
      {
        id: "delegation.supervision.operation.steer",
        title: "Steer child Session",
        bind: "ctrl+s",
        enabled: () => {
          const operation = selectedOperation()
          return Boolean(
            operation &&
              synchronization.mutationsEnabled() &&
              operationControls(operation, Boolean(pendingFor(operation.id))).steer,
          )
        },
        run: steerOperation,
      },
      {
        id: "delegation.supervision.operation.retry",
        title: "Retry recovered operation",
        bind: "ctrl+t",
        enabled: () => {
          const operation = selectedOperation()
          return Boolean(operation && recoveryEnabled(operation, "retry"))
        },
        run: retryOperation,
      },
      {
        id: "delegation.supervision.recovery.dismiss",
        title: "Dismiss recovery",
        bind: "ctrl+d",
        enabled: () => {
          const operation = selectedOperation()
          return Boolean(operation && recoveryEnabled(operation, "dismiss"))
        },
        run: dismissRecovery,
      },
      {
        id: "delegation.supervision.retry.view",
        title: "View retry",
        bind: "ctrl+v",
        enabled: () => Boolean(linkedRetry()),
        run() {
          const retry = linkedRetry()
          if (retry) reveal(retry.id)
        },
      },
      {
        id: "delegation.supervision.filter.search",
        title: "Search Delegation history",
        bind: "ctrl+f",
        run: searchHistory,
      },
      {
        id: "delegation.supervision.history.older",
        title: "Load older Delegation history",
        bind: "ctrl+o",
        run: async () => {
          await loadOlder()
        },
      },
      {
        id: "delegation.supervision.filter.actionable",
        title: "Toggle actionable Delegations",
        bind: "ctrl+a",
        run() {
          setActionableOnly((value) => !value)
        },
      },
      {
        id: "delegation.supervision.navigation.previous",
        title: "Previous Delegation item",
        bind: "up",
        run: () => moveSelection(-1),
      },
      {
        id: "delegation.supervision.navigation.next",
        title: "Next Delegation item",
        bind: "down",
        run: () => moveSelection(1),
      },
      {
        id: "delegation.supervision.focus.previous",
        title: "Previous Delegation pane",
        bind: "shift+tab",
        run: () => moveFocus(-1),
      },
      {
        id: "delegation.supervision.focus.next",
        title: "Next Delegation pane",
        bind: "tab",
        run: () => moveFocus(1),
      },
      {
        id: "delegation.supervision.navigation.left",
        title: "Move or resize left",
        bind: "left",
        run() {
          if (focus() === "parentSeparator") return rememberLayout("parents", resizeDelta("parents", -2, direction()))
          if (focus() === "timelineSeparator")
            return rememberLayout("inspector", resizeDelta("inspector", -2, direction()))
          moveFocus(horizontalDelta(-1, direction()))
        },
      },
      {
        id: "delegation.supervision.navigation.right",
        title: "Move or resize right",
        bind: "right",
        run() {
          if (focus() === "parentSeparator") return rememberLayout("parents", resizeDelta("parents", 2, direction()))
          if (focus() === "timelineSeparator")
            return rememberLayout("inspector", resizeDelta("inspector", 2, direction()))
          moveFocus(horizontalDelta(1, direction()))
        },
      },
      {
        id: "delegation.supervision.scroll.page-up",
        title: "Scroll Delegation pane up",
        bind: "pgup",
        run: () =>
          (layout().composition === "narrow"
            ? stage() === "inspector"
              ? inspectorScroll
              : timelineScroll
            : focus() === "inspector"
              ? inspectorScroll
              : timelineScroll
          )?.scrollBy(-8),
      },
      {
        id: "delegation.supervision.scroll.page-down",
        title: "Scroll Delegation pane down",
        bind: "pgdown",
        run: () =>
          (layout().composition === "narrow"
            ? stage() === "inspector"
              ? inspectorScroll
              : timelineScroll
            : focus() === "inspector"
              ? inspectorScroll
              : timelineScroll
          )?.scrollBy(8),
      },
    ],
  }))

  function ParentPane() {
    return (
      <box width={layout().parents ?? layout().timeline} minWidth={0} minHeight={0} flexDirection="column">
        <text fg={focus() === "parents" ? theme.text.default : theme.text.subdued}>Parents</text>
        <scrollbox flexGrow={1} minHeight={0} scrollbarOptions={{ visible: true }}>
          <For each={ready()?.parents ?? []}>
            {(parent) => (
              <box
                flexDirection="column"
                onMouseUp={() => {
                  setFocus("parents")
                  selectParent(parent.session.id, true)
                }}
              >
                <text fg={selectedParent() === parent.session.id ? theme.text.default : theme.text.subdued} truncate>
                  {selectedParent() === parent.session.id ? (direction() === "rtl" ? " <" : "> ") : "  "}
                  {parent.session.title ? autoDirection(parent.session.title) : ltrDirection(parent.session.id)}
                </text>
                <text fg={theme.text.subdued} truncate>
                  {ltrDirection(parent.counts.actionable)} actionable / {ltrDirection(parent.counts.total)} retained
                  {parent.session.archived ? " / archived" : ""}
                </text>
              </box>
            )}
          </For>
        </scrollbox>
      </box>
    )
  }

  function TimelinePane() {
    return (
      <box width={layout().timeline} minWidth={0} minHeight={0} flexDirection="column">
        <box flexDirection={rowDirection(direction())} gap={1} flexShrink={0}>
          <text fg={focus() === "timeline" ? theme.text.default : theme.text.subdued}>Timeline</text>
          <Show when={selectedParentRecord()}>
            {(parent: () => NonNullable<ReturnType<typeof selectedParentRecord>>) => (
              <text fg={theme.text.subdued} truncate>
                {parent().session.title ? autoDirection(parent().session.title!) : ltrDirection(parent().session.id)}
              </text>
            )}
          </Show>
          <Show
            when={
              synchronization.mutationsEnabled() &&
              !selectedBatchOperations().some((candidate) => pendingFor(candidate.id)) &&
              batchCancellationCounts(selectedBatchOperations()).cancellable > 0
            }
          >
            <ActionControl
              label="Cancel batch"
              run={cancelBatch}
              variant="destructive"
            />
          </Show>
        </box>
        <scrollbox
          ref={(element) => (timelineScroll = element)}
          flexGrow={1}
          minHeight={0}
          scrollbarOptions={{ visible: true }}
        >
          <For each={selectedParentRecord()?.batches ?? []}>
            {(item) => (
              <box flexDirection="column">
                <text fg={theme.text.subdued}>Batch {ltrDirection(item.id)}</text>
                <For each={selectedParentRecord()?.operations.filter((operation) => operation.batchID === item.id) ?? []}>
                  {(operation) => (
                    <box
                      flexDirection="column"
                      onMouseUp={() => {
                        setFocus("timeline")
                        selectOperation(operation.id, true)
                      }}
                    >
                      <box
                        flexDirection={rowDirection(direction())}
                        gap={1}
                        minWidth={0}
                        onMouseUp={() => {
                          setFocus("timeline")
                          selectOperation(operation.id, true)
                        }}
                      >
                        <StatusBadge operation={operation} />
                        <text
                          fg={selectedOperationKey() === operation.id ? theme.text.default : theme.text.subdued}
                          truncate
                          onMouseUp={() => {
                            setFocus("timeline")
                            selectOperation(operation.id, true)
                          }}
                        >
                          {selectedOperationKey() === operation.id ? (direction() === "rtl" ? " <" : "> ") : "  "}
                          {autoDirection(operation.text)}
                          {pendingFor(operation.id) ? " [Control confirming]" : ""}
                        </text>
                      </box>
                      <TimelineVisual
                        operation={operation}
                        onSelect={() => {
                          setFocus("timeline")
                          selectOperation(operation.id, true)
                        }}
                      />
                    </box>
                  )}
                </For>
              </box>
            )}
          </For>
          <Show when={selectedParentRecord()?.nextCursor}>
            <text fg={theme.text.subdued} onMouseUp={loadOlder}>
              {loadingParent() === selectedParent() ? (
                "Loading older history..."
              ) : paginationFailure()?.parentID === selectedParent() &&
                paginationFailure()?.cursor === selectedParentRecord()?.nextCursor ? (
                "Load older history failed. Select to retry."
              ) : (
                <>Load older history {ltrDirection("(Ctrl+O)")}</>
              )}
            </text>
          </Show>
        </scrollbox>
      </box>
    )
  }

  function InspectorPane() {
    return (
      <box width={layout().inspector ?? layout().timeline} minWidth={0} minHeight={0} flexDirection="column">
        <text fg={focus() === "inspector" ? theme.text.default : theme.text.subdued}>Inspector</text>
        <scrollbox
          ref={(element) => (inspectorScroll = element)}
          flexGrow={1}
          minHeight={0}
          scrollbarOptions={{ visible: true }}
        >
          <Show when={selectedOperation()}>
            {(operation: () => ProjectedOperation) => (
              <box flexDirection="column" flexShrink={0}>
                <box flexDirection={rowDirection(direction())} gap={1} flexShrink={0}>
                  <StatusBadge operation={operation()} />
                  <text fg={theme.text.default} wrapMode="none" truncate>
                    {ltrDirection(operation().id)}
                  </text>
                </box>
                <text fg={theme.text.subdued}>
                  Batch {ltrDirection(operation().batchID)} | index {ltrDirection(operation().index)}
                </text>
                <text fg={theme.text.default}>{autoDirection(operation().text)}</text>
                <InspectorActions operation={operation()} />
                <box flexDirection={rowDirection(direction())} flexWrap="wrap" flexShrink={0}>
                  <FactCard
                    label="Parent"
                    value={
                      selectedParentRecord()?.session.title
                        ? autoDirection(selectedParentRecord()?.session.title ?? "")
                        : ltrDirection(operation().parentID)
                    }
                  />
                  <FactCard label="Child Session" value={ltrDirection(operation().childID ?? "not started")} />
                  <FactCard
                    label="Model"
                    value={ltrDirection(
                      `${operation().model.providerID}/${operation().model.modelID}${operation().model.variant ? ` (${operation().model.variant})` : ""}`,
                    )}
                  />
                  <FactCard label="Observed" value={ltrDirection(observedAt())} />
                </box>
                <text fg={theme.text.subdued}>
                  Parent {ltrDirection(operation().parentID)}
                  {operation().childID ? ` | Child ${ltrDirection(operation().childID ?? "")}` : ""}
                </text>
                <text fg={theme.text.subdued}>
                  Agent {ltrDirection(operation().agent)} | Model{" "}
                  {ltrDirection(
                    `${operation().model.providerID}/${operation().model.modelID}${operation().model.variant ? ` (${operation().model.variant})` : ""}`,
                  )}
                </text>
                <text fg={theme.text.subdued}>
                  State {ltrDirection(operation().presentationState)} | Observed {ltrDirection(observedAt())}
                </text>
                <text fg={theme.text.default}>Truthful timeline</text>
                <TimelineVisual operation={operation()} />
                <text fg={theme.text.subdued}>{ltrDirection(timelineTrack(operation(), observedAt()))}</text>
                <For each={operationInspector(operation(), observedAt()).slice(5)}>
                  {(line) => <text fg={theme.text.subdued}>{line}</text>}
                </For>
                <Show when={operation().childID}>
                  <Show when={selectedPermissions().length > 0}>
                    <text fg={theme.text.feedback.warning.default}>
                      Waiting for {ltrDirection(selectedPermissions().length)} permission request
                      {selectedPermissions().length === 1 ? "" : "s"}
                    </text>
                    <For each={selectedPermissions()}>
                      {(request) => {
                        const enabled = () =>
                          permissionDecisionsEnabled(
                            operation(),
                            freshness(),
                            cancellationPendingFor(operation().id),
                          ) && !permissionControls.isPending(request.id)
                        return (
                          <box
                            flexDirection="column"
                            flexShrink={0}
                            paddingLeft={1}
                            paddingRight={1}
                            border={["top", "right", "bottom", "left"]}
                            borderColor={theme.text.feedback.warning.default}
                          >
                            <For each={permissionInspector(request, permissionControls.isPending(request.id))}>
                              {(line) => <text fg={theme.text.subdued}>{ltrDirection(line)}</text>}
                            </For>
                            <box flexDirection={rowDirection(direction())} flexWrap="wrap">
                              <For each={permissionChoices(request)}>
                                {(reply) => (
                                  <ActionControl
                                    label={permissionReplyLabel(reply)}
                                    run={() => replyPermission(request, reply)}
                                    enabled={enabled()}
                                    variant={reply === "reject" ? "destructive" : "primary"}
                                  />
                                )}
                              </For>
                            </box>
                          </box>
                        )
                      }}
                    </For>
                    <Show
                      when={
                        selectedPermissions().some((request) => !permissionControls.isPending(request.id)) &&
                        permissionDecisionsEnabled(
                          operation(),
                          freshness(),
                          cancellationPendingFor(operation().id),
                        )
                      }
                    >
                      <ActionControl
                        label={`Resolve permission ${ltrDirection("(Ctrl+P)")}`}
                        run={() => replyPermission()}
                      />
                    </Show>
                  </Show>
                </Show>
                <Show when={pendingFor(operation().id)}>
                  <text fg={theme.text.feedback.warning.default}>
                    Control confirming; lifecycle remains authoritative.
                  </text>
                </Show>
              </box>
            )}
          </Show>
        </scrollbox>
      </box>
    )
  }

  function PaneSeparator(separatorProps: { readonly kind: Separator }) {
    const separatorFocus = () =>
      separatorProps.kind === "parents" ? focus() === "parentSeparator" : focus() === "timelineSeparator"
    const focusSeparator = () => setFocus(separatorProps.kind === "parents" ? "parentSeparator" : "timelineSeparator")
    return (
      <box
        width={1}
        minHeight={0}
        flexShrink={0}
        onMouseDown={(event) => {
          dragX = event.x
          dragging = separatorProps.kind
          focusSeparator()
          event.preventDefault()
        }}
        onMouseUp={focusSeparator}
      >
        <text fg={separatorFocus() ? theme.text.default : theme.text.subdued}>{separatorFocus() ? "┃" : "│"}</text>
      </box>
    )
  }

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      minWidth={0}
      minHeight={0}
      flexDirection="column"
      padding={1}
      onMouseDrag={(event) => {
        if (dragX === undefined || dragging === undefined) return
        const delta = event.x - dragX
        if (delta === 0) return
        rememberLayout(dragging, resizeDelta(dragging, delta, direction()))
        dragX = event.x
      }}
      onMouseDragEnd={() => {
        dragX = undefined
        dragging = undefined
      }}
      onMouseUp={() => {
        dragX = undefined
        dragging = undefined
      }}
    >
      <box flexDirection={rowDirection(direction())} gap={1} flexShrink={0}>
        <text fg={theme.text.default}>Delegation supervision</text>
        <text fg={freshness() === "live" ? theme.text.subdued : theme.text.feedback.warning.default}>
          {freshness() === "loading" ? "Loading" : freshness() === "live" ? "Live" : freshness() === "stale" ? "Stale" : "Degraded"}
        </text>
      </box>
      <box flexDirection={rowDirection(direction())} gap={1} flexShrink={0}>
        <text fg={theme.text.subdued} onMouseUp={searchHistory}>
          Search: {search() ? autoDirection(search()) : "all"} {ltrDirection("(Ctrl+F)")}
        </text>
        <text fg={theme.text.subdued} onMouseUp={() => setActionableOnly((value) => !value)}>
          {actionableOnly() ? "actionable only" : "all states"} {ltrDirection("(Ctrl+A)")}
        </text>
        <text fg={theme.text.subdued} onMouseUp={() => synchronization.request()}>
          Refresh {ltrDirection("(Ctrl+R)")}
        </text>
      </box>
      <Show when={freshness() !== "loading"}>
        <Show when={layout().composition === "medium"}>
          <text fg={theme.text.subdued} onMouseUp={selectParentDialog} truncate>
            Parent:{" "}
            {selectedParentRecord()?.session.title
              ? autoDirection(selectedParentRecord()!.session.title!)
              : selectedParentRecord()?.session.id
                ? ltrDirection(selectedParentRecord()!.session.id)
                : "none"}{" "}
            | {ltrDirection(selectedParentRecord()?.counts.actionable ?? 0)} actionable /{" "}
            {ltrDirection(selectedParentRecord()?.counts.total ?? 0)} retained (select)
          </text>
        </Show>
        <Show when={layout().composition === "narrow"}>
          <box flexDirection={rowDirection(direction())} gap={1}>
            <text fg={theme.text.subdued} onMouseUp={back}>
              {stage() === "parents" ? "Back" : direction() === "rtl" ? "> Back" : "< Back"}
            </text>
            <text fg={theme.text.default}>
              {stage() === "parents" ? "Parents" : stage() === "timeline" ? "Timeline" : "Inspector"}
            </text>
          </box>
        </Show>
      </Show>
      <Show when={health()}>
        <text fg={theme.text.feedback.warning.default}>
          Degraded coordinator data: {health()?.reason}. {healthGuidance(health()?.reason)}
        </text>
      </Show>
      <Switch>
        <Match when={freshness() === "stale" && !current()}>
          <text fg={theme.text.feedback.error.default}>
            Delegation supervision is unavailable: {refreshFailure()?.code ?? "invalid_response"}.{" "}
            {failureGuidance(refreshFailure()?.code)}
          </text>
        </Match>
        <Match when={view().type === "loading"}>
          <text fg={theme.text.subdued}>Loading delegation workspace...</text>
        </Match>
        <Match when={view().type === "workspace-empty"}>
          <text fg={theme.text.subdued}>No retained delegations in this workspace.</text>
        </Match>
        <Match when={view().type === "filtered-empty"}>
          <text fg={theme.text.subdued}>No delegations match the current filters.</text>
        </Match>
        <Match when={view().type === "unsupported-version"}>
          <text fg={theme.text.feedback.warning.default}>This Delegation supervision version is not supported.</text>
        </Match>
        <Match when={ready()}>
          <Switch>
            <Match when={layout().composition === "wide"}>
              <box flexGrow={1} minHeight={0} minWidth={0} flexDirection={rowDirection(direction())}>
                <ParentPane />
                <PaneSeparator kind="parents" />
                <TimelinePane />
                <PaneSeparator kind="inspector" />
                <InspectorPane />
              </box>
            </Match>
            <Match when={layout().composition === "medium"}>
              <box flexGrow={1} minHeight={0} minWidth={0} flexDirection={rowDirection(direction())}>
                <TimelinePane />
                <PaneSeparator kind="inspector" />
                <InspectorPane />
              </box>
            </Match>
            <Match when={layout().composition === "narrow"}>
              <box flexGrow={1} minHeight={0} minWidth={0} flexDirection="column">
                <Show when={stage() === "parents"}>
                  <ParentPane />
                </Show>
                <Show when={stage() === "timeline"}>
                  <TimelinePane />
                </Show>
                <Show when={stage() === "inspector"}>
                  <InspectorPane />
                </Show>
              </box>
            </Match>
          </Switch>
        </Match>
      </Switch>
    </box>
  )
}

function controlCommittedMessage(action: SupervisionControlAction | undefined) {
  if (action?.type === "steer") return "Guidance committed."
  if (action?.type === "retry") return "Retry admitted."
  if (action?.type === "dismiss-recovery") return "Recovery dismissed."
  return "Cancellation requested."
}

export function timelineTrack(operation: ProjectedOperation, observedAt: number) {
  const timeline = operation.timeline
  const end = timeline.concludedAt ?? observedAt
  const phases = [
    duration("Queue", timeline.admittedAt, timeline.permitClaimedAt ?? end),
    timeline.permitClaimedAt === undefined
      ? undefined
      : duration("Starting", timeline.permitClaimedAt, timeline.executionStartedAt ?? end),
    timeline.executionStartedAt === undefined
      ? undefined
      : duration(
          timeline.executionEndSource === "startup_reconciliation"
            ? "Executing (uncertain end: startup reconciliation)"
            : "Executing",
          timeline.executionStartedAt,
          timeline.executionEndedAt ?? end,
        ),
    timeline.executionEndedAt === undefined
      ? undefined
      : duration("Finalizing", timeline.executionEndedAt, timeline.concludedAt ?? observedAt),
    operation.presentationState === "terminal" ? "Terminal" : undefined,
  ].filter((value): value is string => value !== undefined)
  const overlays = timeline.permissionWaits.map((wait) =>
    duration("Waiting", wait.startedAt, wait.endedAt ?? observedAt),
  )
  return `${phases.join(" | ")}${overlays.length === 0 ? "" : ` || overlays: ${overlays.join(", ")}`}`
}

function timelineGeometry(operation: ProjectedOperation, observedAt: number, width: number) {
  const timeline = operation.timeline
  const end = timeline.concludedAt ?? observedAt
  const intervals = [
    { label: "Q" as const, start: timeline.admittedAt, end: timeline.permitClaimedAt ?? end },
    timeline.permitClaimedAt === undefined
      ? undefined
      : { label: "S" as const, start: timeline.permitClaimedAt, end: timeline.executionStartedAt ?? end },
    timeline.executionStartedAt === undefined
      ? undefined
      : { label: "R" as const, start: timeline.executionStartedAt, end: timeline.executionEndedAt ?? end },
    timeline.executionEndedAt === undefined
      ? undefined
      : { label: "F" as const, start: timeline.executionEndedAt, end: timeline.concludedAt ?? observedAt },
  ].filter((value): value is NonNullable<typeof value> => value !== undefined)
  const durations = intervals.map((interval) => Math.max(0, interval.end - interval.start))
  const total = Math.max(1, durations.reduce((sum, value) => sum + value, 0))
  const available = Math.max(0, width - intervals.length * 2)
  const initial = durations.map((value) => 2 + Math.floor((value / total) * available))
  const used = initial.reduce((sum, value) => sum + value, 0)
  const widths = initial.map((value, index) => (index === initial.length - 1 ? value + width - used : value))
  const span = Math.max(1, end - timeline.admittedAt)
  return {
    segments: intervals.map((interval, index) => ({ label: interval.label, width: widths[index] })),
    waits: timeline.permissionWaits.map((wait) => {
      const start = Math.max(
        0,
        Math.min(width - 1, Math.floor(((wait.startedAt - timeline.admittedAt) / span) * width)),
      )
      return {
        start,
        width: Math.max(
          1,
          Math.min(width - start, Math.ceil((((wait.endedAt ?? end) - wait.startedAt) / span) * width)),
        ),
      }
    }),
  }
}

function timelineColor(label: "Q" | "S" | "R" | "F", theme: Context["theme"]) {
  if (label === "Q") return theme.text.subdued
  if (label === "S") return theme.text.feedback.info.default
  if (label === "R") return theme.text.feedback.success.default
  return theme.text.feedback.warning.default
}

export function operationInspector(operation: ProjectedOperation, observedAt: number) {
  return [
    `Operation ${ltrDirection(operation.id)} (batch ${ltrDirection(operation.batchID)}, index ${ltrDirection(operation.index)})`,
    `Parent ${ltrDirection(operation.parentID)}${operation.childID ? ` | Child ${ltrDirection(operation.childID)}` : ""}`,
    `Agent ${ltrDirection(operation.agent)} | Model ${ltrDirection(`${operation.model.providerID}/${operation.model.modelID}`)}${operation.model.variant ? ` (${ltrDirection(operation.model.variant)})` : ""}`,
    `State ${ltrDirection(operation.presentationState)} | Observed ${ltrDirection(observedAt)}`,
    ltrDirection(timelineTrack(operation, observedAt)),
    ...(operation.timeline.executionEndSource
      ? [
          `Execution end: ${operation.timeline.executionEndSource === "startup_reconciliation" ? "uncertain startup reconciliation boundary" : "Session event"}`,
        ]
      : []),
    ...(operation.outcome
      ? [
          `Outcome ${ltrDirection(operation.outcome.state)}: ${ltrDirection(operation.outcome.reason.code)}${operation.outcome.reason.detail ? ` - ${autoDirection(operation.outcome.reason.detail)}` : ""}`,
        ]
      : []),
    ...(operation.recovery
      ? [
          `Recovery ${ltrDirection(operation.recovery.episodeID)} at ${ltrDirection(operation.recovery.reconciledAt)}: previous ${ltrDirection(operation.recovery.previousState)}, ${operation.recovery.eligible ? "eligible" : "resolved"}`,
        ]
      : []),
    ...(operation.retryOfOperationID ? [`Retry of ${ltrDirection(operation.retryOfOperationID)}`] : []),
  ]
}

function duration(label: string, start: number, end: number) {
  return `${label} ${Math.max(0, end - start)}ms`
}

function failureGuidance(code: SynchronizationFailure["code"] | undefined) {
  if (code === "plugin_unavailable") return "Enable the Delegation plugin for this Location, then refresh."
  if (code === "query_unavailable") return "Use a Delegation plugin version that supports this supervision query."
  if (code === "invalid_request") return "Update the Delegation plugin and TUI together, then refresh."
  if (code === "timeout") return "Check the current connection and try Refresh again."
  if (code === "coordinator_unavailable") return "Inspect the Delegation coordinator status and configuration."
  if (code === "projection_invalid") return "Inspect the Delegation store and coordinator diagnostics."
  return "Inspect the Delegation plugin diagnostics and try Refresh again."
}

function healthGuidance(reason: string | undefined) {
  if (reason === "options_conflict" || reason === "invalid_options")
    return "Review the active Delegation plugin configuration."
  if (reason === "monitor_failed" || reason === "monitor_stopped")
    return "Inspect the Delegation event monitor diagnostics."
  if (reason === "startup_failed") return "Inspect the Delegation coordinator startup diagnostics."
  return "Inspect the Delegation store diagnostics."
}

function routeValue(value: unknown): Route | undefined {
  if (!value || typeof value !== "object" || !("type" in value)) return
  if (value.type === "home") return { type: "home" }
  if (value.type === "session" && "sessionID" in value && typeof value.sessionID === "string")
    return { type: "session", sessionID: value.sessionID }
  if (
    value.type === "plugin" &&
    "id" in value &&
    typeof value.id === "string" &&
    "name" in value &&
    typeof value.name === "string"
  ) {
    const data =
      "data" in value && typeof value.data === "object" && value.data !== null && !Array.isArray(value.data)
        ? { ...value.data }
        : undefined
    return { type: "plugin", id: value.id, name: value.name, ...(data ? { data } : {}) }
  }
}

function Commands(props: { readonly context: Context }) {
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "delegation.supervision.open",
        title: "Open Delegation supervision",
        group: "Delegation",
        palette: true,
        slash: { name: "delegations" },
        run() {
          const destination = openSupervision(props.context.ui.router.current())
          if (destination) props.context.ui.router.navigate(destination)
          props.context.ui.dialog.clear()
        },
      },
    ],
  }))
  return null
}

export default Plugin.define({
  id: ID,
  setup(context) {
    const [memory, updateMemory] = context.storage.memory<PresentationMemory>("supervision", {
      initial: { locations: {} },
    })
    context.ui.router.register({
      name: PAGE,
      render: () => <SupervisionPage context={context} memory={memory} updateMemory={updateMemory} />,
    })
    context.ui.slot({ append: "app", render: () => <Commands context={context} /> })
  },
})

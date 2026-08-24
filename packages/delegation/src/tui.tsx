/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import type { Context, Destination, Route } from "@opencode-ai/plugin/tui/context"
import { createEffect, createMemo, createResource, createSignal, For, Match, Show, Switch } from "solid-js"
import {
  initialFailure,
  loadSupervision,
  loadSupervisionPage,
  mergeHistoryPage,
  reconcileHistoryRefresh,
  type ProjectedOperation,
  supervisionView,
  type WorkspaceResult,
} from "./supervision.js"

const PAGE = "supervision"
const ID = "opencode.delegation"

export function openSupervision(route: Route): Destination | undefined {
  if (route.type === "plugin" && route.id === ID && route.name === PAGE) return
  const returnRoute = structuredClone(route)
  return {
    type: "plugin",
    name: PAGE,
    data: {
      ...(route.type === "session" ? { entrySessionID: route.sessionID } : {}),
      returnRoute,
    },
  }
}

export function returnFromSupervision(route: Route, sessionExists: (sessionID: string) => boolean): Route {
  if (route.type !== "plugin" || route.id !== ID || route.name !== PAGE) return { type: "home" }
  const target = routeValue(route.data?.returnRoute)
  if (!target) return { type: "home" }
  if (target.type === "session" && !sessionExists(target.sessionID)) return { type: "home" }
  if (target.type === "plugin" && target.id === ID && target.name === PAGE) return { type: "home" }
  return target
}

function SupervisionPage(props: { readonly context: Context }) {
  const entry = () => {
    const route = props.context.ui.router.current()
    if (route.type !== "plugin" || route.id !== ID || route.name !== PAGE) return
    const value = route.data?.entrySessionID
    return typeof value === "string" ? value : undefined
  }
  const [current, setCurrent] = createSignal<WorkspaceResult>()
  const [refreshRequest, setRefreshRequest] = createSignal<{
    readonly generation: number
    readonly history: ReadonlyArray<{
      readonly parentID: string
      readonly limit: number
      readonly operationID?: string
    }>
  }>()
  const [workspace] = createResource(
    () => ({ entrySessionID: entry(), refresh: refreshRequest() }),
    (input) => loadSupervision(props.context.client, input.entrySessionID, input.refresh),
  )
  const [search, setSearch] = createSignal("")
  const [actionableOnly, setActionableOnly] = createSignal(false)
  const [paginationFailure, setPaginationFailure] = createSignal<{
    readonly parentID: string
    readonly cursor: string
  }>()
  const [loadingParent, setLoadingParent] = createSignal<string>()
  const [paging, setPaging] = createSignal(false)
  createEffect(() => {
    const result = workspace()
    if (!result) return
    setCurrent((value) =>
      value?.type === "workspace" && result.type === "workspace" ? reconcileHistoryRefresh(value, result) : result,
    )
  })
  const failure = createMemo(() => (workspace.error ? initialFailure(workspace.error) : undefined))
  const view = createMemo(() =>
    supervisionView(current(), failure(), {
      search: search(),
      actionableOnly: actionableOnly(),
    }),
  )
  const failed = createMemo(() => {
    const current = view()
    if (current.type === "failure") return current
  })
  const ready = createMemo(() => {
    const current = view()
    if (current.type === "ready") return current
  })
  const selectedParent = createMemo(() => {
    const visible = ready()?.parents
    if (!visible) return
    const result = current()
    return (
      visible.find(
        (parent) => parent.session.id === (result?.type === "workspace" ? result.focus?.parentID : undefined),
      )?.session.id ?? visible[0]?.session.id
    )
  })
  const selectedOperation = createMemo(() => {
    const parent = ready()?.parents.find((candidate) => candidate.session.id === selectedParent())
    const result = current()
    const operationID = result?.type === "workspace" ? result.focus?.operationID : undefined
    return parent?.operations.find((operation) => operation.id === operationID) ?? parent?.operations[0]
  })
  const observedAt = createMemo(() => {
    const result = current()
    return result?.type === "workspace" ? result.observedAt : 0
  })
  const selectedOperationID = createMemo(() => selectedOperation()?.id)
  const health = createMemo(() => {
    const result = current()
    if (result?.type === "workspace" && result.health.status === "degraded") return result.health
  })
  const loadOlder = async () => {
    const result = current()
    if (result?.type !== "workspace") return
    const available = result.parents.filter((parent) => parent.nextCursor)
    if (available.length === 0 || paging() || workspace.loading) return
    setPaging(true)
    const parentID =
      available.length === 1
        ? available[0].session.id
        : await props.context.ui.dialog.select({
            title: "Load older Delegation history",
            current: selectedParent(),
            options: available.map((parent) => ({
              title: parent.session.title ?? parent.session.id,
              value: parent.session.id,
              description: `${parent.operations.length} loaded / ${parent.counts.total} retained`,
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
    try {
      const page = await loadSupervisionPage(props.context.client, {
        generation: result.generation,
        parentID: parent.session.id,
        cursor,
        limit: Math.max(1, parent.operations.length),
      })
      setCurrent((value) => (value?.type === "workspace" ? mergeHistoryPage(value, page) : value))
      setPaginationFailure(undefined)
    } catch {
      setPaginationFailure({ parentID: parent.session.id, cursor })
    } finally {
      setLoadingParent(undefined)
      setPaging(false)
    }
  }
  const theme = props.context.theme

  props.context.keymap.layer(() => ({
    commands: [
      {
        id: "delegation.supervision.back",
        title: "Back from Delegation supervision",
        bind: "esc",
        run() {
          props.context.ui.router.navigate(
            returnFromSupervision(props.context.ui.router.current(), (sessionID) =>
              Boolean(props.context.data.session.get(sessionID)),
            ),
          )
        },
      },
      {
        id: "delegation.supervision.refresh",
        title: "Refresh Delegation supervision",
        bind: "ctrl+r",
        run() {
          const result = current()
          if (result?.type !== "workspace" || paging() || workspace.loading) return
          setRefreshRequest({
            generation: result.generation + 1,
            history: result.parents.map((parent) => ({
              parentID: parent.session.id,
              limit: Math.max(1, parent.operations.length),
              ...(parent.session.id === result.focus?.parentID && result.focus.operationID
                ? { operationID: result.focus.operationID }
                : {}),
            })),
          })
        },
      },
      {
        id: "delegation.supervision.filter.search",
        title: "Search Delegation history",
        bind: "ctrl+f",
        async run() {
          const value = await props.context.ui.dialog.prompt({
            title: "Search Delegation history",
            description: "Search tasks, identifiers, and Sessions",
            value: search(),
          })
          if (value !== undefined) setSearch(value)
        },
      },
      {
        id: "delegation.supervision.history.older",
        title: "Load older Delegation history",
        bind: "ctrl+o",
        run: loadOlder,
      },
      {
        id: "delegation.supervision.filter.actionable",
        title: "Toggle actionable Delegations",
        bind: "ctrl+a",
        run() {
          setActionableOnly((value) => !value)
        },
      },
    ],
  }))

  return (
    <box flexDirection="column" padding={1} gap={1}>
      <text fg={theme.text.default}>Delegation supervision</text>
      <text fg={theme.text.subdued}>
        Search: {search() || "all"} (Ctrl+F) | {actionableOnly() ? "actionable only" : "all states"} (Ctrl+A)
      </text>
      <Show when={health()}>
        <text fg={theme.text.feedback.warning.default}>Degraded coordinator data: {health()?.reason}</text>
      </Show>
      <Switch>
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
        <Match when={failed()}>
          <text fg={theme.text.feedback.error.default}>Delegation supervision is unavailable: {failed()?.code}</text>
        </Match>
        <Match when={ready()}>
          <For each={ready()?.parents ?? []}>
            {(parent) => (
              <box flexDirection="column">
                <box flexDirection="row" gap={2}>
                  <text fg={theme.text.subdued}>{selectedParent() === parent.session.id ? ">" : " "}</text>
                  <text fg={theme.text.default}>{parent.session.title ?? parent.session.id}</text>
                  <text fg={theme.text.subdued}>
                    {parent.counts.actionable} actionable / {parent.counts.total} retained
                  </text>
                  <Show when={parent.session.archived}>
                    <text fg={theme.text.subdued}>archived</text>
                  </Show>
                </box>
                <For each={parent.batches}>
                  {(batch) => (
                    <box flexDirection="column">
                      <text fg={theme.text.subdued}> Batch {batch.id}</text>
                      <For each={parent.operations.filter((operation) => operation.batchID === batch.id)}>
                        {(operation) => (
                          <text fg={theme.text.subdued}>
                            {selectedOperationID() === operation.id ? "  > " : "    "}
                            {operation.text} [{operation.presentationState}] {timelineTrack(operation, observedAt())}
                          </text>
                        )}
                      </For>
                    </box>
                  )}
                </For>
                <Show when={parent.nextCursor}>
                  <text fg={theme.text.subdued}>
                    {loadingParent() === parent.session.id
                      ? "Loading older history..."
                      : paginationFailure()?.parentID === parent.session.id &&
                          paginationFailure()?.cursor === parent.nextCursor
                        ? "Load older history failed. Press Ctrl+O to retry."
                        : "Load older history (Ctrl+O)"}
                  </text>
                </Show>
              </box>
            )}
          </For>
          <Show when={selectedOperation()}>
            {(operation: () => ProjectedOperation) => (
              <box flexDirection="column" marginTop={1}>
                <text fg={theme.text.default}>Operation inspector</text>
                <For each={operationInspector(operation(), observedAt())}>
                  {(line) => <text fg={theme.text.subdued}>{line}</text>}
                </For>
              </box>
            )}
          </Show>
        </Match>
      </Switch>
    </box>
  )
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

export function operationInspector(operation: ProjectedOperation, observedAt: number) {
  return [
    `Operation ${operation.id} (batch ${operation.batchID}, index ${operation.index})`,
    `Parent ${operation.parentID}${operation.childID ? ` | Child ${operation.childID}` : ""}`,
    `Agent ${operation.agent} | Model ${operation.model.providerID}/${operation.model.modelID}${operation.model.variant ? ` (${operation.model.variant})` : ""}`,
    `State ${operation.presentationState} | Observed ${observedAt}`,
    timelineTrack(operation, observedAt),
    ...(operation.timeline.executionEndSource
      ? [
          `Execution end: ${operation.timeline.executionEndSource === "startup_reconciliation" ? "uncertain startup reconciliation boundary" : "Session event"}`,
        ]
      : []),
    ...(operation.outcome
      ? [
          `Outcome ${operation.outcome.state}: ${operation.outcome.reason.code}${operation.outcome.reason.detail ? ` - ${operation.outcome.reason.detail}` : ""}`,
        ]
      : []),
    ...(operation.recovery
      ? [
          `Recovery ${operation.recovery.episodeID} at ${operation.recovery.reconciledAt}: previous ${operation.recovery.previousState}, ${operation.recovery.eligible ? "eligible" : "resolved"}`,
        ]
      : []),
    ...(operation.retryOfOperationID ? [`Retry of ${operation.retryOfOperationID}`] : []),
  ]
}

function duration(label: string, start: number, end: number) {
  return `${label} ${Math.max(0, end - start)}ms`
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
        ? structuredClone(value.data)
        : undefined
    return { type: "plugin", id: value.id, name: value.name, ...(data ? { data } : {}) }
  }
}

export default Plugin.define({
  id: ID,
  setup(context) {
    context.ui.router.register({
      name: PAGE,
      render: () => <SupervisionPage context={context} />,
    })
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "delegation.supervision.open",
          title: "Open Delegation supervision",
          group: "Delegation",
          palette: true,
          slash: { name: "delegations" },
          run() {
            const destination = openSupervision(context.ui.router.current())
            if (destination) context.ui.router.navigate(destination)
            context.ui.dialog.clear()
          },
        },
      ],
    }))
  },
})

/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode-ai/plugin/tui"
import type { Context, Destination, Route } from "@opencode-ai/plugin/tui/context"
import { createMemo, createResource, For, Match, Show, Switch } from "solid-js"
import {
  initialFailure,
  loadSupervision,
  type ProjectedOperation,
  supervisionView,
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
  const [workspace] = createResource(
    () => ({ entrySessionID: entry() }),
    (input) => loadSupervision(props.context.client, input.entrySessionID),
  )
  const failure = createMemo(() => (workspace.error ? initialFailure(workspace.error) : undefined))
  const view = createMemo(() =>
    supervisionView(workspace(), failure(), {
      search: "",
      actionableOnly: false,
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
    const current = workspace()
    if (current?.type === "workspace") return current.focus?.parentID
  })
  const selectedOperation = createMemo(() => {
    const current = workspace()
    if (current?.type !== "workspace") return undefined
    const parent = current.parents.find((candidate) => candidate.session.id === current.focus?.parentID)
    return (
      parent?.operations.find((operation) => operation.id === current.focus?.operationID) ?? parent?.operations[0]
    )
  })
  const observedAt = createMemo(() => {
    const current = workspace()
    return current?.type === "workspace" ? current.observedAt : 0
  })
  const selectedOperationID = createMemo(() => selectedOperation()?.id)
  const health = createMemo(() => {
    const current = workspace()
    if (current?.type === "workspace" && current.health.status === "degraded") return current.health
  })
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
    ],
  }))

  return (
    <box flexDirection="column" padding={1} gap={1}>
      <text fg={theme.text.default}>Delegation supervision</text>
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
          <text fg={theme.text.feedback.error.default}>
            Delegation supervision is unavailable: {failed()?.code}
          </text>
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
                <For each={parent.operations}>
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
  const overlays = timeline.permissionWaits.map((wait) => duration("Waiting", wait.startedAt, wait.endedAt ?? observedAt))
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
      ? [`Outcome ${operation.outcome.state}: ${operation.outcome.reason.code}${operation.outcome.reason.detail ? ` - ${operation.outcome.reason.detail}` : ""}`]
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

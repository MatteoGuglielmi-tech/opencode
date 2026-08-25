import { randomUUID } from "node:crypto"
import path from "node:path"

const marker = process.env.DELEGATION_ACCEPTANCE_MARKER ?? `delegation-acceptance-${randomUUID()}`
const root = path.resolve(import.meta.dir, "../../..")

const layers = [
  {
    id: "delegation",
    label: "Package harness",
    directory: path.join(root, "packages/delegation"),
    args: [
      "test",
      "test/acceptance.test.ts",
      "test/workspace.test.ts",
      "test/timeline.test.ts",
      "test/synchronization.test.ts",
      "test/supervision-controls.test.ts",
      "test/permission-controls.test.ts",
      "test/presentation.test.ts",
      "test/responsive.test.ts",
      "test/tui.test.ts",
      "--timeout",
      "30000",
    ],
  },
  {
    id: "query",
    label: "Generic Plugin query integration",
    directory: path.join(root, "packages/server"),
    args: ["test", "test/plugin-query.test.ts", "--timeout", "30000"],
  },
  {
    id: "host",
    label: "TUI host seam",
    directory: path.join(root, "packages/tui"),
    args: ["test", "test/plugin-discovery.test.ts", "test/plugin-hot-reload.test.tsx", "--timeout", "30000"],
  },
] as const

type LayerID = (typeof layers)[number]["id"]
type Evidence = { readonly layer: LayerID; readonly test: string }

const requirements: ReadonlyArray<{
  readonly requirement: string
  readonly evidence: ReadonlyArray<Evidence>
}> = [
  row("Marked mixed-state scenario and retained unrelated history", "delegation", "qualifies the complete marked mixed-state supervision scenario without clearing retained history"),
  row("Location-scoped parent discovery, nesting, archival, and cross-Location exclusion", "delegation", "discovers retained Location parents and orders actionable work first"),
  row("Stable parent, batch, and operation ordering", "delegation", "orders equal groups by newest retained activity and stable parent ID"),
  row("Independent pagination, retained history, complete summaries, and stable anchors", "delegation", "pages parents independently and refreshes the expanded loaded depth"),
  row("Chronology validation and typed invalid projection", "delegation", "fails impossible chronology as a typed invalid projection"),
  row("Milestones, permission waits, Finalizing, Terminal outcomes, and observation bounds", "delegation", "retains immutable milestones, aggregate permission waits, Finalizing, and Terminal truth"),
  row("Startup reconciliation, uncertain endpoints, and recoverable interruption", "delegation", "marks restart execution endpoints as uncertain and closes open permission waits"),
  row("Authenticated namespaced Plugin queries and generated clients", "query", "invokes authenticated Location-scoped plugin queries without Session history"),
  row("Plugin activation cleanup, validation, typed failures, and no Session mutation", "query", "invokes authenticated Location-scoped plugin queries without Session history"),
  row("Complete projection version negotiation", "delegation", "maps query output and typed initial failures into externally testable page states"),
  row("Immediate and periodic refresh with and without event hints", "delegation", "polls active work every second and terminal work every five seconds without event hints", "event hints request an early snapshot and coalesce while refresh is running"),
  row("Atomic Delegation and permission synchronization", "delegation", "applies delegation facts and required child permissions atomically"),
  row("Two-client changes appear without focus theft", "delegation", "qualifies the complete marked mixed-state supervision scenario without clearing retained history"),
  row("Refresh and pagination serialization", "delegation", "serializes pagination with refresh and drops queued refresh work after unmount"),
  row("Stable focus under concurrent changes and nearest fallback", "delegation", "reloads current depth and preserves stable focus across concurrent insertion", "keeps valid inspection focus and falls back to the nearest surviving operation"),
  row("Both entries, idempotent re-entry, and exact return route", "delegation", "registers one page and one shared palette and slash command", "re-entry preserves the original return route and current page state", "returns to the captured route and falls home when a target disappeared"),
  row("Child navigation uses host tabs and Session routing", "delegation", "opens a child through the owning root tab before host Session navigation"),
  row("Filter adjustment, restoration, and stable scroll identities", "delegation", "explicit child entry clears only filters that exclude its operation", "removed selections and anchors use the nearest surviving identity"),
  row("Process-local memory survives TUI host hot reload", "host", "memory storage survives hot reload while disk storage persists"),
  row("TUI host discovers project plugin entries", "host", "discovers project TUI plugin files in stable order"),
  row("Operation and batch cancellation eligibility and confirmation counts", "delegation", "counts fresh batch cancellation scope and targets only non-terminal members"),
  row("Steer pending state and draft retention", "delegation", "keeps unresolved Steer pending, blocks duplicate submission, and preserves its text"),
  row("Retry and Dismiss recovery eligibility and commitment", "delegation", "submits retry and dismiss as separate stable Control episodes"),
  row("Stable Control identity across uncertain transport", "delegation", "reuses one invocation identity after uncertain transport and marks only submitted targets"),
  row("Control rejection, conflict, concurrent change, and reconciliation", "delegation", "reconciles an eligibility race without replacing the invocation identity", "treats invocation conflict as non-retryable and retains reportable diagnostics"),
  row("Permission ordering and conditional Always allow", "delegation", "preserves server order and offers Always allow only with a save scope"),
  row("Allow once, Always allow, Reject, and request-specific pending", "delegation", "allows overlapping requests to resolve independently with every reply", "tracks pending state by request while other requests stay actionable"),
  row("Permission expiry and uncertain reply reconciliation", "delegation", "refreshes an expiry race and reports that no decision was applied", "reconciles uncertain transport by identity without replay and permits deliberate resubmission"),
  row("Loading, live, stale, timeout, retained view, and mutation denial", "delegation", "times out after five seconds, retains the complete view, and retries with bounded backoff"),
  row("Degraded safe replacement and frozen observation boundary", "delegation", "a safe degraded snapshot replaces older data and freezes timing at its observation"),
  row("Backoff schedule and explicit Refresh", "delegation", "uses one, two, four, eight, then fifteen second retry delays and explicit refresh bypasses them"),
  row("Unavailable and supported-version page states with typed guidance", "delegation", "maps query output and typed initial failures into externally testable page states"),
  row("Mutation denial for every non-live operation state", "delegation", "disables decisions for cancellation, terminal, stale, degraded, and unavailable operation state"),
  row("Wide, medium, narrow, boundary, representative, and 50x16 rendering", "delegation", "renders the registered page from the package query without a Session command or coordinator store", "uses the accepted compositions at exact boundaries"),
  row("Keyboard and pointer selection, scrolling, actions, and resizing", "delegation", "renders the registered page from the package query without a Session command or coordinator store", "keyboard and pointer deltas resize the requested logical edge"),
  row("LTR, forced RTL, Arabic, mixed-direction isolation, and chronology", "delegation", "renders the registered page from the package query without a Session command or coordinator store", "keeps direction independent from content and isolates mixed text"),
  row("Logical RTL navigation and resize deltas", "delegation", "maps physical horizontal input to logical RTL navigation and resizing"),
  row("Compact textual state and inspectable timeline identity", "delegation", "renders compact textual state and inspectable identity, context, model, outcome, and recovery"),
  manualRow("Only the isolated service restarts and opencode2 identity remains unchanged"),
  manualRow("Checked checklist and successful command output are retained"),
]

const manualSteps = new Map<string, string>([
  ["Marked mixed-state scenario and retained unrelated history", "2, 6, 7, 8"],
  ["Location-scoped parent discovery, nesting, archival, and cross-Location exclusion", "2"],
  ["Stable parent, batch, and operation ordering", "2"],
  ["Independent pagination, retained history, complete summaries, and stable anchors", "2"],
  ["Startup reconciliation, uncertain endpoints, and recoverable interruption", "6, 7"],
  ["Two-client changes appear without focus theft", "2, 4"],
  ["Both entries, idempotent re-entry, and exact return route", "1"],
  ["Child navigation uses host tabs and Session routing", "3, 5, 6"],
  ["Filter adjustment, restoration, and stable scroll identities", "3"],
  ["Process-local memory survives TUI host hot reload", "3"],
  ["TUI host discovers project plugin entries", "3"],
  ["Operation and batch cancellation eligibility and confirmation counts", "5"],
  ["Steer pending state and draft retention", "5"],
  ["Retry and Dismiss recovery eligibility and commitment", "8"],
  ["Permission ordering and conditional Always allow", "4"],
  ["Allow once, Always allow, Reject, and request-specific pending", "4"],
  ["Loading, live, stale, timeout, retained view, and mutation denial", "6"],
  ["Backoff schedule and explicit Refresh", "6"],
  ["Wide, medium, narrow, boundary, representative, and 50x16 rendering", "9"],
  ["Keyboard and pointer selection, scrolling, actions, and resizing", "9"],
  ["LTR, forced RTL, Arabic, mixed-direction isolation, and chronology", "9"],
  ["Logical RTL navigation and resize deltas", "9"],
  ["Only the isolated service restarts and opencode2 identity remains unchanged", "6, 10"],
  ["Checked checklist and successful command output are retained", "10"],
])

const results = await layers.reduce(
  async (pending, layer) => {
    const previous = await pending
    const child = Bun.spawn([process.execPath, ...layer.args], {
      cwd: layer.directory,
      env: { ...Bun.env, DELEGATION_ACCEPTANCE_MARKER: marker },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    return [...previous, { ...layer, output: `${stdout}\n${stderr}`, exitCode }]
  },
  Promise.resolve([] as Array<(typeof layers)[number] & { readonly output: string; readonly exitCode: number }>),
)

const evidence = requirements.map((requirement) => {
  const missing = requirement.evidence.filter((item) => {
    const result = results.find((candidate) => candidate.id === item.layer)
    if (!result || result.exitCode !== 0) return true
    const lines = result.output.split("\n")
    return (
      !lines.some((line) => line.includes("(pass)") && line.includes(item.test)) ||
      lines.some((line) => line.includes("(skip)") && line.includes(item.test))
    )
  })
  return {
    ...requirement,
    status: missing.length > 0 ? "FAIL" : requirement.evidence.length === 0 ? "MANUAL" : "PASS",
    missing,
  }
})

console.log(`# Delegation supervision acceptance\n`)
console.log(`Marker: ${marker}\n`)
console.log("| Requirement | Named tests | Manual steps | Status |")
console.log("| --- | --- | --- | --- |")
console.log(
  evidence
    .map(
      (item) =>
        `| ${item.requirement} | ${item.evidence.map((entry) => `\`${entry.test}\``).join("<br>") || "Manual only"} | ${manualSteps.get(item.requirement) ?? "Automation only"} | ${item.status} |`,
    )
    .join("\n"),
)
console.log("\n| Automated layer | Exit |")
console.log("| --- | --- |")
console.log(results.map((result) => `| ${result.label} | ${result.exitCode} |`).join("\n"))

const failedLayers = results.filter((result) => result.exitCode !== 0)
const failedEvidence = evidence.filter((item) => item.status === "FAIL")
if (failedLayers.length === 0 && failedEvidence.length === 0) process.exit(0)

console.error(
  failedLayers.map((result) => `\n## ${result.label} failure\n\n${result.output.trim()}`).join("\n"),
)
console.error(
  failedEvidence
    .map(
      (item) =>
        `Missing required evidence for ${item.requirement}:\n${item.missing.map((missing) => `- [${missing.layer}] ${missing.test}`).join("\n")}`,
    )
    .join("\n"),
)
process.exit(1)

function row(requirement: string, layer: LayerID, ...tests: ReadonlyArray<string>) {
  return { requirement, evidence: tests.map((test) => ({ layer, test })) }
}

function manualRow(requirement: string) {
  return { requirement, evidence: [] as ReadonlyArray<Evidence> }
}

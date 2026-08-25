# Delegation supervision acceptance

Marker: delegation-acceptance-20260825-automated

| Requirement | Named tests | Manual steps | Status |
| --- | --- | --- | --- |
| Marked mixed-state scenario and retained unrelated history | `qualifies the complete marked mixed-state supervision scenario without clearing retained history` | 2, 6, 7, 8 | PASS |
| Location-scoped parent discovery, nesting, archival, and cross-Location exclusion | `discovers retained Location parents and orders actionable work first` | 2 | PASS |
| Stable parent, batch, and operation ordering | `orders equal groups by newest retained activity and stable parent ID` | 2 | PASS |
| Independent pagination, retained history, complete summaries, and stable anchors | `pages parents independently and refreshes the expanded loaded depth` | 2 | PASS |
| Chronology validation and typed invalid projection | `fails impossible chronology as a typed invalid projection` | Automation only | PASS |
| Milestones, permission waits, Finalizing, Terminal outcomes, and observation bounds | `retains immutable milestones, aggregate permission waits, Finalizing, and Terminal truth` | Automation only | PASS |
| Startup reconciliation, uncertain endpoints, and recoverable interruption | `marks restart execution endpoints as uncertain and closes open permission waits` | 6, 7 | PASS |
| Authenticated namespaced Plugin queries and generated clients | `invokes authenticated Location-scoped plugin queries without Session history` | Automation only | PASS |
| Plugin activation cleanup, validation, typed failures, and no Session mutation | `invokes authenticated Location-scoped plugin queries without Session history` | Automation only | PASS |
| Complete projection version negotiation | `maps query output and typed initial failures into externally testable page states` | Automation only | PASS |
| Immediate and periodic refresh with and without event hints | `polls active work every second and terminal work every five seconds without event hints`<br>`event hints request an early snapshot and coalesce while refresh is running` | Automation only | PASS |
| Atomic Delegation and permission synchronization | `applies delegation facts and required child permissions atomically` | Automation only | PASS |
| Two-client changes appear without focus theft | `qualifies the complete marked mixed-state supervision scenario without clearing retained history` | 2, 4 | PASS |
| Refresh and pagination serialization | `serializes pagination with refresh and drops queued refresh work after unmount` | Automation only | PASS |
| Stable focus under concurrent changes and nearest fallback | `reloads current depth and preserves stable focus across concurrent insertion`<br>`keeps valid inspection focus and falls back to the nearest surviving operation` | Automation only | PASS |
| Both entries, idempotent re-entry, and exact return route | `registers one page and one shared palette and slash command`<br>`re-entry preserves the original return route and current page state`<br>`returns to the captured route and falls home when a target disappeared` | 1 | PASS |
| Child navigation uses host tabs and Session routing | `opens a child through the owning root tab before host Session navigation` | 3, 5, 6 | PASS |
| Filter adjustment, restoration, and stable scroll identities | `explicit child entry clears only filters that exclude its operation`<br>`removed selections and anchors use the nearest surviving identity` | 3 | PASS |
| Process-local memory survives TUI host hot reload | `memory storage survives hot reload while disk storage persists` | 3 | PASS |
| TUI host discovers project plugin entries | `discovers project TUI plugin files in stable order` | 3 | PASS |
| Operation and batch cancellation eligibility and confirmation counts | `counts fresh batch cancellation scope and targets only non-terminal members` | 5 | PASS |
| Steer pending state and draft retention | `keeps unresolved Steer pending, blocks duplicate submission, and preserves its text` | 5 | PASS |
| Retry and Dismiss recovery eligibility and commitment | `submits retry and dismiss as separate stable Control episodes` | 8 | PASS |
| Stable Control identity across uncertain transport | `reuses one invocation identity after uncertain transport and marks only submitted targets` | Automation only | PASS |
| Control rejection, conflict, concurrent change, and reconciliation | `reconciles an eligibility race without replacing the invocation identity`<br>`treats invocation conflict as non-retryable and retains reportable diagnostics` | Automation only | PASS |
| Permission ordering and conditional Always allow | `preserves server order and offers Always allow only with a save scope` | 4 | PASS |
| Allow once, Always allow, Reject, and request-specific pending | `allows overlapping requests to resolve independently with every reply`<br>`tracks pending state by request while other requests stay actionable` | 4 | PASS |
| Permission expiry and uncertain reply reconciliation | `refreshes an expiry race and reports that no decision was applied`<br>`reconciles uncertain transport by identity without replay and permits deliberate resubmission` | Automation only | PASS |
| Loading, live, stale, timeout, retained view, and mutation denial | `times out after five seconds, retains the complete view, and retries with bounded backoff` | 6 | PASS |
| Degraded safe replacement and frozen observation boundary | `a safe degraded snapshot replaces older data and freezes timing at its observation` | Automation only | PASS |
| Backoff schedule and explicit Refresh | `uses one, two, four, eight, then fifteen second retry delays and explicit refresh bypasses them` | 6 | PASS |
| Unavailable and supported-version page states with typed guidance | `maps query output and typed initial failures into externally testable page states` | Automation only | PASS |
| Mutation denial for every non-live operation state | `disables decisions for cancellation, terminal, stale, degraded, and unavailable operation state` | Automation only | PASS |
| Wide, medium, narrow, boundary, representative, and 50x16 rendering | `renders the registered page from the package query without a Session command or coordinator store`<br>`uses the accepted compositions at exact boundaries` | 9 | PASS |
| Keyboard and pointer selection, scrolling, actions, and resizing | `renders the registered page from the package query without a Session command or coordinator store`<br>`keyboard and pointer deltas resize the requested logical edge` | 9 | PASS |
| LTR, forced RTL, Arabic, mixed-direction isolation, and chronology | `renders the registered page from the package query without a Session command or coordinator store`<br>`keeps direction independent from content and isolates mixed text` | 9 | PASS |
| Logical RTL navigation and resize deltas | `maps physical horizontal input to logical RTL navigation and resizing` | 9 | PASS |
| Compact textual state and inspectable timeline identity | `renders compact textual state and inspectable identity, context, model, outcome, and recovery` | Automation only | PASS |
| Only the isolated service restarts and opencode2 identity remains unchanged | Manual only | 6, 10 | MANUAL |
| Checked checklist and successful command output are retained | Manual only | 10 | MANUAL |

| Automated layer | Exit |
| --- | --- |
| Package harness | 0 |
| Generic Plugin query integration | 0 |
| TUI host seam | 0 |

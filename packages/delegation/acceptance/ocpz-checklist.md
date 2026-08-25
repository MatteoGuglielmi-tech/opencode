# Delegation Supervision `ocpz` Acceptance

Copy this file to `acceptance/runs/<marker>.md` for a qualification run. Stop at the first failure and leave all later steps unchecked.

## Run Record

- Marker: `delegation-acceptance-<UUID>`
- Workspace: `~/dev/delegation-test-workspace`
- Date:
- Commit:
- Client A:
- Client B:
- Initial `opencode2` service identity:
- Final `opencode2` service identity:
- Automated output: `acceptance/runs/<marker>.txt`

From `packages/delegation`, prepare the isolated run:

```sh
PACKAGE="$PWD"
test -f "$PACKAGE/package.json"
set -o pipefail
cd ~/dev/delegation-test-workspace
MARKER="delegation-acceptance-$(uuidgen | tr '[:upper:]' '[:lower:]')"
mkdir -p "$PACKAGE/acceptance/runs"
cp "$PACKAGE/acceptance/ocpz-checklist.md" "$PACKAGE/acceptance/runs/$MARKER.md"
opencode2 service status
ocpz service status
```

Open two `ocpz` clients in this workspace. Use `$MARKER` in every created parent title and delegated task so all run-owned records are searchable. Do not delete or clear retained history.

## Checklist

- [ ] 1. From Client A, enter through the command palette from home and return exactly home. Enter from a Session with `/delegations`, then invoke it again. Confirm Session-aware focus, idempotent re-entry, and exact return navigation.
- [ ] 2. From Client B, create marked work under at least two parent Sessions and multiple batches. In Client A, confirm parent grouping, unrelated retained history, actionable-first movement without focus or scroll theft, newest-first batches, stable operation order, and anchor-preserving `Load older history`.
- [ ] 3. Navigate to a child and back. Change selection, filters, pane sizes, list scroll, and inspector scroll; unmount and re-enter; perform a supported plugin hot reload. Confirm stable-ID restoration and nearest fallback after a selected record disappears. Do not test restoration across TUI process exit.
- [ ] 4. From Client B, create and resolve live work and concurrent permission requests. Confirm automatic cross-client updates without focus theft. Exercise `Allow once`, conditional `Always allow`, and `Reject`, including request-specific pending feedback and authoritative disappearance.
- [ ] 5. Exercise `Cancel operation`, confirmed `Cancel batch` with fresh counts, Steer with its draft retained until commitment, and independent `Open child Session`. Confirm only submitted targets become pending and retained records and children are not presented as deleted.
- [ ] 6. With active, queued, waiting, and recoverable work present, run only `ocpz service restart`. During stale presentation, confirm timing freezes at `observedAt`, typed health and retry guidance remain visible, inspection, navigation, Refresh, and Open child remain available, and every mutation is disabled.
- [ ] 7. Reconnect both clients. Confirm no retained record or permission history duplicates, startup-reconciled endpoints are explicitly uncertain, milestones never move backward, queueing follows coordinator rules, and live timing advances only from fresh `observedAt` values.
- [ ] 8. On separate recoverable operations, exercise Retry and confirmed `Dismiss recovery`. Confirm each consumes only its own eligibility, Retry creates a linked operation without changing selection or filters, and Dismiss retains the original timeline, recovery notice, and child.
- [ ] 9. Exercise `140x40` English LTR Wide, `100x30` English forced-RTL Medium, `70x24` Arabic RTL Narrow, and mixed-direction content at `50x16`. Use keyboard and pointer selection, scrolling, actions, separator focus and resizing, Narrow Back, compact timeline inspection, and logical RTL behavior without reversed chronology.
- [ ] 10. Run `opencode2 service status` and confirm its identity exactly matches the initial record. Run `cd "$PACKAGE" && DELEGATION_ACCEPTANCE_MARKER="$MARKER" bun run acceptance 2>&1 | tee "acceptance/runs/$MARKER.txt"`. Screenshots and release artifacts are not required.

## First Failure

- Step:
- Client:
- Parent Session ID:
- Batch ID:
- Operation ID:
- Permission request ID:
- Freshness:
- `observedAt`:
- Terminal size:
- Direction:
- Locale:
- Observed behavior:

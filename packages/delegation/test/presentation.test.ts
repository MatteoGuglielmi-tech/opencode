import { describe, expect, test } from "bun:test"
import {
  emptyPresentationState,
  locationIdentity,
  reconcilePresentationState,
  sanitizePresentationState,
  type PresentationState,
} from "../src/presentation"
import type { ParentSummary } from "../src/supervision"

describe("Delegation supervision presentation state", () => {
  test("keys process memory by canonical Location identity", () => {
    expect(locationIdentity({ directory: "/repo", workspaceID: "ws" })).toBe('["/repo","ws"]')
    expect(locationIdentity({ directory: "/repo" })).toBe('["/repo",null]')
  })

  test("explicit child entry clears only filters that exclude its operation", () => {
    const state: PresentationState = {
      ...emptyPresentationState(),
      filters: { search: "first", actionableOnly: true },
      selectedParentID: "ses_other",
      selectedOperationID: "dop_other",
    }
    const result = reconcilePresentationState(
      state,
      [
        parent("ses_parent", [
          operation("dop_first", "first", "terminal"),
          operation("dop_child", "second", "terminal", "ses_child"),
        ]),
      ],
      "ses_child",
    )

    expect(result.adjustedFilters).toEqual(["search", "actionableOnly"])
    expect(result.state.filters).toEqual({ search: "", actionableOnly: false })
    expect(result.state.selectedParentID).toBe("ses_parent")
    expect(result.state.selectedOperationID).toBe("dop_child")
  })

  test("explicit child entry wins when that Session is also a retained parent", () => {
    const result = reconcilePresentationState(
      emptyPresentationState(),
      [
        parent("ses_child", [operation("dop_owned", "owned", "queued")]),
        parent("ses_owner", [operation("dop_child", "child", "queued", "ses_child")]),
      ],
      "ses_child",
    )

    expect(result.state.selectedParentID).toBe("ses_owner")
    expect(result.state.selectedOperationID).toBe("dop_child")
  })

  test("non-Session entry preserves filters and chooses only visible records", () => {
    const state: PresentationState = {
      ...emptyPresentationState(),
      filters: { search: "queued", actionableOnly: false },
      selectedParentID: "ses_parent",
      selectedOperationID: "dop_terminal",
    }
    const result = reconcilePresentationState(state, [
      parent("ses_parent", [
        operation("dop_terminal", "done", "terminal"),
        operation("dop_queued", "queued", "queued"),
      ]),
    ])

    expect(result.adjustedFilters).toEqual([])
    expect(result.state.filters.search).toBe("queued")
    expect(result.state.selectedOperationID).toBe("dop_queued")
  })

  test("removed selections and anchors use the nearest surviving identity", () => {
    const state: PresentationState = {
      ...emptyPresentationState(),
      selectedParentID: "ses_parent",
      selectedOperationID: "dop_second",
      parentOrder: ["ses_parent"],
      operationOrder: { ses_parent: ["dop_first", "dop_second", "dop_third"] },
      listAnchors: { ses_parent: { itemID: "dop_second", offset: 4 } },
      detailAnchors: { dop_second: { itemID: "outcome", offset: -3 } },
    }
    const result = reconcilePresentationState(state, [
      parent("ses_parent", [operation("dop_first", "first", "queued"), operation("dop_third", "third", "queued")]),
    ])

    expect(result.state.selectedOperationID).toBe("dop_third")
    expect(result.state.listAnchors.ses_parent).toEqual({ itemID: "dop_third", offset: 1 })
    expect(result.state.detailAnchors.dop_second).toBeUndefined()
  })

  test("invalid restored identifiers and dimensions are discarded or clamped", () => {
    const state = sanitizePresentationState(
      {
        filters: { search: 1, actionableOnly: "yes" },
        selectedParentID: 4,
        paneSizes: {
          wide: { parents: Number.NaN, inspector: 500 },
          medium: { inspector: -1 },
        },
        listAnchors: { ses_parent: { itemID: "dop", offset: Number.POSITIVE_INFINITY } },
      },
      120,
    )
    expect(state).toMatchObject({
      filters: { search: "", actionableOnly: false },
      paneSizes: { wide: { inspector: 120 }, medium: {} },
      listAnchors: { ses_parent: { itemID: "dop", offset: 0 } },
    })
    expect(state.selectedParentID).toBeUndefined()
  })

  test("invalid inspector anchors fall to the nearest stable inspector item", () => {
    const state: PresentationState = {
      ...emptyPresentationState(),
      selectedParentID: "ses_parent",
      selectedOperationID: "dop_first",
      detailAnchors: { dop_first: { itemID: "outcome", offset: 0 } },
      detailOrder: { dop_first: ["timeline", "outcome", "recovery"] },
    }
    const result = reconcilePresentationState(state, [
      parent("ses_parent", [operation("dop_first", "first", "queued")]),
    ])

    expect(result.state.detailAnchors.dop_first).toEqual({ itemID: "timeline", offset: 0 })
  })
})

function parent(id: string, operations: ParentSummary["operations"]): ParentSummary {
  return {
    session: { id, archived: false, updated: 1 },
    counts: {
      total: operations.length,
      queued: 0,
      starting: 0,
      running: 0,
      finalizing: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      interrupted: 0,
      cancellationRequested: 0,
      recoveryEligible: 0,
      actionable: 0,
      deliveryPending: 0,
      deliveryConflicted: 0,
    },
    lastActivityAt: 1,
    batches: [],
    operations,
    newestOperationID: operations[0]?.id,
    newestActionableOperationID: operations.find((item) => item.presentationState !== "terminal")?.id,
  }
}

function operation(
  id: string,
  text: string,
  presentationState: "queued" | "terminal",
  childID?: string,
): ParentSummary["operations"][number] {
  return {
    id,
    batchID: `batch_${id}`,
    parentID: "ses_parent",
    index: 0,
    text,
    agent: "build",
    model: { providerID: "test", modelID: "test" },
    internalState: presentationState === "terminal" ? "completed" : "queued",
    presentationState,
    timeline: { admittedAt: 1, permissionWaits: [] },
    ...(childID ? { childID } : {}),
  }
}

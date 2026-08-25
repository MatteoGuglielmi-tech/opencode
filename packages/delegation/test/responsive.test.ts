import { describe, expect, test } from "bun:test"
import { layoutFor, resizeLayout } from "../src/responsive"

describe("Delegation supervision responsive layout", () => {
  test("uses the accepted compositions at exact boundaries", () => {
    expect(layoutFor(79, {})).toMatchObject({ composition: "narrow", separators: [] })
    expect(layoutFor(80, {})).toMatchObject({ composition: "medium", separators: ["inspector"] })
    expect(layoutFor(119, {})).toMatchObject({ composition: "medium", separators: ["inspector"] })
    expect(layoutFor(120, {})).toMatchObject({ composition: "wide", separators: ["parents", "inspector"] })
  })

  test("clamps pane sizes while retaining independent composition values", () => {
    const wide = layoutFor(120, { parents: 2, inspector: 200 })
    const medium = layoutFor(80, { inspector: 200 })

    expect(wide).toMatchObject({ parents: 18, inspector: 70, timeline: 28 })
    expect(medium).toMatchObject({ inspector: 49, timeline: 28 })
    expect(layoutFor(50, {})).toMatchObject({ composition: "narrow", timeline: 48 })
  })

  test("keyboard and pointer deltas resize the requested logical edge", () => {
    const initial = layoutFor(140, { parents: 24, inspector: 36 })

    expect(resizeLayout(initial, "parents", 5)).toMatchObject({ parents: 29, inspector: 36, timeline: 71 })
    expect(resizeLayout(initial, "inspector", 100)).toMatchObject({ parents: 24, inspector: 84, timeline: 28 })
    expect(resizeLayout(initial, "parents", -100)).toMatchObject({ parents: 18, inspector: 36, timeline: 82 })
  })
})

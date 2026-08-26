import { describe, expect, test } from "bun:test"
import { autoDirection, directionFor, horizontalDelta, ltrDirection, resizeDelta, rowDirection } from "../src/direction"
import { layoutFor, resizeLayout } from "../src/responsive"

describe("Delegation supervision responsive layout", () => {
  test("uses the accepted compositions at exact boundaries", () => {
    expect(layoutFor(71, {})).toMatchObject({ composition: "narrow", separators: [] })
    expect(layoutFor(72, {})).toMatchObject({ composition: "medium", separators: ["inspector"] })
    expect(layoutFor(95, {})).toMatchObject({ composition: "medium", separators: ["inspector"] })
    expect(layoutFor(96, {})).toMatchObject({ composition: "wide", separators: ["parents", "inspector"] })
  })

  test("clamps pane sizes while retaining independent composition values", () => {
    const wide = layoutFor(96, { parents: 2, inspector: 200 })
    const medium = layoutFor(72, { inspector: 200 })

    expect(wide).toMatchObject({ parents: 18, inspector: 38, timeline: 36 })
    expect(medium).toMatchObject({ inspector: 33, timeline: 36 })
    expect(layoutFor(50, {})).toMatchObject({ composition: "narrow", timeline: 48 })
  })

  test("keyboard and pointer deltas resize the requested logical edge", () => {
    const initial = layoutFor(140, { parents: 24, inspector: 36 })

    expect(resizeLayout(initial, "parents", 5)).toMatchObject({ parents: 29, inspector: 36, timeline: 71 })
    expect(resizeLayout(initial, "inspector", 100)).toMatchObject({ parents: 24, inspector: 76, timeline: 36 })
    expect(resizeLayout(initial, "parents", -100)).toMatchObject({ parents: 18, inspector: 36, timeline: 82 })
  })

  test("maps physical horizontal input to logical RTL navigation and resizing", () => {
    expect(horizontalDelta(-1, "ltr")).toBe(-1)
    expect(horizontalDelta(-1, "rtl")).toBe(1)
    expect(resizeDelta("parents", -5, "ltr")).toBe(-5)
    expect(resizeDelta("parents", -5, "rtl")).toBe(5)
    expect(resizeDelta("inspector", 5, "ltr")).toBe(-5)
    expect(resizeDelta("inspector", 5, "rtl")).toBe(5)
  })

  test("keeps direction independent from content and isolates mixed text", () => {
    expect(directionFor("rtl")).toBe("rtl")
    expect(directionFor("ar")).toBe("ltr")
    expect(rowDirection("ltr")).toBe("row")
    expect(rowDirection("rtl")).toBe("row-reverse")
    expect(autoDirection("English العربية")).toBe("\u2068English العربية\u2069")
    expect(ltrDirection("ses_مرحبا /src/app.ts 12:34 openai/gpt-5")).toBe(
      "\u2066ses_مرحبا /src/app.ts 12:34 openai/gpt-5\u2069",
    )
  })
})

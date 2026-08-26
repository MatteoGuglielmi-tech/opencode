export type Composition = "wide" | "medium" | "narrow"
export type Separator = "parents" | "inspector"

export type ResponsiveLayout = {
  readonly composition: Composition
  readonly width: number
  readonly parents?: number
  readonly timeline: number
  readonly inspector?: number
  readonly separators: ReadonlyArray<Separator>
}

const PAGE_PADDING = 2
const MIN_PARENTS = 18
const MIN_TIMELINE = 36
const MIN_INSPECTOR = 28
const DEFAULT_PARENTS = 18
const DEFAULT_INSPECTOR = 30

export function layoutFor(width: number, remembered: { readonly parents?: number; readonly inspector?: number }) {
  const content = Math.max(1, width - PAGE_PADDING)
  if (width < 72)
    return {
      composition: "narrow",
      width,
      timeline: content,
      separators: [],
    } satisfies ResponsiveLayout

  if (width < 96) {
    const available = Math.max(1, content - 1)
    const inspector = clamp(remembered.inspector ?? DEFAULT_INSPECTOR, MIN_INSPECTOR, available - MIN_TIMELINE)
    return {
      composition: "medium",
      width,
      timeline: available - inspector,
      inspector,
      separators: ["inspector"],
    } satisfies ResponsiveLayout
  }

  const available = Math.max(1, content - 2)
  const parents = clamp(remembered.parents ?? DEFAULT_PARENTS, MIN_PARENTS, available - MIN_TIMELINE - MIN_INSPECTOR)
  const inspector = clamp(
    remembered.inspector ?? DEFAULT_INSPECTOR,
    MIN_INSPECTOR,
    available - parents - MIN_TIMELINE,
  )
  return {
    composition: "wide",
    width,
    parents,
    timeline: available - parents - inspector,
    inspector,
    separators: ["parents", "inspector"],
  } satisfies ResponsiveLayout
}

export function resizeLayout(layout: ResponsiveLayout, separator: Separator, delta: number) {
  if (layout.composition === "narrow" || !layout.separators.includes(separator)) return layout
  if (separator === "parents")
    return layoutFor(layout.width, {
      parents: (layout.parents ?? MIN_PARENTS) + delta,
      inspector: layout.inspector,
    })
  return layoutFor(layout.width, {
    parents: layout.parents,
    inspector: (layout.inspector ?? MIN_INSPECTOR) + delta,
  })
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(Math.max(min, max), Math.round(value)))
}

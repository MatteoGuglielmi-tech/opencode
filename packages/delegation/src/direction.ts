import type { Separator } from "./responsive.js"

export type Direction = "ltr" | "rtl"

const LRI = "\u2066"
const FSI = "\u2068"
const PDI = "\u2069"

export function directionFor(value: unknown): Direction {
  return value === "rtl" ? "rtl" : "ltr"
}

export function rowDirection(direction: Direction) {
  return direction === "rtl" ? ("row-reverse" as const) : ("row" as const)
}

export function horizontalDelta(delta: number, direction: Direction) {
  return direction === "rtl" ? -delta : delta
}

export function resizeDelta(separator: Separator, delta: number, direction: Direction) {
  const logical = horizontalDelta(delta, direction)
  return separator === "parents" ? logical : -logical
}

export function autoDirection(value: string) {
  return `${FSI}${value}${PDI}`
}

export function ltrDirection(value: string | number) {
  return `${LRI}${value}${PDI}`
}

import { describe, expect, test } from "bun:test"
import { slashSkillOptions } from "../../src/prompt/slash-catalog"

describe("slashSkillOptions", () => {
  test("renders skills with a leading slash", () => {
    expect(slashSkillOptions([{ id: "ponytail", description: "lazy senior dev" }], new Set())).toEqual([
      { display: "/ponytail", description: "lazy senior dev", kind: "skill", id: "ponytail" },
    ])
  })

  test("drops a skill whose id is shadowed by a command name", () => {
    expect(slashSkillOptions([{ id: "init" }, { id: "audit" }], new Set(["init"]))).toEqual([
      { display: "/audit", description: undefined, kind: "skill", id: "audit" },
    ])
  })
})

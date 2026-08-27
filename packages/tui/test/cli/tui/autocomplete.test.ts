import { expect, test } from "bun:test"
import { reconcileSlashCatalog } from "../../../src/component/prompt/autocomplete"

test("slash skills take precedence over executable commands with the same name", () => {
  const result = reconcileSlashCatalog(
    [
      { name: "wayfinder", description: "Executor entry" },
      { name: "delegations", description: "Command entry" },
    ],
    [
      { id: "wayfinder", slash: true, description: "Skill entry" },
      { id: "hidden", slash: false, description: "Non-slash skill" },
    ],
  )

  expect(result.commands.map((item) => item.name)).toEqual(["delegations"])
  expect(result.skills.map((item) => item.id)).toEqual(["wayfinder"])
})

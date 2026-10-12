export interface SlashSkill {
  readonly id: string
  readonly description?: string
}

export interface SlashSkillOption {
  readonly display: string
  readonly description?: string
  readonly kind: "skill"
  readonly id: string
}

/** Skills that belong in the "/" catalog, excluding names shadowed by a command. */
export function slashSkillOptions(
  skills: readonly SlashSkill[],
  commandNames: ReadonlySet<string>,
): SlashSkillOption[] {
  return skills
    .filter((skill) => !commandNames.has(skill.id))
    .map((skill) => ({
      display: "/" + skill.id,
      description: skill.description,
      kind: "skill" as const,
      id: skill.id,
    }))
}

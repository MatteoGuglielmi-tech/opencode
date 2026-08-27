type Input = {
  platform: string
  execPath: string
  argv: string[]
  environment: Record<string, string | undefined>
  execve(file: string, args: string[], environment: Record<string, string>): void
}

export function reexecForHerdr(provided?: Input) {
  const execve = provided?.execve ?? process.execve
  if (!execve) return
  const input = provided ?? {
    platform: process.platform,
    execPath: process.execPath,
    argv: process.argv,
    environment: process.env,
    execve,
  }
  if (input.platform === "win32" || input.platform === "os400") return
  if (input.environment.HERDR_AGENT === "opencode") return
  if (input.environment.HERDR_ENV !== "1") return
  if (!environmentValue(input.environment.HERDR_PANE_ID)) return
  if (!environmentValue(input.environment.HERDR_SOCKET_PATH)) return
  if (!environmentValue(input.environment.HERDR_BIN_PATH)) return

  try {
    input.execve(input.execPath, input.argv.slice(1), {
      ...Object.fromEntries(
        Object.entries(input.environment).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      HERDR_AGENT: "opencode",
    })
  } catch {}
}

function environmentValue(value: string | undefined) {
  const trimmed = value?.trim()
  if (!trimmed || [...trimmed].some((character) => character.charCodeAt(0) < 32)) return
  return trimmed
}

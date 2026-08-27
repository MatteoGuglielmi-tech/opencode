import { expect, test } from "bun:test"
import { reexecForHerdr } from "../src/herdr"

const environment = {
  HERDR_ENV: "1",
  HERDR_PANE_ID: "w1:p2",
  HERDR_SOCKET_PATH: "/tmp/herdr.sock",
  HERDR_BIN_PATH: "/usr/local/bin/herdr",
  PATH: "/usr/bin",
}

test("reexecutes the primary POSIX client with Herdr's canonical process hint", () => {
  const calls: unknown[][] = []
  reexecForHerdr({
    platform: "darwin",
    execPath: "/usr/local/bin/ocpz",
    argv: ["/usr/local/bin/ocpz", "-s", "ses_root"],
    environment,
    execve: (...args) => void calls.push(args),
  })

  expect(calls).toEqual([
    [
      "/usr/local/bin/ocpz",
      ["-s", "ses_root"],
      { ...environment, HERDR_AGENT: "opencode" },
    ],
  ])
})

test.each([
  ["win32", environment],
  ["darwin", { ...environment, HERDR_ENV: "0" }],
  ["darwin", { ...environment, HERDR_SOCKET_PATH: "" }],
  ["darwin", { ...environment, HERDR_AGENT: "opencode" }],
] as const)("does not reexec unsupported or inactive clients", (platform, input) => {
  let called = false
  reexecForHerdr({
    platform,
    execPath: "/usr/local/bin/ocpz",
    argv: ["/usr/local/bin/ocpz"],
    environment: input,
    execve: () => void (called = true),
  })
  expect(called).toBe(false)
})

test("drops undefined environment values before execve", () => {
  let received: Record<string, string> | undefined
  reexecForHerdr({
    platform: "linux",
    execPath: "/usr/local/bin/ocpz",
    argv: ["/usr/local/bin/ocpz"],
    environment: { ...environment, UNUSED: undefined },
    execve: (_file, _args, env) => void (received = env),
  })
  expect(received?.UNUSED).toBeUndefined()
  expect(received?.HERDR_AGENT).toBe("opencode")
})

test("continues startup when execve fails", () => {
  expect(() =>
    reexecForHerdr({
      platform: "darwin",
      execPath: "/missing/ocpz",
      argv: ["/missing/ocpz"],
      environment,
      execve: () => {
        throw new Error("execve failed")
      },
    }),
  ).not.toThrow()
})

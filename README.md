# OpenCode V2 Delegation Fork

This repository is an experimental fork of the [OpenCode V2 branch](https://github.com/anomalyco/opencode/tree/v2). The fork's primary branch is [`v2`](https://github.com/MatteoGuglielmi-tech/opencode/tree/v2); [`delegation-v2`](https://github.com/MatteoGuglielmi-tech/opencode/tree/delegation-v2) remains its Delegation development branch.

Use upstream OpenCode for the supported product. This fork exists to develop and validate durable delegated work and its supervision experience.

The retained repository is intentionally kept clonable, installable, testable, and buildable. A fresh checkout supports the development and native CLI build commands documented below without relying on files removed from this personal fork.

## Added Features

- Durable, concurrent Delegation batches launched with `/delegate`.
- A Location-scoped Delegation Supervision Page opened with `/delegations`.
- Retained operation timelines, queue state, permission waits, controls, recovery, and terminal outcomes.
- Responsive wide, medium, and narrow supervision layouts with RTL-aware navigation and rendering.
- Restart-safe admission, delivery, cancellation, and uncertain-execution reconciliation.
- Generic plugin queries, executable plugin commands, trusted child Session creation, and non-discoverable command executors.
- Location-aware agent, model, and skill validation for delegated child Sessions.
- Improved delegated Session activity reporting for TUI and external supervision clients.

## Requirements

- [Bun 1.3+](https://bun.sh/)
- Git
- The platform toolchain required by Bun and OpenCode's native dependencies

## Development

Install dependencies from the repository root:

```sh
bun install
```

Run the V2 CLI and TUI from source:

```sh
bun run dev
```

Run it against another directory:

```sh
bun run dev /path/to/project
```

Run the worktree TUI against the currently elected `opencode2` background service:

```sh
bun run dev:live /path/to/project
```

## Verification

Run package tests from the package that owns them, not from the repository root:

```sh
cd packages/core
bun test

cd ../delegation
bun test
```

Run repository typechecking from the root:

```sh
bun run typecheck
```

## Build A Native Binary

Build one binary for the current operating system and architecture:

```sh
bun packages/cli/script/build.ts --single
```

The binary is written under:

```text
packages/cli/dist/cli-<os>-<arch>/bin/opencode2
```

For example, Apple Silicon macOS produces:

```text
packages/cli/dist/cli-darwin-arm64/bin/opencode2
```

## Build The Isolated `ocpz` Binary

On Apple Silicon macOS, build this branch with its own service and storage channel:

```sh
OPENCODE_CHANNEL=delegation-v2 bun packages/cli/script/build.ts --single
install -m 755 packages/cli/dist/cli-darwin-arm64/bin/opencode2 ~/.opencode/bin/ocpz
ocpz service restart
ocpz service status
```

Use a different output target path on other platforms. The `delegation-v2` channel keeps the fork's service state separate from the ordinary `opencode2` channel.

## License

OpenCode is distributed under the [MIT License](LICENSE).

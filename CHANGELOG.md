# opencode-openrouter-budget

## 0.2.0

### Minor Changes

- [`de4bfe8`](https://github.com/valeriobelli/opencode-openrouter-budget/commit/de4bfe8421dfdbb35147cafded157e51e8d0873c) Thanks [@valeriobelli](https://github.com/valeriobelli)! - Define dependencies as expected to allow OpenCode to download them

## 0.1.2

### Patch Changes

- [`c6177cd`](https://github.com/valeriobelli/opencode-openrouter-budget/commit/c6177cd304fa1c9a5e4125e7007436dedfc8f3d6) Thanks [@valeriobelli](https://github.com/valeriobelli)! - Remove some slop from the code

- [`6149929`](https://github.com/valeriobelli/opencode-openrouter-budget/commit/6149929b7e6ae8e4fa842fffcbcc73a99cd94853) Thanks [@valeriobelli](https://github.com/valeriobelli)! - fix: use single-line @jsxImportSource pragma for bun+node_modules—block form triggers newline in import path, breaking the load. This matches all working OpenCode TUI plugins and is proven in Bun upstream tests.

## 0.1.1

### Patch Changes

- [`da60654`](https://github.com/valeriobelli/opencode-openrouter-budget/commit/da6065400c30af45e1d20308d0bab283206673ea) Thanks [@valeriobelli](https://github.com/valeriobelli)! - Fix the TUI entry when installed from npm: Bun ignores tsconfig.json inside node_modules, so the JSX pragma now selects the OpenTUI runtime explicitly.

## 0.1.0

### Minor Changes

- [`00cddf9`](https://github.com/valeriobelli/opencode-openrouter-budget/commit/00cddf975c3aa92d778fa5bd8676b34bdfd42074) Thanks [@valeriobelli](https://github.com/valeriobelli)! - Initial release: live OpenRouter spend in the session sidebar, a `/openrouter-budget` command with per-request details, key budget and account credits.

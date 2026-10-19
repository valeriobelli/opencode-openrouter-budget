---
'opencode-openrouter-budget': patch
---

Fix the TUI entry when installed from npm: Bun ignores tsconfig.json inside node_modules, so the JSX pragma now selects the OpenTUI runtime explicitly.

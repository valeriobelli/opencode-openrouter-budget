---
'opencode-openrouter-budget': patch
---

fix: use single-line @jsxImportSource pragma for bun+node_modules—block form triggers newline in import path, breaking the load. This matches all working OpenCode TUI plugins and is proven in Bun upstream tests.

---
"opencode-openrouter-budget": minor
---

Make the `/openrouter-budget` dialog readable in narrow terminals:

- Each request takes one line, in aligned columns that adapt to the dialog's width.
- Spend and limits sit in two sections, with each figure shown once.
- The request list scrolls with ↑↓, PgUp/PgDn, Home/End and the mouse wheel, while the summary and the key hints stay on screen.
- Day headings separate requests made on different days.
- Unknown BYOK costs are marked with `?` or `unknown`.
- The dialog opens wide and centred, as intended. Before, it always opened at OpenCode's medium width of 60 columns, because its size was set before the dialog was shown.
- `r` now refreshes the wallet while the dialog is open.

---
"opencode-openrouter-budget": minor
---

Report BYOK spend separately from OpenRouter's own charge. BYOK requests return `usage.cost: 0` with the provider's charge in `cost_details.upstream_inference_cost`, so sessions using your own provider keys showed `$0.00`. The sidebar now shows the session total and its OpenRouter + BYOK split, and `/openrouter-budget` lists both per request and shows whether BYOK counts toward the key limit and the effective budget. Requests without BYOK data are shown as unknown rather than zero.

# Demo audit samples

These JSON files are generated from real local runs of the bundled synthetic sandbox. They are not real orders or financial records.

- `success.json`: both human actions completed and the sandbox order reached `COMPLETED`.
- `stopped-over-budget.json`: final shipping raised the amount to HK$3,559; the backend reached `BLOCKED` before any payment adapter call.
- `user-rejected.json`: the first authorization was rejected; no Benefit Lock or payment exists.
- `payment-auth-failed.json`: the second human action failed; the active lock was closed and no payment was submitted.

Regenerate them with `npm run demo:audits` before a demo if current timestamps are preferred.

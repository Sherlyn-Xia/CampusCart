# Front-end integration (English edition)

This package = the original `CampusCart-main` agent backend + your `CampusCart_Demo` front end, translated into English. The front end calls the agent's HTTP API; the look and layout are unchanged.

## Run

```bash
npm install        # Node 22 required (see .nvmrc)
npm start          # defaults to http://127.0.0.1:3000
```

Open http://127.0.0.1:3000. The front end lives in `public/` and is served by the backend, so it is same-origin and needs no CORS setup.

To let a real language model answer follow-up questions, copy `.env.example` to `.env` and set `OPENAI_API_KEY` (for DeepSeek also set `OPENAI_BASE_URL=https://api.deepseek.com` and `CAMPUSCART_AGENT_MODEL=deepseek-chat`). Restart after editing. Without a key everything still works (the agent uses deterministic rules). Never commit or share your key.

## What changed

| File | Notes |
| --- | --- |
| `public/api.js` | **The only interface layer** between front end and agent: all `fetch` calls, plus conversion of backend data into UI structures with English copy |
| `public/app.js` | Original pages and style classes; quotes, authorization, payment and order status all go through `api.js` |
| `public/engine.js` | Small helpers: money conversion and English parsing of budget / points (`budget HK$3,600`, `up to 100 points`, `no points`) |
| `public/index.html` | `lang="en"`, English title/meta/footer |
| `public/styles.css` | Your styles, plus one rule (constraints area: three columns → two) |
| `public/payment-auth.*`, `public/agent-styles.css` | The agent's own payment redirect page, kept but unused |
| `src/server.js` | Two small changes: image MIME types; optional `CORS_ORIGIN` switch |
| `src/agent/tools.js`, `coordinator.js` | Quantity / variant detection fix (2 units, 256GB, Pro/Air/mini, other colours now ask for clarification), with tests |

Orders are stored in the browser under the key `campuscart-agent-en-v1` (separate from the Chinese edition).

## UI action ↔ API

| UI action | Call |
| --- | --- |
| Open page | `GET /api/bootstrap`, `GET /api/v1/agent/capabilities` |
| Search | `POST /api/v1/agent/runs` (budget and points limit are written into the message) |
| Follow-up | `POST …/runs/{id}/messages`; changing budget/points/quantity re-runs `POST …/runs` |
| Confirm and go to payment | `POST …/resume` `{decision:"approve", planId}` |
| Confirm payment | `POST …/resume` `{decision:"authenticated", paymentSessionId}` |
| Cancel authorization / payment | `POST …/resume` `{decision:"failed", paymentSessionId}` |
| Download purchase record | `GET …/runs/{id}`, `…/trace`, `…/transaction` |

## Differences from the original front-end mock

1. **Merchants, prices and offers come from the backend**: Campus Education Store (HK$3,399), Harbour Digital (HK$3,429 with 100 points), UniMall (HK$3,479).
2. **No delivery-deadline input**: the backend doesn't process delivery dates.
3. **"My Benefits" is read-only**: identity and payment adapters are fixed demo data.
4. **Payment method is fixed by the plan** and can't change after authorization.
5. **The payment page simulates the provider callback** by calling `resume` with `authenticated`. A real integration must redirect to the provider and resume through a signature-verified webhook.
6. **Follow-up answers**: with `OPENAI_API_KEY` set, the agent's answer is used; otherwise the front end explains from the backend plan data.
7. **Orders**: summaries in the browser, full records in backend memory; after a backend restart, unpaid orders become "Expired" and nothing is paid.

## Split deployment (e.g. your own Vite front end)

1. Start the backend with `CORS_ORIGIN=http://localhost:5173 npm start`.
2. Before loading `api.js`, add `<script>window.CAMPUSCART_API_BASE='http://localhost:3000'</script>`.

## Known limitations

- Without `OPENAI_API_KEY` the agent runs in deterministic fallback mode: the LangGraph workflow and tools really run, but no language model is involved; understanding of your text relies on a few matching rules (budget, points, quantity, spec).
- With a key, the model joins tool calling and follow-up answers, but product / quantity / spec checks, budget, offers and the authorization lock are still decided by deterministic code.
- Only one product is available (iPad A16 128GB Wi-Fi Silver, 1 unit). Multiple units or other products need backend catalog and rule changes (e.g. whether the student discount is limited to one unit).

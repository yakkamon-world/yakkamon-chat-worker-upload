# yakkamon-chat-worker

The Cloudflare Worker behind the **"Ask me anything…"** bar on
[yakkamonworld.com](https://yakkamonworld.com). One endpoint, `POST /chat`,
takes a question and returns an answer with its sources.

How it answers, every time, in this order:

1. **Official** — fetches `docs.yakkamon.com` pages live (their markdown
   versions), cached one hour. Official always wins on a conflict.
2. **YakkamonWorld** — searches `https://yakkamonworld.com/chatbot-knowledge.json`
   (FAQ, gameplay systems, articles, tips, videos — rebuilt automatically by
   the site repo's GitHub Action).
3. **Dev streams** — the Cumulative Dev Stream digest, shipped inside the same
   JSON (later stream beats earlier).

The best passages from each tier go to Claude with strict rules (never invent,
official > site > streams, later-dated wins, say "not confirmed" otherwise).
Replies come back as `{ answer, sources: ["official","yw","stream"], link }`.

Nothing a visitor types is stored. Optional KV holds only a daily request
count and, for six hours, cached answers keyed by a hash of the question.

---

## Setup (about ten minutes)

### 1. Create the worker
Cloudflare dashboard → **Workers & Pages → Create → Import a repository** and
pick this repo (or *Create Worker*, then paste `index.js` into the editor).
Name it `yakkamon-chat-worker` — workers cannot be renamed later.

If you deploy from the dashboard editor instead of Git, also copy the `vars`
from `wrangler.jsonc` into **Settings → Variables and Secrets** (they have
sensible defaults in the code, so this is optional).

### 2. Add the API key
Get a key at [console.anthropic.com](https://console.anthropic.com) (API Keys →
Create). Then in the worker: **Settings → Variables and Secrets → Add →
type Secret**, name `ANTHROPIC_API_KEY`, paste the key, deploy.

While you're in the Anthropic console, set a **monthly spend limit**
(Settings → Limits). That is the real cost ceiling; the worker's own
`DAILY_CAP` is only a soft one.

### 3. Check it
Open `https://yakkamon-chat-worker.<your-subdomain>.workers.dev/status`. You
want `"hasKey": true`, and after the first question `"docs": { "pages": 9 }`.
If `docs` stays `null`, docs.yakkamon.com is refusing the fetch — the bot then
falls back to the site's own copy of the official facts and still works.

### 4. Wire the site
Paste the worker URL into `WORKER_URL` at the top of `chatbot.js` in the site
repo and push.

### 5. Optional: KV (answer cache + daily counter)
**Storage & Databases → KV → Create** → `yakkamon-chat-kv`. Copy its ID into
`wrangler.jsonc` (`kv_namespaces`, uncomment the block) or bind it in the
dashboard as `CHAT_KV`. Everything works without it.

---

## Settings

| Var | Default | What it does |
|---|---|---|
| `MODEL` | `claude-haiku-4-5` | Anthropic model id. Haiku is fast and cheap; `claude-sonnet-5` gives slightly better answers at ~2× the price. |
| `ALLOWED_ORIGINS` | `https://yakkamonworld.com,https://www.yakkamonworld.com` | Browsers from other sites get a 403. |
| `KNOWLEDGE_URL` | `https://yakkamonworld.com/chatbot-knowledge.json` | Where the site index lives. |
| `DAILY_CAP` | `1500` | Soft daily question limit (needs KV to be accurate across the world). |
| `MAX_HISTORY` | `6` | Previous messages sent along for follow-up questions. |

Rate limit: 20 questions per minute per IP through the `RL` binding in
`wrangler.jsonc` (in-memory fallback if the binding is missing).

## Cost
Each answer sends roughly 3,000 input tokens and 250 output tokens. At Haiku
prices that is about **$0.004 per question** — a thousand questions is around
four dollars. Cached repeats (with KV) are free.

## Routes
| Route | Notes |
|---|---|
| `POST /chat` | body `{ "q": "...", "history": [{role, content}] }` → `{ answer, sources, link }` |
| `GET /status` | health: cache ages, chunk count, today's count, which bindings exist |

## Gotchas (learned on the other workers)
- Workers cannot be renamed. Binding names pasted into the dashboard can pick
  up a leading space — check with `/status` (`hasKV`, `hasRateLimit`).
- Error responses are `no-store`, so a fixed worker never looks broken because
  of a cached error.
- Git-connected workers deploy on push; a dashboard-created one must be
  redeployed from the editor after edits.

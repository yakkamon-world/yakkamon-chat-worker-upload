/*
  YAKKAMON CHAT WORKER
  ====================
  The brain behind the "Ask me anything…" bar on yakkamonworld.com.

  Every question goes through the same three-tier search, in this order:
    1. OFFICIAL   docs.yakkamon.com — fetched live (markdown pages), cached one hour
    2. SITE       yakkamonworld.com/chatbot-knowledge.json — FAQ, gameplay, articles,
                  tips, videos (built by build-chatbot-knowledge.mjs in the site repo)
    3. STREAMS    the Cumulative Dev Stream digest (inside the same JSON)
  The best-matching passages from each tier are handed to Claude with strict rules:
  official beats site beats streams, later-dated beats earlier, never invent.

  Routes
    POST /chat     { q, history? }  → { answer, sources, link }
    GET  /status   health + cache ages + today's count
    OPTIONS *      CORS preflight

  Bindings (wrangler.jsonc / dashboard)
    ANTHROPIC_API_KEY  secret  — from console.anthropic.com
    CHAT_KV            KV      — optional: answer cache + daily counter
    RL                 rate limit binding — optional: per-IP limit (falls back to in-memory)
    vars: MODEL, ALLOWED_ORIGINS, KNOWLEDGE_URL, DAILY_CAP, MAX_HISTORY

  Nothing typed by a visitor is stored: KV holds only hashed-question → answer
  pairs (no IPs, no timestamps beyond TTL) and a per-day request count.
*/

const DOCS = [
  ["about-yakkamon", "About Yakkamon"],
  ["faq", "Official FAQ"],
  ["pre-registration/early-access-airdrop", "Early Access and Rewards"],
  ["pre-registration/important-dates", "Important Dates"],
  ["pre-registration/legendary-founder-nfts", "NFT Airdrop"],
  ["pre-registration/flower-deposits", "$FLOWER Deposits"],
  ["pre-registration/free-mint", "Free Mint"],
  ["content/yakkapedia", "Yakkapedia"],
  ["team", "The Team"],
];
const DOCS_BASE = "https://docs.yakkamon.com/";
const DOCS_TTL = 60 * 60 * 1000;         // 1 hour
const KNOWLEDGE_TTL = 10 * 60 * 1000;    // 10 minutes
const ANSWER_TTL = 6 * 60 * 60;          // seconds — KV cache for identical questions
const MAX_Q = 400;                       // characters
const UA = "YakkamonWorld-Portal/1.0 (+https://yakkamonworld.com)";

const DEFAULTS = {
  MODEL: "claude-haiku-4-5",
  ALLOWED_ORIGINS: "https://yakkamonworld.com,https://www.yakkamonworld.com",
  KNOWLEDGE_URL: "https://yakkamonworld.com/chatbot-knowledge.json",
  DAILY_CAP: "1500",
  MAX_HISTORY: "6",
};

/* ---------------- per-isolate caches (survive between requests on warm workers) ---------------- */
const mem = { docs: null, docsAt: 0, knowledge: null, knowledgeAt: 0, index: null, rl: new Map(), day: "", dayCount: 0 };

export default {
  async fetch(request, env, ctx) {
    const cfg = { ...DEFAULTS, ...pick(env, Object.keys(DEFAULTS)) };
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, cfg.ALLOWED_ORIGINS);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (url.pathname === "/status") {
      const body = {
        ok: true, model: cfg.MODEL,
        docs: mem.docs ? { pages: mem.docs.length, ageMin: Math.round((Date.now() - mem.docsAt) / 60000) } : null,
        knowledge: mem.knowledge ? { chunks: mem.knowledge.chunks.length, built: mem.knowledge.built, ageMin: Math.round((Date.now() - mem.knowledgeAt) / 60000) } : null,
        todayCount: await readCount(env),
        hasKey: !!env.ANTHROPIC_API_KEY, hasKV: !!env.CHAT_KV, hasRateLimit: !!env.RL,
      };
      return json(body, 200, { ...cors, "cache-control": "no-store" });
    }

    if (url.pathname !== "/chat" && url.pathname !== "/") {
      return json({ error: "Not found" }, 404, { ...cors, "cache-control": "no-store" });
    }
    if (request.method !== "POST") {
      return new Response("YakkamonWorld chat worker. POST /chat with {q}.", { status: 200, headers: { ...cors, "content-type": "text/plain" } });
    }
    if (!cors["access-control-allow-origin"] && origin) {
      return json({ error: "Origin not allowed" }, 403, { "cache-control": "no-store" });
    }

    // ----- rate limits -----
    const ip = request.headers.get("cf-connecting-ip") || "0";
    if (!(await allowed(env, ip))) {
      return json({ error: "rate_limited", answer: "Too many questions at once — give it a minute and try again." }, 429, { ...cors, "cache-control": "no-store" });
    }

    // ----- parse -----
    let body;
    try { body = await request.json(); } catch { return json({ error: "Bad JSON" }, 400, cors); }
    const q = String(body?.q || "").replace(/\s+/g, " ").trim().slice(0, MAX_Q);
    if (q.length < 2) return json({ error: "empty" }, 400, cors);
    const history = sanitiseHistory(body?.history, +cfg.MAX_HISTORY);

    if (!env.ANTHROPIC_API_KEY) {
      return json({ answer: "The helper isn't connected yet — the site owner still needs to add the API key. Try the FAQ in the meantime.", sources: [], link: { title: "Browse the FAQ →", url: "https://yakkamonworld.com/faq.html" } }, 200, { ...cors, "cache-control": "no-store" });
    }

    // ----- daily cap (soft) -----
    const count = await bumpCount(env, ctx);
    if (count > +cfg.DAILY_CAP) {
      return json({ error: "daily_cap", answer: "The helper has hit today's question limit. The FAQ covers most things — or ask again tomorrow.", sources: [], link: { title: "Browse the FAQ →", url: "https://yakkamonworld.com/faq.html" } }, 200, { ...cors, "cache-control": "no-store" });
    }

    // ----- answer cache (only for fresh questions with no history) -----
    const cacheKey = history.length ? null : "ans:" + (await sha1(cfg.MODEL + "|" + q.toLowerCase()));
    if (cacheKey && env.CHAT_KV) {
      const hit = await env.CHAT_KV.get(cacheKey, "json").catch(() => null);
      if (hit) return json({ ...hit, cached: true }, 200, { ...cors, "cache-control": "no-store" });
    }

    // ----- retrieve -----
    const [docs, knowledge] = await Promise.all([loadDocs(ctx), loadKnowledge(cfg.KNOWLEDGE_URL, ctx)]);
    const passages = retrieve(q, history, docs, knowledge);

    // ----- ask Claude -----
    let result;
    try {
      result = await askClaude(env.ANTHROPIC_API_KEY, cfg.MODEL, q, history, passages);
    } catch (e) {
      return json({ error: "upstream", answer: "I couldn't reach the answer service just now. Please try again in a moment — or check the FAQ.", sources: [], link: { title: "Browse the FAQ →", url: "https://yakkamonworld.com/faq.html" } }, 200, { ...cors, "cache-control": "no-store" });
    }

    if (cacheKey && env.CHAT_KV && result.sources.length) {
      ctx.waitUntil(env.CHAT_KV.put(cacheKey, JSON.stringify(result), { expirationTtl: ANSWER_TTL }).catch(() => {}));
    }
    return json(result, 200, { ...cors, "cache-control": "no-store" });
  },
};

/* =============================== sources =============================== */

async function loadDocs(ctx) {
  if (mem.docs && Date.now() - mem.docsAt < DOCS_TTL) return mem.docs;
  const pages = await Promise.all(DOCS.map(async ([slug, title]) => {
    try {
      const r = await fetch(DOCS_BASE + slug + ".md", { headers: { "user-agent": UA, accept: "text/markdown, text/plain, */*" }, cf: { cacheTtl: 3600, cacheEverything: true } });
      if (!r.ok) return null;
      return { slug, title, url: DOCS_BASE + slug, text: docsToText(await r.text()) };
    } catch { return null; }
  }));
  const ok = pages.filter(Boolean);
  if (ok.length) { mem.docs = ok; mem.docsAt = Date.now(); mem.index = null; return ok; }
  return mem.docs || [];   // keep a stale copy rather than nothing
}

function docsToText(md) {
  return md
    .replace(/^>.*?\n/, "")
    .replace(/\n---\n# Agent Instructions[\s\S]*$/, "")
    .replace(/\{%\s*hint[^%]*%\}/g, "\n").replace(/\{%\s*endhint\s*%\}/g, "\n")
    .replace(/<figure>[\s\S]*?<\/figure>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<\/t[hd]>/gi, " | ").replace(/<\/(tr|p|li|div)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&#x26;/g, "&").replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

async function loadKnowledge(url, ctx) {
  if (mem.knowledge && Date.now() - mem.knowledgeAt < KNOWLEDGE_TTL) return mem.knowledge;
  try {
    const r = await fetch(url, { headers: { "user-agent": UA }, cf: { cacheTtl: 600, cacheEverything: true } });
    if (r.ok) {
      const k = await r.json();
      if (k && Array.isArray(k.chunks)) { mem.knowledge = k; mem.knowledgeAt = Date.now(); mem.index = null; return k; }
    }
  } catch {}
  return mem.knowledge || { built: null, chunks: [] };
}

/* =============================== retrieval (BM25-lite) =============================== */

const STOP = new Set("the a an and or of to in on for is are was were be been it its this that these those with as at by from do does did how what when where which who why can i you your my we our they them their will would should could there here about into than then also any some".split(" "));
function tokens(s) {
  return String(s).toLowerCase().replace(/\$flower/g, "flower").replace(/[^a-z0-9%.]+/g, " ").split(" ")
    .map(w => w.replace(/\.+$/, "")).filter(w => w.length > 1 && !STOP.has(w))
    .map(w => (w.length > 4 ? w.replace(/(ies|ing|ed|es|s)$/, "") : w));
}

function buildIndex(docs, knowledge) {
  const items = [];
  for (const d of docs) {
    // official pages are split on headings so a single section can score on its own
    const parts = d.text.split(/\n(?=#{1,3} )/);
    for (const p of parts) {
      const h = p.match(/^#{1,3}\s+(.*)$/m);
      const text = p.replace(/^#{1,3}\s+/gm, "").trim();
      if (text.length < 40) continue;
      items.push({ t: 1, title: `Official docs: ${d.title}${h && h[1].trim() !== d.title ? " — " + h[1].trim() : ""}`, url: d.url, text, kind: "docs" });
    }
  }
  for (const c of knowledge.chunks) {
    if (c.t === 1 && docs.length) continue;   // live docs replace the snapshot when available
    items.push(c);
  }
  const df = new Map();
  let totalLen = 0;
  for (const it of items) {
    it.tok = tokens(it.title + " " + it.title + " " + it.text);   // title counts twice
    it.tf = new Map();
    for (const w of it.tok) it.tf.set(w, (it.tf.get(w) || 0) + 1);
    for (const w of it.tf.keys()) df.set(w, (df.get(w) || 0) + 1);
    totalLen += it.tok.length;
  }
  return { items, df, avgLen: totalLen / Math.max(1, items.length), N: items.length };
}

function retrieve(q, history, docs, knowledge) {
  if (!mem.index) mem.index = buildIndex(docs, knowledge);
  const idx = mem.index;
  // a follow-up like "and wave 2?" needs the previous user turn for context
  const lastUser = [...history].reverse().find(m => m.role === "user");
  const qt = tokens(q + (q.split(" ").length < 4 && lastUser ? " " + lastUser.content : ""));
  const k1 = 1.4, b = 0.75;
  const scored = idx.items.map(it => {
    let s = 0;
    for (const w of new Set(qt)) {
      const f = it.tf.get(w); if (!f) continue;
      const n = idx.df.get(w) || 0;
      const idf = Math.log(1 + (idx.N - n + 0.5) / (n + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * it.tok.length / idx.avgLen));
    }
    // recency nudge for dated site content: newer articles edge out older ones on ties
    if (it.updated) s *= 1 + Math.min(0.15, (Date.parse(it.updated) - Date.parse("2026-08-01")) / (90 * 864e5) * 0.15);
    return [s, it];
  }).filter(([s]) => s > 0).sort((a, b) => b[0] - a[0]);
  const take = (tier, n, budget) => {
    const out = []; let used = 0;
    for (const [, it] of scored) {
      if (it.t !== tier || out.length >= n) continue;
      if (used + it.text.length > budget) continue;
      out.push(it); used += it.text.length;
    }
    return out;
  };
  return { official: take(1, 5, 7000), site: take(2, 5, 6500), streams: take(3, 2, 3500) };
}

/* =============================== the model =============================== */

const SYSTEM = `You are the helper on YakkamonWorld.com, an unofficial fan site about Yakkamon — the creature-collecting idle game from the Sunflower Land team (Thought Farm), launching on Ronin. Visitors type quick questions into a chat bar; you answer them.

RULES
1. Answer ONLY from the SOURCES below. Never invent dates, numbers, prices, rules or names. If the sources don't cover it, say so plainly and suggest the FAQ or the official docs.
2. Source priority, strictly: OFFICIAL (docs.yakkamon.com and official posts) beats SITE (YakkamonWorld articles, FAQ, tips) beats DEV STREAMS (the team's stream digest). On a conflict, give the official version; if a SITE note says an official page is outdated, say both in one sentence. Within any tier, the later-dated statement wins.
3. Mark what you used by listing the tiers in "sources": "official", "yw" (YakkamonWorld), "stream" — only tiers you actually drew on.
4. Keep it short: 2–5 sentences, at most about 120 words, British English, friendly and plain, no hype and no emojis. Use **bold** for the one or two key dates or numbers. Bullet lists only for step-by-step or wave tables, and never more than 6 lines.
5. Pick ONE most useful link from the sources for "link" (the page that best answers the question), or null.
6. Safety: nothing is financial advice — if asked whether to buy/sell $FLOWER or what it will be worth, say you can't advise on that and stick to the mechanics. Never ask for or discuss wallet seed phrases or private keys. If asked about mint or claim links, say the only official mint venue is the Ronin Launchpad and that anything charging money for a "free" mint is a scam.
7. YakkamonWorld is not affiliated with the Yakkamon team; don't speak as the team.
8. Off-topic questions (not about Yakkamon, Sunflower Land, $FLOWER, Ronin or this site): reply in one friendly sentence that you only cover Yakkamon.

OUTPUT: reply with a single JSON object and nothing else:
{"answer": "...", "sources": ["official","yw","stream"], "link": {"title": "Short label →", "url": "https://..."} | null}`;

async function askClaude(key, model, q, history, passages) {
  const block = (label, list) => list.length
    ? `## ${label}\n` + list.map((p, i) => `[${label[0]}${i + 1}] ${p.title}${p.updated ? ` (updated ${p.updated})` : p.published ? ` (published ${p.published})` : ""}\nURL: ${p.url}\n${p.text}`).join("\n\n")
    : `## ${label}\n(nothing relevant found)`;
  const sources = [block("OFFICIAL", passages.official), block("SITE", passages.site), block("DEV STREAMS", passages.streams)].join("\n\n");
  const today = new Date().toISOString().slice(0, 10);
  const messages = [
    ...history.map(m => ({ role: m.role, content: m.content })),
    { role: "user", content: `Today is ${today}.\n\nSOURCES\n${sources}\n\nQUESTION: ${q}` },
  ];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  let r;
  try {
    r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", signal: controller.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 600, temperature: 0.2, system: SYSTEM, messages }),
    });
  } finally { clearTimeout(timer); }
  if (!r.ok) throw new Error("anthropic " + r.status + " " + (await r.text()).slice(0, 200));
  const data = await r.json();
  const text = (data.content || []).map(c => c.text || "").join("").trim();
  return parseAnswer(text, passages);
}

function parseAnswer(text, passages) {
  let obj = null;
  try { obj = JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { obj = JSON.parse(m[0]); } catch {} }
  }
  if (!obj || typeof obj.answer !== "string") {
    return { answer: text.replace(/^\{[\s\S]*"answer"\s*:\s*"/, "").replace(/"\s*,\s*"sources"[\s\S]*$/, "").trim() || "Sorry — I couldn't put an answer together. Try rephrasing, or check the FAQ.", sources: [], link: { title: "Browse the FAQ →", url: "https://yakkamonworld.com/faq.html" } };
  }
  const allowed = new Set(["official", "yw", "stream"]);
  const sources = Array.isArray(obj.sources) ? obj.sources.filter(s => allowed.has(s)) : [];
  let link = null;
  if (obj.link && typeof obj.link.url === "string" && /^https:\/\/(docs\.yakkamon\.com|yakkamon\.com|yakkamonworld\.com|www\.youtube\.com)\//.test(obj.link.url)) {
    link = { title: String(obj.link.title || "Read more →").slice(0, 80), url: obj.link.url };
  } else if (!obj.link) {
    const first = passages.official[0] || passages.site[0];
    if (first && sources.length) link = { title: first.t === 1 ? "Official docs →" : "Read more on YakkamonWorld →", url: first.url };
  }
  return { answer: obj.answer.trim().slice(0, 1500), sources, link };
}

/* =============================== limits, counters, helpers =============================== */

async function allowed(env, ip) {
  if (env.RL && typeof env.RL.limit === "function") {
    try { const { success } = await env.RL.limit({ key: ip }); return success; } catch {}
  }
  // in-memory fallback: 20 per minute per IP per isolate
  const now = Date.now(), win = Math.floor(now / 60000);
  const k = ip + ":" + win;
  const n = (mem.rl.get(k) || 0) + 1;
  mem.rl.set(k, n);
  if (mem.rl.size > 5000) mem.rl.clear();
  return n <= 20;
}

function todayKey() { return "count:" + new Date().toISOString().slice(0, 10); }
async function readCount(env) {
  if (!env.CHAT_KV) return mem.day === todayKey() ? mem.dayCount : 0;
  return +(await env.CHAT_KV.get(todayKey()).catch(() => 0)) || 0;
}
async function bumpCount(env, ctx) {
  const key = todayKey();
  if (mem.day !== key) { mem.day = key; mem.dayCount = 0; }
  mem.dayCount++;
  if (!env.CHAT_KV) return mem.dayCount;
  const n = (+(await env.CHAT_KV.get(key).catch(() => 0)) || 0) + 1;
  ctx.waitUntil(env.CHAT_KV.put(key, String(n), { expirationTtl: 3 * 86400 }).catch(() => {}));
  return Math.max(n, mem.dayCount);
}

function sanitiseHistory(h, max) {
  if (!Array.isArray(h)) return [];
  const out = [];
  for (const m of h.slice(-max)) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    const c = String(m.content || "").replace(/\s+/g, " ").trim().slice(0, 600);
    if (!c) continue;
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1].content += " " + c;  // API needs alternating roles
    else out.push({ role: m.role, content: c });
  }
  while (out.length && out[0].role !== "user") out.shift();
  if (out.length && out[out.length - 1].role === "user") out.pop();
  return out;
}

function corsHeaders(origin, allowedList) {
  const ok = allowedList.split(",").map(s => s.trim()).filter(Boolean);
  const h = { "access-control-allow-methods": "POST, GET, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "86400", "vary": "Origin" };
  if (ok.includes(origin) || ok.includes("*")) h["access-control-allow-origin"] = ok.includes("*") ? "*" : origin;
  return h;
}
function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });
}
function pick(env, keys) { const o = {}; for (const k of keys) if (env && env[k] != null && env[k] !== "") o[k] = String(env[k]); return o; }
async function sha1(s) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

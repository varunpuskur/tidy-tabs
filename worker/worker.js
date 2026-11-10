// Tidy Tabs free-trial server (Cloudflare Worker).
//
// Holds the Gemini key as a secret so it never ships inside the extension, and gives each install
// a few free tidies before it has to bring its own key. Also: a share link that counts clicks, an
// uninstall feedback page, and a stats endpoint for you.
//
// Bindings (set in the Cloudflare dashboard or wrangler.toml):
//   TRIAL        KV namespace
//   GEMINI_KEY   secret: your Gemini API key
//   STATS_KEY    secret: any password, for GET /stats?key=...
//
// Routes:
//   POST /tidy       { id, prompt }      -> { text, remaining }   (the extension's free tidies)
//   GET  /status?id=                     -> { remaining }
//   GET  /get                            -> 302 to the store, counts a share click
//   GET  /bye                            -> uninstall feedback page;  POST /bye records the answer
//   GET  /stats?key=                     -> counters

const LIMIT = 5;                  // free tidies per install
const IP_PER_DAY = 20;            // backstop against someone reinstalling or scripting fake ids
const GLOBAL_PER_DAY = 2000;      // hard ceiling on what the trial can cost you in a day
const MAX_PROMPT = 20000;         // characters; a 60-tab prompt is about 9k
const PREFIX = "You are tidying a browser sidebar.";   // only our prompt gets through
const STORE = "https://chromewebstore.google.com/detail/cadaopjbichjjgljabfkokckndfgnpoa";
const MODELS = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"];

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...CORS } });
const today = () => new Date().toISOString().slice(0, 10);
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function bump(kv, key, ttl) {
  const n = parseInt((await kv.get(key)) || "0", 10) + 1;
  await kv.put(key, String(n), ttl ? { expirationTtl: ttl } : undefined);
  return n;
}
const count = async (kv, key) => parseInt((await kv.get(key)) || "0", 10);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    try {
      if (url.pathname === "/tidy" && req.method === "POST") return await tidy(req, env);
      if (url.pathname === "/status") {
        const id = url.searchParams.get("id") || "";
        if (!ID_RE.test(id)) return json({ error: "bad_id" }, 400);
        return json({ remaining: Math.max(0, LIMIT - (await count(env.TRIAL, "u:" + id))) });
      }
      if (url.pathname === "/get") {
        await bump(env.TRIAL, "c:share:" + today(), 400 * 86400).catch(() => {});
        await bump(env.TRIAL, "c:share:total").catch(() => {});
        return Response.redirect(`${STORE}?utm_source=share&utm_medium=friend`, 302);
      }
      if (url.pathname === "/bye") return req.method === "POST" ? await byePost(req, env) : byePage(url);
      if (url.pathname === "/stats") return await stats(url, env);
      return json({ ok: true, service: "tidy-tabs-trial" });
    } catch (e) {
      return json({ error: "server", message: String(e?.message || e) }, 500);
    }
  },
};

async function tidy(req, env) {
  let body;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const { id, prompt } = body || {};
  if (typeof id !== "string" || !ID_RE.test(id)) return json({ error: "bad_id" }, 400);
  if (typeof prompt !== "string" || !prompt.startsWith(PREFIX) || prompt.length > MAX_PROMPT) return json({ error: "bad_prompt" }, 400);

  const used = await count(env.TRIAL, "u:" + id);
  if (used >= LIMIT) return json({ error: "trial_used", remaining: 0 }, 402);

  const ip = req.headers.get("cf-connecting-ip") || "unknown";
  const day = today();
  if ((await count(env.TRIAL, `ip:${day}:${ip}`)) >= IP_PER_DAY) return json({ error: "ip_limit", remaining: LIMIT - used, message: "Too many free tidies from this network today. Add your own free key in Settings to keep going." }, 429);
  if ((await count(env.TRIAL, `g:${day}`)) >= GLOBAL_PER_DAY) return json({ error: "busy", remaining: LIMIT - used, message: "The free trial is at capacity today. Add your own free key in Settings to keep going." }, 503);

  const { text, quota } = await askGemini(prompt, env.GEMINI_KEY);
  if (!text && quota) return json({ error: "quota", remaining: LIMIT - used, message: "The free trial is out of capacity for today. Try again tomorrow, or add your own free Gemini key in Settings (takes a minute)." }, 503);
  if (!text) return json({ error: "busy", remaining: LIMIT - used, message: "Gemini is busy right now. Try again in a minute." }, 502);

  // Count only tidies that actually got an answer. Counter writes must never turn a good tidy into an error:
  // KV allows 1 write/sec per key (two users in the same second) and 1,000 writes/day on the free plan.
  const safe = (p) => p.catch(() => {});
  await safe(env.TRIAL.put("u:" + id, String(used + 1)));
  await safe(bump(env.TRIAL, `ip:${day}:${ip}`, 2 * 86400));
  await safe(bump(env.TRIAL, `g:${day}`, 400 * 86400));
  if (used === 0) await safe(bump(env.TRIAL, `c:firsttidy:${day}`, 400 * 86400));
  return json({ text, remaining: LIMIT - used - 1 });
}

// Returns { text } on success, or { text: "", quota: true } when every model said "out of quota" (free tier daily limit).
async function askGemini(prompt, key) {
  let quotaHits = 0;
  for (const model of MODELS) {
    for (const minimal of [false, true]) {
      const generationConfig = minimal
        ? { temperature: 0, maxOutputTokens: 2048 }
        : { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } };
      let r;
      try {
        r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": key },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
        });
      } catch { break; }
      if (r.ok) {
        const j = await r.json();
        const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
        if (text) return { text };
        break;
      }
      if (r.status === 400 && !minimal) continue;   // some models reject the optional settings
      if (r.status === 429) quotaHits++;
      break;                                         // 404 / 429 / 5xx: next model
    }
  }
  return { text: "", quota: quotaHits > 0 && quotaHits >= MODELS.length - 1 };
}

// ---- uninstall feedback ---------------------------------------------------------------------------
const REASONS = {
  setup: "Setting it up was too much work",
  nothing: "I clicked it and nothing happened",
  wrong: "The groups were wrong or too broad",
  arc: "I use Arc (it can't work there)",
  other: "Something else",
};
function byePage(url) {
  const v = (url.searchParams.get("v") || "").replace(/[^0-9.]/g, "").slice(0, 12);
  const opts = Object.entries(REASONS).map(([k, t]) => `<label><input type="radio" name="r" value="${k}"> ${t}</label>`).join("");
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tidy Tabs</title>
<style>:root{--bg:#fafaf9;--ink:#1c1917;--muted:#78716c;--line:#e7e5e4;--accent:#2563eb}@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--ink:#fafaf9;--muted:#a8a29e;--line:#44403c}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,system-ui,sans-serif}main{max-width:520px;margin:0 auto;padding:56px 16px}
h1{font-size:24px;margin:0 0 6px}p{color:var(--muted);margin:0 0 20px}label{display:block;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px;cursor:pointer}
textarea{width:100%;box-sizing:border-box;font:inherit;color:var(--ink);background:transparent;border:1px solid var(--line);border-radius:10px;padding:10px;margin-top:4px;min-height:70px}
button{font:inherit;margin-top:12px;padding:10px 18px;border-radius:10px;border:0;background:var(--accent);color:#fff;cursor:pointer}</style></head>
<body><main><h1>Sorry to see you go</h1><p>One click tells me what to fix. No email, no account, nothing else is recorded.</p>
<form id="f">${opts}<textarea name="t" maxlength="500" placeholder="Anything else? (optional)"></textarea><button>Send</button></form>
<p id="done" hidden>Thanks, that helps a lot.</p>
<script>document.getElementById("f").onsubmit=async(e)=>{e.preventDefault();const d=new FormData(e.target);
await fetch("/bye",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({r:d.get("r")||"",t:d.get("t")||"",v:${JSON.stringify(v)}})}).catch(()=>{});
e.target.hidden=true;document.getElementById("done").hidden=false;};</script></main></body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } });
}
async function byePost(req, env) {
  let b = {}; try { b = await req.json(); } catch {}
  const r = Object.hasOwn(REASONS, b.r) ? b.r : "none";
  await bump(env.TRIAL, "c:bye:" + r).catch(() => {});
  const t = String(b.t || "").slice(0, 500).trim();
  if (t) await env.TRIAL.put(`bye:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`, JSON.stringify({ r, t, v: String(b.v || "").slice(0, 12) }), { expirationTtl: 180 * 86400 });
  return json({ ok: true });
}

// ---- stats ----------------------------------------------------------------------------------------
async function stats(url, env) {
  if (!env.STATS_KEY || url.searchParams.get("key") !== env.STATS_KEY) return json({ error: "nope" }, 403);
  const days = [...Array(14)].map((_, i) => new Date(Date.now() - i * 86400e3).toISOString().slice(0, 10));
  const daily = {};
  for (const d of days) {
    daily[d] = {
      tidies: await count(env.TRIAL, `g:${d}`),
      firstTidies: await count(env.TRIAL, `c:firsttidy:${d}`),
      shareClicks: await count(env.TRIAL, `c:share:${d}`),
    };
  }
  const uninstallReasons = {};
  for (const k of [...Object.keys(REASONS), "none"]) uninstallReasons[k] = await count(env.TRIAL, "c:bye:" + k);
  const comments = [];
  const list = await env.TRIAL.list({ prefix: "bye:", limit: 50 });
  for (const k of list.keys.reverse()) { const v = await env.TRIAL.get(k.name); if (v) comments.push({ at: new Date(parseInt(k.name.split(":")[1], 10)).toISOString(), ...JSON.parse(v) }); }
  return json({ shareClicksTotal: await count(env.TRIAL, "c:share:total"), daily, uninstallReasons, comments });
}

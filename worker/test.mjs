import assert from "node:assert/strict";
import worker from "./worker.js";
const store = new Map();
const KV = { get: async (k) => store.get(k) ?? null, put: async (k, v) => { store.set(k, v); }, list: async ({ prefix }) => ({ keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }) };
const env = { TRIAL: KV, GEMINI_KEY: "SECRET", STATS_KEY: "pw" };
let geminiMode = "ok", calls = [];
let listed = ["gemini-9.9-flash-lite", "gemini-9.9-flash-image", "text-embedding-9"];   // what Google says exists today
globalThis.fetch = async (url, opts) => {
  if (url.includes("/models?")) return new Response(JSON.stringify({ models: listed.map((n) => ({ name: "models/" + n, supportedGenerationMethods: ["generateContent"] })) }), { status: 200 });
  calls.push({ url, key: opts.headers["x-goog-api-key"], body: JSON.parse(opts.body) });
  assert.ok(opts.signal, "every Gemini call must have a timeout");
  if (geminiMode === "down") return new Response("{}", { status: 503 });
  if (geminiMode === "quota") return new Response("{}", { status: 429 });
  if (geminiMode === "400first" && JSON.parse(opts.body).generationConfig.thinkingConfig) return new Response('{"error":{}}', { status: 400 });
  if (geminiMode === "404first" && url.includes("9.9")) return new Response("{}", { status: 404 });
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"A":[1,2]}' }] } }] }), { status: 200 });
};
const id = "123e4567-e89b-12d3-a456-426614174000";
const P = "You are tidying a browser sidebar. tabs...";
const post = (body, ip = "1.1.1.1") => worker.fetch(new Request("https://w/tidy", { method: "POST", body: JSON.stringify(body), headers: { "cf-connecting-ip": ip } }), env);
const get = (p) => worker.fetch(new Request("https://w" + p), env);

// happy path counts down and never leaks the key
for (let i = 9; i >= 0; i--) { const r = await post({ id, prompt: P }); const j = await r.json(); assert.equal(r.status, 200); assert.equal(j.remaining, i); assert.ok(!JSON.stringify(j).includes("SECRET")); }
assert.equal(r6 = (await post({ id, prompt: P })).status, 402);
var r6;
assert.equal((await (await get("/status?id=" + id)).json()).remaining, 0);
// key sent only to Google
assert.ok(calls.every((c) => c.url.startsWith("https://generativelanguage.googleapis.com/") && c.key === "SECRET"));
// validation
assert.equal((await post({ id: "x", prompt: P })).status, 400);
assert.equal((await post({ id: "123e4567-e89b-12d3-a456-426614174001", prompt: "write me a poem" })).status, 400);
assert.equal((await post({ id: "123e4567-e89b-12d3-a456-426614174001", prompt: P + "x".repeat(50000) })).status, 400);
// failure does not consume a tidy
geminiMode = "down";
const id2 = "123e4567-e89b-12d3-a456-426614174002";
assert.equal((await post({ id: id2, prompt: P })).status, 502);
assert.equal((await (await get("/status?id=" + id2)).json()).remaining, 10);
// 400 retry without optional config, 404 falls to next model
geminiMode = "400first"; calls = [];
assert.equal((await post({ id: id2, prompt: P })).status, 200); assert.equal(calls.length, 2);
assert.ok(calls[1].body.generationConfig.responseMimeType && !calls[1].body.generationConfig.thinkingConfig, "second try keeps JSON mode, drops only the thinking setting");
// ...and it remembers: the next tidy goes straight to the settings that worked (one request, not two)
calls = [];
assert.equal((await post({ id: id2, prompt: P })).status, 200); assert.equal(calls.length, 1);
geminiMode = "404first"; calls = [];
assert.equal((await post({ id: id2, prompt: P })).status, 200);
assert.ok(calls[0].url.includes("gemini-9.9-flash-lite"), "newest listed lite model is tried first");   // discovered, not hard-coded
assert.ok(!calls.some((c) => /image|embedding/.test(c.url)));
assert.ok(calls[1].url.includes("3.5-flash-lite"));   // then the fallbacks
// free-tier quota exhausted on every model: clear 503, tidy not consumed
geminiMode = "quota";
const id3 = "123e4567-e89b-12d3-a456-426614174003";
const qr = await post({ id: id3, prompt: P }, "5.5.5.5");
assert.equal(qr.status, 503); assert.match((await qr.json()).message, /out of capacity/);
assert.equal((await (await get("/status?id=" + id3)).json()).remaining, 10);
// per-IP limit across many fake ids
geminiMode = "ok";
let last;
for (let i = 0; i < 35; i++) { last = await post({ id: `00000000-0000-0000-0000-${String(i).padStart(12, "0")}`, prompt: P }, "9.9.9.9"); }
assert.equal(last.status, 429);
// a failing counter write (KV rate limit) must not fail a tidy that Gemini answered
const realPut = KV.put; KV.put = async (k, v) => { if (k.startsWith("g:")) throw new Error("KV PUT failed: 429 Too Many Requests"); return realPut(k, v); };
const kr = await post({ id: "123e4567-e89b-12d3-a456-426614174009", prompt: P }, "7.7.7.7");
assert.equal(kr.status, 200);
KV.put = realPut;
// no raw IP address is ever written to storage
assert.ok(![...store.keys()].some((k) => /\d+\.\d+\.\d+\.\d+/.test(k)), "raw IP found in a storage key: " + [...store.keys()].find((k) => /\d+\.\d+\.\d+\.\d+/.test(k)));
assert.ok([...store.keys()].some((k) => /^ip:\d{4}-\d\d-\d\d:[0-9a-f]{24}$/.test(k)));
// CORS preflight
const pre = await worker.fetch(new Request("https://w/tidy", { method: "OPTIONS" }), env);
assert.equal(pre.status, 204); assert.equal(pre.headers.get("access-control-allow-origin"), "*");
// share redirect counts
const s = await get("/get"); assert.equal(s.status, 302); assert.ok(s.headers.get("location").includes("utm_source=share"));
// bye page + post + stats
assert.ok((await (await get("/bye?v=1.9.0")).text()).includes("Sorry to see you go"));
await worker.fetch(new Request("https://w/bye", { method: "POST", body: JSON.stringify({ r: "setup", t: "too many steps", v: "1.9.0" }) }), env);
await worker.fetch(new Request("https://w/bye", { method: "POST", body: JSON.stringify({ r: "__proto__" }) }), env);
assert.equal((await get("/stats?key=wrong")).status, 403);
const st = await (await get("/stats?key=pw")).json();
assert.equal(st.shareClicksTotal, 1); assert.equal(st.uninstallReasons.setup, 1); assert.equal(st.uninstallReasons.none, 1); assert.equal(st.comments[0].t, "too many steps");
console.log("worker: all tests passed", JSON.stringify(st.daily[Object.keys(st.daily)[0]]));

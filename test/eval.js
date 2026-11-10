// Grouping benchmark. Runs the real extension code in the fake browser on the tab sets in bench-data.js,
// with a real model answering, and scores the groups that end up in the tab bar against the hand labels.
//
//   GEMINI_KEY=AIza... node test/eval.js                 score the current code with Gemini (what users get)
//   GEMINI_KEY=AIza... node test/eval.js baseline        score the 1.8.0 grouping code for comparison
//   MODEL=claude-cli node test/eval.js [baseline]        use the local `claude` CLI (Haiku) as a stand-in model
//
// Options (env): RUNS=3 (repeats per tab set), ORDER=natural|shuffled, ONLY="substring of a set name"
// Scores: see score() below. Model answers are cached in test/.eval-cache.json so re-scoring is free.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");
const { makeBrowser } = require("./harness");
const SETS = require("./bench-data");

const variant = process.argv[2] || "current";
const RUNS = +(process.env.RUNS || 3);
const ORDER = process.env.ORDER || "natural";
const ONLY = process.env.ONLY || "";
const MODEL = process.env.MODEL || (process.env.GEMINI_KEY ? "gemini" : "claude-cli");
const CACHE_FILE = process.env.CACHE || path.join(__dirname, ".eval-cache.json");
const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};

// ---- variants: swap named top-level functions in background.js for the ones in a variant file ----
function swapFunctions(src, replacement) {
  const defs = replacement.split(/\n(?=(?:async )?function \w+\()/).filter((d) => /^(?:async )?function \w+\(/.test(d.trim()));
  for (const def of defs) {
    const name = def.trim().match(/function (\w+)\(/)[1];
    const re = new RegExp(`^(?:async )?function ${name}\\([\\s\\S]*?\\n}\\n`, "m");
    if (!re.test(src)) throw new Error("variant: no function " + name + " in background.js");
    src = src.replace(re, () => def.trim() + "\n");
  }
  return src;
}
const transformSource = variant === "current" ? undefined
  : (src) => swapFunctions(src, require(variant === "baseline" ? "./baseline-1.8.0.js" : path.resolve(variant)));

// ---- seeded randomness so every variant sees the same tab bars ----
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function shuffle(a, r) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

// Lay a tab set out the way a real tab bar looks: tabs for one task mostly sit together (they were opened
// together), with about a third wandering elsewhere; some tabs remember which tab opened them.
function layout(set, seed) {
  const r = rng(seed);
  const tabs = set.tabs.map(([title, url, gold], i) => ({ title, url, gold, key: i }));
  let order;
  if (ORDER === "shuffled") order = shuffle([...tabs], r);
  else {
    const sessions = new Map();
    for (const t of tabs) { const k = t.gold === "-" ? "-" + t.key : t.gold; (sessions.get(k) || sessions.set(k, []).get(k)).push(t); }
    order = shuffle([...sessions.values()], r).flat();
    for (let i = 0; i < order.length; i++) if (r() < 0.3) { const [t] = order.splice(i, 1); order.splice(Math.floor(r() * (order.length + 1)), 0, t); }
  }
  let id = 1294830000 + Math.floor(r() * 5000);
  order.forEach((t, index) => { id += 1 + Math.floor(r() * 40); Object.assign(t, { id, index }); });
  if (ORDER !== "shuffled") order.forEach((t, i) => {
    if (t.gold === "-" || r() > 0.35) return;
    const earlier = order.slice(0, i).filter((o) => (r() < 0.9 ? o.gold === t.gold : true));
    if (earlier.length) t.openerTabId = earlier[Math.floor(r() * earlier.length)].id;
  });
  return order;
}

// ---- the model ----
let calls = 0, inChars = 0, outChars = 0;
function askCli(prompt) {
  return new Promise((resolve, reject) => {
    const child = execFile("claude", ["-p", "--model", "haiku", "--system-prompt", "Follow the instructions in the message exactly.", "--tools", "", "--strict-mcp-config", "--output-format", "json"],
      { env: { ...process.env, MAX_THINKING_TOKENS: "0" }, maxBuffer: 8e6, timeout: 120000 },
      (err, stdout) => { if (err) return reject(err); try { resolve(JSON.parse(stdout).result || ""); } catch (e) { reject(e); } });
    child.stdin.end(prompt);
  });
}
async function model(prompt, run) {
  const key = crypto.createHash("sha1").update(MODEL + "\n" + run + "\n" + prompt).digest("hex");
  if (!(key in cache)) {
    if (MODEL !== "claude-cli") throw new Error("internal: only the CLI path is cached here");
    cache[key] = await askCli(prompt);
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
  }
  calls++; inChars += prompt.length; outChars += cache[key].length;
  return cache[key];
}
// Gemini's free tier allows only a few requests a minute. Send one at a time with a gap, and when Google says
// "slow down" (429), wait as long as it asks and try the same request again, so every tab set gets an answer
// from the same model. A daily limit can't be waited out, so that stops the run with a clear message.
let chain = Promise.resolve(), gap = +(process.env.GAP || 4500), lastAt = 0;
const modelsUsed = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function paced(fn) { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; }
async function geminiOnce(url, opts) {
  for (let attempt = 0; ; attempt++) {
    await sleep(Math.max(0, lastAt + gap - Date.now()));
    lastAt = Date.now();
    let r, body;
    try { r = await fetch(url, { method: "POST", headers: { ...opts.headers, "x-goog-api-key": process.env.GEMINI_KEY }, body: opts.body }); body = await r.text(); }
    catch (e) { if (attempt < 5) { await sleep(5000); continue; } throw e; }
    if (r.ok) { process.stderr.write("."); return { status: 200, body }; }
    if (r.status === 429) {
      let j = {}; try { j = JSON.parse(body); } catch {}
      const details = j.error?.details || [];
      const perDay = JSON.stringify(details).match(/PerDay/i);
      const wait = parseFloat(details.find((d) => d.retryDelay)?.retryDelay) || 30;
      if (perDay && !/PerMinute/i.test(JSON.stringify(details))) {
        console.error(`\n\nGemini's free DAILY limit for this model is used up, so the benchmark can't finish today.\nRun the same command again tomorrow (answers so far are saved, it picks up where it stopped).\n${(j.error?.message || "").slice(0, 300)}`);
        process.exit(2);
      }
      if (attempt < 12) { process.stderr.write(`[limit, waiting ${Math.ceil(wait)}s]`); gap = Math.min(15000, gap * 1.3); await sleep((wait + 1) * 1000); continue; }
    }
    if (r.status >= 500 && attempt < 5) { process.stderr.write("[busy]"); await sleep(6000); continue; }
    return { status: r.status, body };     // 400 / 404 etc.: let the extension's own fallback handle it
  }
}
function fetchFor(run) {
  return async (url, opts) => {
    if (url.includes("/models?")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    if (!url.includes("generativelanguage")) throw new Error("unexpected fetch " + url);
    if (MODEL === "gemini") {
      const key = crypto.createHash("sha1").update("gemini\n" + run + "\n" + url + opts.body).digest("hex");
      if (!(key in cache)) {
        const res = await paced(() => geminiOnce(url, opts));
        if (res.status !== 200) return new Response(res.body, { status: res.status });
        cache[key] = res.body; fs.writeFileSync(CACHE_FILE, JSON.stringify(cache));
      }
      const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
      modelsUsed.add((url.match(/models\/([^:]+):/) || [])[1]);
      calls++; inChars += prompt.length; outChars += (JSON.parse(cache[key]).candidates?.[0]?.content?.parts?.[0]?.text || "").length;
      return new Response(cache[key], { status: 200 });
    }
    const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: await model(prompt, run) }] } }] }), { status: 200 });
  };
}

// ---- one tidy in the fake browser ----
let cfgMemory = null;
async function runOnce(set, seed, run) {
  class NoAbort { constructor() { this.signal = undefined; } abort() {} }   // requests queue here for minutes; the extension's 15s give-up must not fire
  const b = makeBrowser({ fetchImpl: fetchFor(run), transformSource, realTimers: true, AbortControllerImpl: NoAbort });
  const tabs = layout(set, seed);
  b.state.tabs = tabs.map((t) => ({ id: t.id, windowId: 1, index: t.index + 100, url: t.url, title: t.title, pinned: false, groupId: -1, active: false, highlighted: false, lastAccessed: Date.now() - 600e3, openerTabId: t.openerTabId }));
  // Groups that already exist (the re-tidy case).
  let gid = 500, xid = 1294000000, xi = 0;
  for (const [title, members] of Object.entries(set.existing || {})) {
    b.state.groups.set(++gid, { id: gid, windowId: 1, title, color: "blue", collapsed: false });
    for (const [t, u] of members) b.state.tabs.push({ id: (xid += 7), windowId: 1, index: xi++, url: u, title: t, pinned: false, groupId: gid, active: false, highlighted: false, lastAccessed: Date.now() - 3600e3 });
  }
  b.state.tabs[0].active = true;
  await b.chrome.storage.sync.set({ provider: "gemini", apiKey: "bench" });
  if (cfgMemory) await b.chrome.storage.local.set({ geminiCfg: cfgMemory });   // a real browser remembers which settings a model accepts
  let error = "";
  const r = await b.t.tidy().catch((e) => ({ error: String(e.message || e) }));
  if (r?.error) error = r.error;
  cfgMemory = (await b.chrome.storage.local.get("geminiCfg")).geminiCfg || cfgMemory;
  const titleOf = new Map([...b.state.groups.values()].map((g) => [g.id, g.title]));
  const pred = tabs.map((t) => { const live = b.state.tabs.find((x) => x.id === t.id); return live && live.groupId !== -1 ? titleOf.get(live.groupId) || "?" : "-"; });
  return { tabs, pred, error };
}

// ---- scoring ----
// placed    : share of all tabs that ended up where the hand labels say (right group, or correctly left loose)
// pairF1    : of all pairs of tabs, how well "these two are together" matches the hand labels (precision/recall/F1)
// dropped   : share of tabs that belong in a group but were left loose
// forced    : share of tabs that should stay loose but were pushed into a group
// exact     : share of hand-labeled groups reproduced exactly (same members, nothing extra)
// names     : share of matched groups whose name contains one of the expected words
function score(set, { tabs, pred }) {
  const gold = tabs.map((t) => t.gold);
  const n = tabs.length;
  let tp = 0, fp = 0, fn = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const g = gold[i] !== "-" && gold[i] === gold[j], p = pred[i] !== "-" && pred[i] === pred[j];
    if (g && p) tp++; else if (p) fp++; else if (g) fn++;
  }
  const P = tp + fp ? tp / (tp + fp) : 1, R = tp + fn ? tp / (tp + fn) : 1;
  const goldGroups = [...new Set(gold.filter((g) => g !== "-"))], predGroups = [...new Set(pred.filter((p) => p !== "-"))];
  // one-to-one match of gold groups to predicted groups by overlap (greedy on largest overlap)
  const overlaps = [];
  for (const g of goldGroups) for (const p of predGroups) { const o = gold.filter((x, i) => x === g && pred[i] === p).length; if (o) overlaps.push([o, g, p]); }
  overlaps.sort((a, b) => b[0] - a[0]);
  const match = new Map(), usedP = new Set();
  for (const [, g, p] of overlaps) if (!match.has(g) && !usedP.has(p)) { match.set(g, p); usedP.add(p); }
  let placed = 0, dropped = 0, forced = 0, grouped = 0, loose = 0;
  for (let i = 0; i < n; i++) {
    if (gold[i] === "-") { loose++; if (pred[i] === "-") placed++; else forced++; }
    else { grouped++; if (pred[i] === "-") dropped++; else if (match.get(gold[i]) === pred[i]) placed++; }
  }
  let exact = 0, named = 0;
  for (const g of goldGroups) {
    const p = match.get(g);
    if (!p) continue;
    const gi = gold.map((x, i) => (x === g ? i : -1)).filter((i) => i >= 0), pi = pred.map((x, i) => (x === p ? i : -1)).filter((i) => i >= 0);
    if (gi.length === pi.length && gi.every((i) => pred[i] === p)) exact++;
    if ((set.keys[g] || [g]).some((k) => p.toLowerCase().includes(k.toLowerCase()))) named++;
  }
  return { n, placed: placed / n, P, R, F1: P + R ? (2 * P * R) / (P + R) : 0, dropped: grouped ? dropped / grouped : 0, forced: loose ? forced / loose : 0,
    exact: goldGroups.length ? exact / goldGroups.length : (predGroups.length ? 0 : 1), names: match.size ? named / match.size : 1, groups: predGroups.length, goldGroups: goldGroups.length };
}

const pct = (x) => (100 * x).toFixed(1).padStart(5);
async function pool(jobs, size) { const out = []; let i = 0; await Promise.all([...Array(size)].map(async () => { while (i < jobs.length) { const k = i++; out[k] = await jobs[k](); } })); return out; }

(async () => {
  const sets = SETS.filter((s) => s.name.includes(ONLY));
  const jobs = [];
  // The seed comes from the set's position in the full list, so ONLY= shows exactly the tab bars (and reuses
  // exactly the saved answers) of a full run.
  sets.forEach((set) => { const si = SETS.indexOf(set); for (let run = 0; run < RUNS; run++) jobs.push(async () => ({ set, run, res: await runOnce(set, 1000 + si, run) })); });
  if (MODEL === "gemini") console.error(`Asking Gemini ${jobs.length} times, a few seconds apart to stay inside the free limits. About ${Math.ceil(jobs.length * 5 / 60)} minutes; one dot per answer.`);
  const results = await pool(jobs, +(process.env.JOBS || (MODEL === "gemini" ? 2 : 5)));
  if (MODEL === "gemini") console.error("");
  const rows = [], all = [];
  for (const set of sets) {
    const rs = results.filter((r) => r.set === set).map((r) => ({ ...score(set, r.res), error: r.res.error }));
    const avg = (k) => rs.reduce((a, r) => a + r[k], 0) / rs.length;
    rows.push(`${set.name.slice(0, 44).padEnd(44)} ${String(set.tabs.length).padStart(3)}  ${pct(avg("placed"))} ${pct(avg("F1"))} ${pct(avg("dropped"))} ${pct(avg("forced"))} ${pct(avg("exact"))} ${pct(avg("names"))}  ${avg("groups").toFixed(1)}/${rs[0].goldGroups}${rs.some((r) => r.error) ? "  ERR " + rs.find((r) => r.error).error.replace(/\s+/g, " ").slice(0, 70) : ""}`);
    all.push(...rs);
    if (process.env.SHOW) for (const r of results.filter((x) => x.set === set).slice(0, 1)) {
      const by = {}; r.res.tabs.forEach((t, i) => (by[r.res.pred[i]] ||= []).push(`${t.gold === "-" ? "·" : t.gold}: ${t.title.slice(0, 50)}`));
      console.log(JSON.stringify(by, null, 1));
    }
  }
  const tot = (k) => all.reduce((a, r) => a + r[k] * r.n, 0) / all.reduce((a, r) => a + r.n, 0);     // weighted by tabs
  const mean = (k) => all.reduce((a, r) => a + r[k], 0) / all.length;                               // per tab set
  console.log(`\nvariant: ${variant}   model: ${MODEL}   order: ${ORDER}   runs per set: ${RUNS}\n`);
  console.log(`${"tab set".padEnd(44)} tabs  placed  F1   dropped forced exact names  groups made/expected`);
  console.log(rows.join("\n"));
  console.log(`${"ALL (weighted by tabs; exact/names per set)".padEnd(44)} ${String(sets.reduce((a, s) => a + s.tabs.length, 0)).padStart(3)}  ${pct(tot("placed"))} ${pct(tot("F1"))} ${pct(tot("dropped"))} ${pct(tot("forced"))} ${pct(mean("exact"))} ${pct(mean("names"))}`);
  if (modelsUsed.size) console.log(`answered by: ${[...modelsUsed].join(", ")}`);
  console.log(`errors: ${all.filter((r) => r.error).length}/${all.length} runs   model calls: ${calls}   avg prompt: ${Math.round(inChars / Math.max(1, calls))} chars   avg answer: ${Math.round(outChars / Math.max(1, calls))} chars`);
  console.log(JSON.stringify({ variant, model: MODEL, order: ORDER, placed: tot("placed"), F1: tot("F1"), P: tot("P"), R: tot("R"), dropped: tot("dropped"), forced: tot("forced"), exact: mean("exact"), names: mean("names"), errors: all.filter((r) => r.error).length, runs: all.length, promptChars: Math.round(inChars / Math.max(1, calls)), answerChars: Math.round(outChars / Math.max(1, calls)) }));
})();

// Tidy Tabs — one-click AI tab grouping, in the spirit of Arc's Tidy Tabs.
// Works in any Chromium browser with native tab groups (Dia, Chrome, Brave, Edge).

const COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];

// =============================================================================================
// Entry points: icon click, keyboard shortcut, context menu, messages from the settings page
// =============================================================================================

chrome.action.onClicked.addListener(() => runWithFeedback(tidy));
chrome.commands.onCommand.addListener((cmd) => { if (cmd === "tidy") runWithFeedback(tidy); });

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);
chrome.storage.onChanged.addListener((c) => { if (c.autoTidy) buildMenus(); });

async function buildMenus() {
  const { autoTidy = false } = await chrome.storage.sync.get("autoTidy");
  await chrome.contextMenus.removeAll();
  const contexts = ["action", "page"];
  chrome.contextMenus.create({ id: "tidy", title: "🧹 Tidy tabs", contexts });
  chrome.contextMenus.create({ id: "ungroup", title: "Ungroup all", contexts });
  chrome.contextMenus.create({ id: "sep", type: "separator", contexts });
  chrome.contextMenus.create({ id: "protect", title: "Never tidy this tab", contexts: ["page"] });
  chrome.contextMenus.create({ id: "unprotect", title: "Allow tidying this tab again", contexts: ["page"] });
  chrome.contextMenus.create({ id: "sep2", type: "separator", contexts });
  chrome.contextMenus.create({ id: "auto", title: "Auto-tidy", type: "checkbox", checked: autoTidy, contexts });
  chrome.contextMenus.create({ id: "settings", title: "Settings…", contexts });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === "protect" || info.menuItemId === "unprotect") {
    const key = protectKey(tab?.url || info.pageUrl);
    if (!key) return;
    const { protectedUrls = [] } = await chrome.storage.sync.get("protectedUrls");
    const next = info.menuItemId === "protect" ? [...new Set([...protectedUrls, key])] : protectedUrls.filter((u) => u !== key);
    await chrome.storage.sync.set({ protectedUrls: next });
    await setBadge(info.menuItemId === "protect" ? "🔒" : "✓", "#6b7280"); setTimeout(refreshBadge, 1500);
    return;
  }
  if (info.menuItemId === "tidy") runWithFeedback(tidy);
  else if (info.menuItemId === "ungroup") runWithFeedback(ungroup);
  else if (info.menuItemId === "auto") chrome.storage.sync.set({ autoTidy: !!info.checked });
  else if (info.menuItemId === "settings") chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const run = (fn) => fn().then(reply).catch((e) => reply({ error: errMsg(e) }));
  if (msg.type === "tidy") { run(() => runWithFeedback(tidy)); return true; }
  if (msg.type === "ungroup") { run(() => runWithFeedback(ungroup)); return true; }
  if (msg.type === "diag") { run(diag); return true; }
  if (msg.type === "testai") { run(testAI); return true; }
});

// Runs an action with badge feedback ("…" → "✓" / "!") and records the outcome for the settings page.
async function runWithFeedback(fn) {
  await setBadge("…", "#2563eb");
  let result;
  try { result = await fn(); } catch (e) { result = { error: errMsg(e) }; }
  const ok = !result?.error;
  await chrome.storage.local.set({ lastResult: { at: Date.now(), ...result } });
  await setBadge(ok ? "✓" : "!", ok ? "#16a34a" : "#dc2626");
  setTimeout(refreshBadge, 2500);
  return result;
}

// =============================================================================================
// Badge (loose-tab count) and auto-tidy
// =============================================================================================

let busySince = 0;                 // when the running tidy started; 0 when idle
const BUSY_MAX_MS = 60_000;        // a tidy older than this is considered wedged
const AUTO_COOLDOWN_MS = 90_000;   // minimum gap between automatic tidies
const AUTO_SETTLE_MS = 4_000;      // wait for a burst of new tabs to finish before auto-tidying
let autoTimer = null;

const isBusy = () => busySince && Date.now() - busySince < BUSY_MAX_MS;

async function refreshBadge() {
  try {
    const win = await focusedWindow();
    const n = (await looseTabs(win.id)).length;
    const { autoTidy = false, autoThreshold = 8 } = await chrome.storage.sync.get(["autoTidy", "autoThreshold"]);
    await setBadge(n > 1 ? String(n) : "", autoTidy && n >= autoThreshold ? "#dc2626" : "#6b7280");
  } catch {}
}

function scheduleAuto() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(async () => {
    await refreshBadge();
    const { autoTidy = false, autoThreshold = 8, provider = "domain", apiKey = "" } =
      await chrome.storage.sync.get(["autoTidy", "autoThreshold", "provider", "apiKey"]);
    if (!autoTidy || isBusy()) return;
    if (provider !== "domain" && provider !== "ondevice" && !apiKey) return;   // no key: don't surprise people with domain groups
    const { lastAuto = 0, lastAutoSig = "" } = await chrome.storage.local.get(["lastAuto", "lastAutoSig"]);
    if (Date.now() - lastAuto < AUTO_COOLDOWN_MS) return;
    const win = await focusedWindow();
    const loose = await looseTabs(win.id);
    if (loose.length < autoThreshold) return;
    // Don't re-run on the same set of loose tabs; the model already declined to group these.
    const sig = loose.map((t) => t.id).sort().join(",");
    if (sig === lastAutoSig) return;
    await chrome.storage.local.set({ lastAuto: Date.now(), lastAutoSig: sig });
    try { await tidy(); } catch (e) { console.warn("Tidy Tabs auto-tidy:", e); }
    await refreshBadge();
  }, AUTO_SETTLE_MS);
}

chrome.tabs.onCreated.addListener(scheduleAuto);
chrome.tabs.onRemoved.addListener(scheduleAuto);
chrome.tabs.onUpdated.addListener((_id, info) => { if (info.status === "complete" || info.groupId !== undefined) scheduleAuto(); });
chrome.tabGroups.onRemoved.addListener(scheduleAuto);
chrome.windows.onFocusChanged.addListener(refreshBadge);
chrome.storage.onChanged.addListener(refreshBadge);
chrome.runtime.onStartup.addListener(refreshBadge);
chrome.runtime.onInstalled.addListener(refreshBadge);
refreshBadge();

// =============================================================================================
// Tidy
// =============================================================================================

async function tidy() {
  if (isBusy()) return { error: "Already tidying — give it a moment" };
  busySince = Date.now();
  try { return await tidyInner(); } finally { busySince = 0; refreshBadge(); }
}

async function tidyInner() {
  const win = await focusedWindow();
  const all = (await inScope(await chrome.tabs.query({ windowId: win.id }))).filter((t) => !t.pinned);
  const { provider = "domain", apiKey = "", keepGroups = true, closeDupes = false, otherGroup = false, granularity = "balanced" } =
    await chrome.storage.sync.get(["provider", "apiKey", "keepGroups", "closeDupes", "otherGroup", "granularity"]);

  // Duplicates: runs on every unpinned tab (closing works even on internal pages), keeps the newest copy,
  // and never closes the tab the person is looking at.
  let dupes = 0;
  if (closeDupes) {
    const seen = new Set();
    for (const t of [...all].reverse()) {
      const key = (t.url || t.pendingUrl || "").replace(/#.*$/, "");
      if (!key || t.active) { seen.add(key); continue; }
      if (seen.has(key)) { try { await chrome.tabs.remove(t.id); all.splice(all.indexOf(t), 1); dupes++; } catch {} }
      else seen.add(key);
    }
  }

  const prot = await protectedSet();
  const tabs = all.filter((t) => isWebTab(t) && !isProtected(t, prot));
  if (tabs.length < 2) return { groups: 0, tabs: tabs.length, dupes, skipped: [] };

  const existing = await queryGroups(win.id);
  const todo = keepGroups ? tabs.filter((t) => t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) : tabs;
  if (todo.length === 0) return { groups: 0, tabs: 0, dupes, skipped: [] };

  const plan = (provider === "domain" || (provider !== "ondevice" && !apiKey))
    ? byDomain(todo)
    : await byAI(todo, existing.map((g) => g.title).filter(Boolean), provider, apiKey, granularity);

  const byId = Object.fromEntries(todo.map((t) => [t.id, t]));
  const refused = new Map();   // tabId -> error; a tab the browser refuses once is skipped for the rest of the run
  let made = 0;

  for (const [title, ids] of Object.entries(plan)) {
    const isOther = /^other$/i.test(title.trim());
    if (isOther && !otherGroup) continue;   // default: strays stay loose, like Arc did
    const valid = ids.filter((id) => byId[id] && !refused.has(id));
    if (valid.length === 0) continue;

    const match = existing.find((g) => (g.title || "").toLowerCase() === (isOther ? "other" : title.toLowerCase()));
    if (match) { await addToGroup(match.id, valid, refused); continue; }
    if (!isOther && valid.length < 2) continue;

    const groupId = await makeGroup(valid, win.id, refused);
    if (groupId == null) continue;
    if (isOther) await updateGroup(groupId, { title: "Other", color: "grey", collapsed: true });
    else { await updateGroup(groupId, { title, color: COLORS[made % COLORS.length], collapsed: false }); made++; }
  }

  const skipped = [...refused].map(([id, err]) => ({ title: (byId[id]?.title || String(id)).slice(0, 40), err }));
  if (skipped.length) console.warn("Tidy Tabs: browser refused to group", skipped);
  const { scope = "window" } = await chrome.storage.sync.get("scope");
  return { groups: made, tabs: todo.length, dupes, skipped, scope };
}

async function ungroup() {
  const win = await focusedWindow();
  const tabs = await inScope(await chrome.tabs.query({ windowId: win.id }));
  const prot = await protectedSet();
  const ids = tabs.filter((t) => isWebTab(t) && !isProtected(t, prot) && t.groupId !== chrome.tabGroups.TAB_GROUP_ID_NONE).map((t) => t.id);
  if (ids.length) await withTimeout(chrome.tabs.ungroup(ids));
  return { ungrouped: ids.length };
}

// Try the whole batch; if the browser rejects it, go tab-by-tab so one refused tab doesn't sink the group.
async function makeGroup(tabIds, windowId, refused) {
  try { return await group({ tabIds, createProperties: { windowId } }); } catch {}
  let groupId = null;
  for (const id of tabIds) {
    try {
      groupId = groupId == null
        ? await group({ tabIds: [id], createProperties: { windowId } })
        : (await group({ tabIds: [id], groupId }), groupId);
    } catch (e) { refused.set(id, errMsg(e)); }
  }
  return groupId;
}

async function addToGroup(groupId, tabIds, refused) {
  for (const id of tabIds) {
    try { await group({ tabIds: [id], groupId }); } catch (e) { refused.set(id, errMsg(e)); }
  }
}

// =============================================================================================
// Grouping strategies
// =============================================================================================

// Keyless fallback: group by site name (github.com -> "Github").
function byDomain(tabs) {
  const plan = {};
  for (const t of tabs) {
    let host = "Other";
    try { host = new URL(t.url).hostname.replace(/^www\./, "").split(".").slice(-2, -1)[0] || "Other"; } catch {}
    const title = host.charAt(0).toUpperCase() + host.slice(1);
    (plan[title] ||= []).push(t.id);
  }
  return plan;
}

let lastModel = "";   // which model answered most recently; shown by "Test AI key"
let lastRaw = "";     // the model's raw reply, for diagnostics

async function byAI(tabs, existingTitles, provider, apiKey, granularity = "balanced") {
  const list = tabs.map((t) => `${t.id}\t${(t.title || "").slice(0, 80)}\t${(t.url || "").slice(0, 120)}`).join("\n");
  // A concrete example with real ids: small local models copy placeholder examples literally.
  const ex = tabs.slice(0, 3).map((t) => t.id);
  const example = ex.length >= 3 ? `{"Example topic": [${ex[0]}, ${ex[1]}], "Other": [${ex[2]}]}` : `{"Example topic": [${ex.join(", ")}]}`;

  const n = tabs.length;
  const levels = {
    broad: {
      size: "Prefer a few large groups. A slightly broader name is fine when it lets a related tab join.",
      count: `Aim for 2-4 groups.`, max: 99,
    },
    balanced: {
      size: "Group by the specific project or activity, not the general field: \"LeetCode\" and \"CS50\" are different groups even though both are coding; \"Flights\" and \"Hotels\" can share a \"Japan trip\" group because they're one task.",
      count: `Aim for ${Math.max(2, Math.min(8, Math.round(n / 4)))}-${Math.max(3, Math.min(10, Math.round(n / 2.5)))} groups.`, max: 8,
    },
    specific: {
      size: "Be precise. Each group is one concrete task, site, or subject: separate LeetCode problems from CS50 lectures from unrelated videos. Never merge different subjects just because they're both \"work\" or \"coding\".",
      count: `Aim for ${Math.max(3, Math.min(10, Math.round(n / 3)))}-${Math.max(4, Math.min(12, Math.round(n / 2)))} groups.`, max: 5,
    },
  };
  const g = levels[granularity] || levels.balanced;

  const prompt = `You are tidying a browser sidebar. Group these tabs by what the person is actually working on, the way they would organize them by hand.

Rules:
- Group names: 1-3 words, specific enough that a stranger would know what's inside.
- ${g.size}
- ${g.count} A group needs at least 2 tabs. No group may have more than ${g.max} tabs; if it would, split it by subtopic.
- Everyday tools (email inbox, calendar, drive, messaging, settings) do NOT belong in a topic group. Leave them in "Other" unless the title clearly ties them to a project.
- Unrelated one-off pages and random videos go in "Other" rather than being forced into the nearest group.
- AI chat tabs (ChatGPT, Claude, Gemini, etc.) go with the project their title is about, if one exists; otherwise "Other".
- Every tab id appears exactly once.${existingTitles.length ? `
- These groups already exist; reuse their exact names when a tab fits: ${existingTitles.join(", ")}.` : ""}

Return ONLY a JSON object. Keys are group names you invent; values are arrays of the numeric ids from the list below. The shape is like ${example} but with your own group names and all ${n} ids.

id\ttitle\turl
${list}`;

  const ask = () =>
    provider === "ondevice" ? askOnDevice(prompt)
    : provider === "gemini" ? askGemini(prompt, apiKey)
    : provider === "anthropic" ? askClaude(prompt, apiKey)
    : askOpenAI(prompt, apiKey);

  const validIds = new Set(tabs.map((t) => t.id));
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {     // one retry: local models occasionally mangle the JSON
    try { return parsePlan(await ask(), validIds); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function parsePlan(text, validIds) {
  const m = (text || "").match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Model returned no JSON");
  let plan;
  try { plan = JSON.parse(m[0]); } catch (e) { throw new Error("Model returned invalid JSON: " + errMsg(e)); }
  const clean = {};
  for (const [k, v] of Object.entries(plan)) {
    const ids = [].concat(v).map(Number).filter((id) => validIds.has(id));
    if (ids.length) clean[String(k).trim()] = ids;
  }
  if (!Object.keys(clean).length) throw new Error("Model returned a plan with no real tab ids");
  return clean;
}

// Each request gets its own deadline so a stalled provider fails loudly instead of leaving the badge on "…".
function fetchWithTimeout(url, opts, ms = 15_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...opts, signal: ctl.signal })
    .catch((e) => { throw new Error(e.name === "AbortError" ? `no reply in ${ms / 1000}s` : "Network: " + e.message); })
    .finally(() => clearTimeout(t));
}

// Gemini free tier: Flash-Lite models allow ~500 requests/day, full Flash only ~20, and both get
// "high demand" bursts. Ask which models the key can use, prefer the lite ones, retry sensibly.
async function askGemini(prompt, apiKey) {
  const models = await geminiModels(apiKey);
  const overloaded = (status, msg) => status === 503 || /high demand|overloaded|try again later/i.test(msg || "");
  const log = [`candidates: ${models.join(", ")}`];
  for (const model of models) {
    let minimal = false;   // after a 400, resend without the optional settings some models reject
    for (let attempt = 0; attempt < 3; attempt++) {
      const t0 = Date.now();
      const generationConfig = minimal
        ? { temperature: 0, maxOutputTokens: 2048 }
        : { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 2048, thinkingConfig: { thinkingBudget: 0 } };
      let r;
      try {
        r = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
        });
      } catch (e) { log.push(`${model}#${attempt + 1} ${Date.now() - t0}ms: ${e.message}`); continue; }
      const j = await r.json();
      if (r.ok) {
        const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
        if (!text) throw new Error("Gemini: " + (j.candidates?.[0]?.finishReason || "empty reply"));
        lastModel = model;
        return text;
      }
      const msg = j.error?.message || r.statusText;
      log.push(`${model}#${attempt + 1}${minimal ? " (minimal)" : ""} ${Date.now() - t0}ms: HTTP ${r.status} ${msg.slice(0, 80)}`);
      if (r.status === 400 && !minimal) { minimal = true; continue; }
      if (r.status === 404 || r.status === 429) break;   // unknown model / daily quota: next model
      if (!overloaded(r.status, msg)) break;
      await sleep(2000);
    }
  }
  throw new Error("Gemini unavailable —\n" + log.join("\n"));
}

// Which models can this key use? Lite first, stable before preview, newest first. Cached for an hour.
async function geminiModels(apiKey) {
  const { geminiModelsCache } = await chrome.storage.local.get("geminiModelsCache");
  if (geminiModelsCache?.v === 2 && Date.now() - geminiModelsCache.at < 3600e3) return geminiModelsCache.list;
  const fallback = ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-3.8-flash"];
  try {
    const r = await fetchWithTimeout("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": apiKey } }, 10_000);
    const j = await r.json();
    if (!r.ok) return fallback;
    const names = (j.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => m.name.replace(/^models\//, ""))
      .filter((n) => /-flash|-lite|-mini|-nano/i.test(n) && !/image|audio|tts|live|embedding|vision|thinking|exp/i.test(n));
    const ver = (n) => parseFloat((n.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
    const lite = (n) => (/-lite|-mini|-nano/i.test(n) ? 1 : 0);
    const stable = (n) => (/preview/i.test(n) ? 0 : 1);
    names.sort((a, b) => lite(b) - lite(a) || stable(b) - stable(a) || ver(b) - ver(a) || a.localeCompare(b));
    const list = [...new Set([...names.slice(0, 4), ...fallback])];
    await chrome.storage.local.set({ geminiModelsCache: { v: 2, at: Date.now(), list } });
    return list;
  } catch { return fallback; }
}

// Chrome's built-in Prompt API (Gemini Nano). Free, local, no key. Only present in browsers that ship it.
async function onDeviceStatus() {
  if (typeof LanguageModel === "undefined") return { state: "missing" };
  try { return { state: await LanguageModel.availability() }; }   // "available" | "downloadable" | "downloading" | "unavailable"
  catch (e) { return { state: "error", detail: errMsg(e) }; }
}

// Some browsers ship the LanguageModel API before the model behind it works (Dia, as of late 2026, echoes the
// prompt back inside a debug banner in ~2 ms). A real model takes real time and follows a trivial instruction.
async function onDeviceIsReal() {
  const { odProbe } = await chrome.storage.local.get("odProbe");
  if (odProbe && Date.now() - odProbe.at < 6 * 3600e3) return odProbe;
  const t = Date.now();
  let result;
  try {
    const session = await withTimeout(LanguageModel.create(), 20_000);
    try {
      const reply = String(await withTimeout(session.prompt("Reply with exactly the single word PINEAPPLE and nothing else."), 60_000));
      const ms = Date.now() - t;
      const echoed = /Reply with exactly/i.test(reply);
      result = { real: /pineapple/i.test(reply) && !echoed, reply: reply.slice(0, 120), ms, at: Date.now() };
    } finally { try { session.destroy(); } catch {} }
  } catch (e) { result = { real: false, error: errMsg(e), ms: Date.now() - t, at: Date.now() }; }
  await chrome.storage.local.set({ odProbe: result });
  return result;
}

async function askOnDevice(prompt) {
  const { state, detail } = await onDeviceStatus();
  if (state === "missing") throw new Error("This browser doesn't expose a built-in on-device model to extensions.");
  if (state === "unavailable") throw new Error("Built-in model is unavailable on this device.");
  if (state === "error") throw new Error("Built-in model check failed: " + detail);
  // "downloadable": create() starts the download (can be a couple of GB) — tell the person rather than silently waiting.
  if (state === "downloadable") {
    LanguageModel.create().catch(() => {});
    throw new Error("Built-in model is downloading (first time only, can take several minutes). Try again in a bit.");
  }
  if (state === "downloading") throw new Error("Built-in model is still downloading. Try again in a bit.");
  const probe = await onDeviceIsReal();
  if (!probe.real) throw new Error("This browser's built-in model API is present but not functional yet (it echoes prompts back instead of answering). Use Gemini's free tier for now.");
  // Use the model's own defaults; passing temperature/topK outside its range fails with a generic "request is invalid".
  let session;
  try {
    const p = await LanguageModel.params().catch(() => null);
    const opts = p ? { temperature: Math.max(p.minTemperature ?? 0, Math.min(0.2, p.maxTemperature ?? 1)), topK: Math.max(p.minTopK ?? 1, Math.min(3, p.maxTopK ?? 3)) } : {};
    session = await withTimeout(LanguageModel.create(opts), 20_000);
  } catch (e1) {
    try { session = await withTimeout(LanguageModel.create(), 20_000); }
    catch (e2) { throw new Error("Couldn't start built-in model: " + errMsg(e2)); }
  }
  try {
    // Prefer a schema-constrained answer (object of integer arrays); fall back to a plain prompt if the browser rejects it.
    const schema = { type: "object", additionalProperties: { type: "array", items: { type: "integer" } } };
    let text;
    try { text = await withTimeout(session.prompt(prompt, { responseConstraint: schema }), 60_000); }
    catch (e) {
      if (isTimeout(errMsg(e))) throw new Error("Built-in model took longer than 60s");
      text = await withTimeout(session.prompt(prompt), 60_000);
    }
    lastModel = "built-in on-device model";
    lastRaw = String(text);
    return text;
  } finally { try { session.destroy(); } catch {} }
}

async function askClaude(prompt, apiKey) {
  const r = await fetchWithTimeout("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || r.statusText);
  lastModel = "claude-haiku-5-5";
  return j.content?.[0]?.text || "";
}

async function askOpenAI(prompt, apiKey) {
  const r = await fetchWithTimeout("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0, messages: [{ role: "user", content: prompt }] }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error?.message || r.statusText);
  lastModel = "gpt-4o-mini";
  return j.choices?.[0]?.message?.content || "";
}

// =============================================================================================
// Diagnostics (settings page)
// =============================================================================================

// Sends three neutral sample tabs to the configured provider and reports what came back.
async function testAI() {
  const { provider = "domain", apiKey = "" } = await chrome.storage.sync.get(["provider", "apiKey"]);
  if (provider === "domain" || (provider !== "ondevice" && !apiKey)) return { ok: false, summary: "No AI key set. Pick a provider and paste a key above, then Save." };
  const sample = [
    { id: 1, title: "Flights to Tokyo - Google Flights", url: "https://www.google.com/travel/flights" },
    { id: 2, title: "Shinjuku hotels - Booking.com", url: "https://www.booking.com/city/jp/tokyo" },
    { id: 3, title: "useEffect - React", url: "https://react.dev/reference/react/useEffect" },
  ];
  const raw = {};
  if (provider === "ondevice") {
    await chrome.storage.local.remove("odProbe");   // a manual test should always re-probe
    raw.probe = await onDeviceIsReal();
    if (!raw.probe.real) return { ok: false, summary: "The built-in model API is here but isn't a working model yet — it echoed the prompt back in " + raw.probe.ms + " ms instead of answering. On-device will light up when this browser ships real inference; use Gemini's free tier until then.", raw };
  }
  const t0 = Date.now();
  try {
    const plan = await byAI(sample, [], provider, apiKey);
    const ms = Date.now() - t0;
    const names = { gemini: "Gemini", anthropic: "Claude", openai: "OpenAI", ondevice: "On-device" };
    const groups = Object.entries(plan).map(([k, v]) => `${k} (${v.length})`).join(", ");
    Object.assign(raw, { model: lastModel, ms, plan, rawReply: provider === "ondevice" ? lastRaw.slice(0, 400) : undefined });
    let summary = `${names[provider]} ${provider === "ondevice" ? "model" : "key"} works. ${lastModel} answered in ${(ms / 1000).toFixed(1)}s. Sample grouping: ${groups}.`;
    return { ok: true, summary, raw };
  } catch (e) {
    Object.assign(raw, { ms: Date.now() - t0, rawReply: provider === "ondevice" ? lastRaw.slice(0, 400) : undefined });
    return { ok: false, summary: `Key check failed: ${errMsg(e)}`, raw };
  }
}

// Makes one real group on a pair of loose tabs, then puts them back exactly where they were.
// Tries up to three pairs, because some browsers (Dia) refuse specific tabs without that meaning
// grouping is broken.
async function diag() {
  const raw = {};
  const win = await focusedWindow();
  const loose = await looseTabs(win.id);
  raw.looseTabs = loose.length;
  try { raw.groups = (await queryGroups(win.id)).length; } catch (e) { raw.groupQueryError = errMsg(e); }
  const prot = await protectedSet();
  raw.protected = prot.size;
  const everything = await chrome.tabs.query({ windowId: win.id });
  const now = Date.now();
  raw.tabs = everything.map((t) => ({
    i: t.index, id: t.id, pinned: t.pinned, group: t.groupId, prot: isProtected(t, prot),
    active: t.active, hl: t.highlighted, discarded: t.discarded, opener: t.openerTabId ?? null,
    agoMin: t.lastAccessed ? Math.round((now - t.lastAccessed) / 60000) : null,
    title: (t.title || "").slice(0, 30), url: (t.url || t.pendingUrl || "").slice(0, 40),
  }));
  raw.activeCount = everything.filter((t) => t.active).length;
  raw.highlightedCount = everything.filter((t) => t.highlighted).length;

  let canGroup = null, why = "";
  const refused = [];
  if (loose.length < 2) {
    why = "Need at least two loose tabs to test.";
  } else {
    const pairs = [];
    for (let i = loose.length - 1; i >= 1 && pairs.length < 3; i -= 2) pairs.push([loose[i], loose[i - 1]]);
    for (const pair of pairs) {
      const ids = pair.map((t) => t.id);
      try {
        await group({ tabIds: ids, createProperties: { windowId: win.id } });
        canGroup = true;
        try { await withTimeout(chrome.tabs.ungroup(ids)); } catch {}
        for (const t of pair) { try { await withTimeout(chrome.tabs.move(t.id, { index: t.index })); } catch {} }
        break;
      } catch (e) {
        why = errMsg(e);
        if (isTimeout(why)) { canGroup = false; break; }
        refused.push(...pair.map((t) => (t.title || t.url || "").slice(0, 40)));
      }
    }
    if (canGroup === null && refused.length) canGroup = false;
  }
  raw.canGroup = canGroup; raw.refused = refused; raw.detail = why;

  const lines = [];
  if (canGroup === true) {
    lines.push("✅ This browser makes tab groups. Tidy Tabs will work normally.");
    if (refused.length) lines.push(`⚠️ Some tabs are refused by the browser and will be skipped: ${[...new Set(refused)].join(", ")}.`);
  } else if (canGroup === false && isTimeout(why)) {
    lines.push("❌ This browser never answers tab-group requests (Arc is like this), so Tidy Tabs can't work here. It works in Dia, Chrome, Brave and Edge.");
  } else if (canGroup === false) {
    lines.push(`⚠️ Every tab I tried was refused by the browser (${[...new Set(refused)].join(", ")}). Grouping stays on; those tabs will be skipped. Reason given: ${why}`);
  } else {
    lines.push("⚠️ Couldn't test grouping: " + why);
  }
  const od = await onDeviceStatus();
  if (od.state === "available") { const p = await onDeviceIsReal(); od.real = p.real; od.probeMs = p.ms; }
  raw.onDevice = od;
  const odText = {
    available: od.real
      ? "✅ Built-in on-device model works here — pick \"On-device\" in Grouping and no key is needed."
      : "🟡 This browser has the built-in model API, but it isn't a working model yet (it echoes prompts back). Use Gemini's free tier until the browser ships real on-device inference.",
    downloadable: "🟡 This browser has a built-in model but it isn't downloaded yet. Pick \"On-device\", run Test AI once to start the download (a couple of GB), then use it key-free.",
    downloading: "🟡 Built-in model is downloading. Once it finishes, \"On-device\" works with no key.",
    unavailable: "➖ This browser has the built-in model API but no model is available on this device.",
    missing: "➖ No built-in on-device model is exposed to extensions here, so an API key is needed for topic grouping.",
    error: "➖ Built-in model check failed: " + (od.detail || ""),
  }[od.state];
  lines.push(odText);
  lines.push(`${loose.length} loose tab${loose.length === 1 ? "" : "s"}` + (raw.groups != null ? `, ${raw.groups} group${raw.groups === 1 ? "" : "s"}` : "") + (prot.size ? `, ${prot.size} protected.` : "."));
  return { ok: !(canGroup === false && isTimeout(why)), summary: lines.join("\n"), raw };
}

// =============================================================================================
// Helpers
// =============================================================================================

const errMsg = (e) => String(e?.message || e);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const focusedWindow = () => chrome.windows.getLastFocused({ windowTypes: ["normal"] });
const setBadge = async (text, color) => { await chrome.action.setBadgeText({ text }); await chrome.action.setBadgeBackgroundColor({ color }); };

// Only real web pages: browsers refuse to group chrome://, chrome-extension:// and similar internal tabs.
const isWebTab = (t) => !t.pinned && /^https?:\/\//.test(t.url || t.pendingUrl || "");

// "Never tidy this tab": remembered by origin + path (query and hash ignored), so the same page stays protected across reloads.
function protectKey(url) {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.origin + u.pathname.replace(/\/$/, "") : ""; } catch { return ""; }
}
async function protectedSet() {
  const { protectedUrls = [] } = await chrome.storage.sync.get("protectedUrls");
  return new Set(protectedUrls);
}
const isProtected = (t, set) => set.has(protectKey(t.url || t.pendingUrl || ""));

// Scope: which tabs in the window are "mine right now". Browsers with spaces/profiles in one window (Dia)
// don't tell extensions which space a tab belongs to, so "recently used" and "selected" are the proxies.
async function inScope(tabs) {
  const { scope = "window", scopeHours = 2 } = await chrome.storage.sync.get(["scope", "scopeHours"]);
  if (scope === "highlighted") {
    const hl = tabs.filter((t) => t.highlighted);
    return hl.length > 1 ? hl : tabs;               // a lone active tab isn't a selection; fall back to everything
  }
  if (scope === "recent") {
    const cutoff = Date.now() - Math.max(0.25, scopeHours) * 3600e3;
    return tabs.filter((t) => (t.lastAccessed || 0) >= cutoff);
  }
  return tabs;
}

async function looseTabs(windowId) {
  const tabs = await inScope(await chrome.tabs.query({ windowId }));
  const prot = await protectedSet();
  return tabs.filter((t) => isWebTab(t) && !isProtected(t, prot) && t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE);
}

// Some browsers never resolve tab-group calls; every call gets a deadline so nothing hangs.
const TIMEOUT_MSG = "browser didn't answer the tab-group request";
const isTimeout = (msg) => (msg || "").includes(TIMEOUT_MSG);
const withTimeout = (p, ms = 8000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(TIMEOUT_MSG)), ms))]);
const group = (opts) => withTimeout(chrome.tabs.group(opts));
const queryGroups = (windowId) => withTimeout(chrome.tabGroups.query({ windowId }), 5000).catch(() => []);
const updateGroup = (id, props) => withTimeout(chrome.tabGroups.update(id, props), 5000).catch(() => {});

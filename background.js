// Tidy Tabs — one-click AI tab grouping, in the spirit of Arc's Tidy Tabs.
// Works in any Chromium browser with native tab groups (Dia, Chrome, Brave, Edge).

const COLORS = ["blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange", "grey"];
const DEFAULT_TITLE = "Tidy tabs · right-click for Settings";

// =============================================================================================
// Entry points: icon click, keyboard shortcut, context menu, messages from the settings page
// =============================================================================================

chrome.action.onClicked.addListener(() => runWithFeedback(tidy));
chrome.commands.onCommand.addListener((cmd) => {
  if (cmd === "tidy") runWithFeedback(tidy);
  else if (cmd === "undo") runWithFeedback(undoTidy);
});

chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

chrome.runtime.onInstalled.addListener(async ({ reason, previousVersion }) => {
  if (reason === "install") {
    // "Current space" only matters in Dia; everywhere else a window is the unit. Scope is resolved per tidy
    // (see inScope), so this default is just what the Settings page shows.
    const { scope } = await chrome.storage.sync.get("scope");
    if (!scope) await chrome.storage.sync.set({ scope: "space", scopeHours: 2 });
    await installId();
    chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  } else if (reason === "update") {
    // Tell existing users what changed, but only for feature releases (1.8 -> 1.9), never for 1.9.0 -> 1.9.1.
    const minor = (v) => (v || "").split(".").slice(0, 2).join(".");
    const now = chrome.runtime.getManifest().version;
    if (previousVersion && minor(previousVersion) !== minor(now)) {
      chrome.tabs.create({ url: chrome.runtime.getURL(`whatsnew.html?from=${encodeURIComponent(previousVersion)}`), active: true });
    }
  }
  setUninstallUrl();
});
chrome.runtime.onMessage.addListener((msg) => { if (msg.type === "welcome") chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") }); });

// Dia keeps every space in one window and doesn't identify itself in the user agent. Its reliable tell is the
// chrome://assistant/<uuid> tab it keeps in each space. (An older check, "recent Chromium + LanguageModel API",
// started matching plain Chrome once Chrome passed version 150, which put Chrome users in space mode by mistake.)
let diaCache = { value: false, at: 0 };
async function isDia(windowId) {
  // Once Dia, always Dia. A "no" is rechecked at most once a minute (the assistant tab may not exist yet).
  if (diaCache.value || Date.now() - diaCache.at < 60_000) return diaCache.value;
  diaCache = { value: await detectDia(windowId), at: Date.now() };
  return diaCache.value;
}
async function detectDia(windowId) {
  if (/\bDia\b/i.test(navigator.userAgent)) return true;
  if ((navigator.userAgentData?.brands || []).some((b) => /\bDia\b/i.test(b.brand))) return true;
  try {
    const tabs = await chrome.tabs.query(windowId ? { windowId } : {});
    return tabs.some((t) => /^chrome:\/\/(assistant|start-page)\//.test(t.url || t.pendingUrl || ""));
  } catch { return false; }
}
chrome.storage.onChanged.addListener((c) => { if (c.autoTidy) buildMenus(); });

async function buildMenus() {
  const { autoTidy = false } = await chrome.storage.sync.get("autoTidy");
  await chrome.contextMenus.removeAll();
  const contexts = ["action", "page"];
  chrome.contextMenus.create({ id: "settings", title: "⚙️ Settings…", contexts });
  chrome.contextMenus.create({ id: "sep0", type: "separator", contexts });
  chrome.contextMenus.create({ id: "tidy", title: "🧹 Tidy tabs", contexts });
  chrome.contextMenus.create({ id: "undo", title: "Undo last tidy", contexts });
  chrome.contextMenus.create({ id: "ungroup", title: "Ungroup all", contexts });
  chrome.contextMenus.create({ id: "sep", type: "separator", contexts });
  chrome.contextMenus.create({ id: "protect", title: "Never tidy this tab", contexts: ["page"] });
  chrome.contextMenus.create({ id: "unprotect", title: "Allow tidying this tab again", contexts: ["page"] });
  chrome.contextMenus.create({ id: "sep2", type: "separator", contexts });
  chrome.contextMenus.create({ id: "auto", title: "Auto-tidy", type: "checkbox", checked: autoTidy, contexts });
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
  else if (info.menuItemId === "undo") runWithFeedback(undoTidy);
  else if (info.menuItemId === "ungroup") runWithFeedback(ungroup);
  else if (info.menuItemId === "auto") chrome.storage.sync.set({ autoTidy: !!info.checked });
  else if (info.menuItemId === "settings") chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const run = (fn) => fn().then(reply).catch((e) => reply({ error: errMsg(e) }));
  if (msg.type === "tidy") { run(() => runWithFeedback(() => tidy({ fromOptions: !!msg.fromOptions }))); return true; }
  if (msg.type === "applyPreview") { run(() => runWithFeedback(applyPreview)); return true; }
  if (msg.type === "cancelPreview") { run(async () => { await chrome.storage.local.remove("pendingPlan"); return { ok: true }; }); return true; }
  if (msg.type === "ungroup") { run(() => runWithFeedback(ungroup)); return true; }
  if (msg.type === "undo") { run(() => runWithFeedback(undoTidy)); return true; }
  if (msg.type === "saveSession") { run(() => saveSession(msg.name)); return true; }
  if (msg.type === "restoreSession") { run(() => runWithFeedback(() => restoreSession(msg.index))); return true; }
  if (msg.type === "rules") { run(async () => ({ rules: await loadRules() })); return true; }
  if (msg.type === "forgetRule") { run(async () => { await saveRules((await loadRules()).filter((_, i) => i !== msg.index)); return { ok: true }; }); return true; }
  if (msg.type === "forgetAll") { run(async () => { await chrome.storage.sync.set({ rules: [] }); return { ok: true }; }); return true; }
  if (msg.type === "diag") { run(diag); return true; }
  if (msg.type === "trial") { run(async () => ({ left: await trialLeft(), limit: TRIAL_LIMIT, configured: trialConfigured(), shareUrl: shareUrl() })); return true; }
  if (msg.type === "testai") { run(testAI); return true; }
});

// Runs an action with badge feedback ("…" → "✓" / "!") and records the outcome for the settings page.
async function runWithFeedback(fn) {
  await setBadge("…", "#2563eb");
  let result;
  try { result = await fn(); } catch (e) { result = { error: errMsg(e) }; }
  const ok = !result?.error;
  await chrome.storage.local.set({ lastResult: { at: Date.now(), ...result } });
  // A tidy that made nothing shows "0", not a tick, and the reason goes in the icon's hover text, so a
  // click that changes nothing (or fails) doesn't look like the extension is dead.
  const nothing = ok && result?.groups === 0 && !result.preview;
  await setBadge(ok ? (nothing ? "0" : "✓") : "!", ok ? (nothing ? "#6b7280" : "#16a34a") : "#dc2626");
  const why = ok ? (nothing ? result.note || "Nothing to group right now." : "") : result.error;
  try { await chrome.action.setTitle({ title: why ? `Tidy Tabs: ${why}`.slice(0, 280) : DEFAULT_TITLE }); } catch {}
  setTimeout(refreshBadge, 2500);
  return result;
}

// =============================================================================================
// Event log (diagnostic): records tab events so we can see what Dia emits when spaces change.
// Kept to the last 60 entries in local storage; shown under "Technical details".
// =============================================================================================

// In memory only: this used to cost two storage writes on every tab event, forever, for a debugging aid.
const evlog = [];
function logEvent(kind, detail) {
  evlog.push({ t: Date.now(), kind, ...detail });
  if (evlog.length > 60) evlog.shift();
}
chrome.tabs.onActivated.addListener(({ tabId }) => logEvent("activated", { id: tabId }));
chrome.tabs.onMoved.addListener((id, info) => logEvent("moved", { id, from: info.fromIndex, to: info.toIndex }));
chrome.tabs.onCreated.addListener((t) => logEvent("created", { id: t.id, index: t.index, url: (t.url || t.pendingUrl || "").slice(0, 40) }));
chrome.tabs.onRemoved.addListener((id) => logEvent("removed", { id }));
chrome.tabs.onHighlighted.addListener((info) => logEvent("highlighted", { ids: info.tabIds.slice(0, 10), n: info.tabIds.length }));
chrome.windows.onFocusChanged.addListener((w) => logEvent("winfocus", { w }));
chrome.tabs.onUpdated.addListener((id, info) => { if (info.discarded !== undefined || info.pinned !== undefined) logEvent("updated", { id, ...info }); });

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
    const { autoTidy = false, autoThreshold = 8, provider = "gemini", apiKey = "" } =
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

async function tidy(opts = {}) {
  if (isBusy()) return { error: "Already tidying, give it a moment" };
  busySince = Date.now();
  try {
    const r = await tidyInner(opts);
    // Preview mode: the plan is waiting on the settings page, so take the person there.
    if (r?.preview && !opts.fromOptions) chrome.runtime.openOptionsPage();
    return r;
  } finally { busySince = 0; refreshBadge(); }
}

// Apply a plan the person approved on the settings page.
async function applyPreview() {
  const { pendingPlan } = await chrome.storage.local.get("pendingPlan");
  if (!pendingPlan) return { error: "No preview waiting. Tidy again to make one." };
  await chrome.storage.local.remove("pendingPlan");
  return tidy({ plan: pendingPlan.plan, mode: pendingPlan.mode, fromOptions: true });
}

// Groups made in "by website" mode are not real topic groups. In AI mode they get re-sorted even when
// "Leave existing groups alone" is on, so the first real tidy after adding a key actually changes something.
async function domainGroupIds(windowId) {
  const { domainGroups = [] } = await chrome.storage.local.get("domainGroups");
  const live = new Set((await queryGroups(windowId)).map((g) => g.id));
  return new Set(domainGroups.filter((id) => live.has(id)));
}

// ---- Free trial ------------------------------------------------------------------------------
// A few tidies through the developer's server so the first click works with no setup. The Gemini key
// lives on that server, never in the extension. The server is the one counting; the local number is a cache.
const TRIAL_URL = "https://tidy-tabs.varun-puskur-dev.workers.dev";
const TRIAL_LIMIT = 10;
const trialConfigured = () => !TRIAL_URL.includes("REPLACE_ME");

async function installId() {
  const { installId: id } = await chrome.storage.local.get("installId");
  if (id) return id;
  const fresh = crypto.randomUUID();
  await chrome.storage.local.set({ installId: fresh });
  return fresh;
}
async function trialLeft() {
  if (!trialConfigured()) return 0;
  const { trialLeft: n = TRIAL_LIMIT } = await chrome.storage.local.get("trialLeft");
  return n;
}
async function pickMode(provider, apiKey) {
  if (provider === "domain" || provider === "ondevice") return provider;
  if (apiKey && ["gemini", "anthropic", "openai"].includes(provider)) return provider;
  return (await trialLeft()) > 0 ? "trial" : "needkey";
}
function needKey(opts = {}) {
  if (!opts.fromOptions) chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html#key") });
  return { error: `Your ${TRIAL_LIMIT} free tidies are used up. Add a free Gemini key to keep going; it takes about a minute.`, needKey: true };
}
async function askTrial(prompt) {
  const id = await installId();
  const r = await fetchWithTimeout(TRIAL_URL + "/tidy", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, prompt }),
  }, 25_000);   // the browser kills an extension's background worker if a request takes over 30s to answer
  let j = {}; try { j = await r.json(); } catch {}
  if (typeof j.remaining === "number") await chrome.storage.local.set({ trialLeft: j.remaining });
  if (r.ok && j.text) { lastModel = "free trial"; return j.text; }
  if (r.status === 402) { const e = new Error("Free tidies used up"); e.trialUsed = true; throw e; }
  throw new Error(j.message || `The free trial server didn't answer (HTTP ${r.status}). Try again, or add your own free key in Settings.`);
}

const STORE_URL = "https://chromewebstore.google.com/detail/cadaopjbichjjgljabfkokckndfgnpoa";
// Share links go through the trial server, which counts the click and forwards to the store.
const shareUrl = () => (trialConfigured() ? TRIAL_URL + "/get" : STORE_URL + "?utm_source=share&utm_medium=friend");

function setUninstallUrl() {
  if (!trialConfigured()) return;
  try { chrome.runtime.setUninstallURL(`${TRIAL_URL}/bye?v=${chrome.runtime.getManifest().version}`); } catch {}
}
setUninstallUrl();

async function tidyInner(opts = {}) {
  const win = await focusedWindow();
  const all = (await inScope(await chrome.tabs.query({ windowId: win.id }))).filter((t) => !t.pinned);
  const { provider = "gemini", apiKey = "", keepGroups = true, closeDupes = false, otherGroup = false, granularity = "balanced", previewFirst = false } =
    await chrome.storage.sync.get(["provider", "apiKey", "keepGroups", "closeDupes", "otherGroup", "granularity", "previewFirst"]);
  // Which engine this tidy uses. No key yet means the free trial; when that runs out we ask for a key
  // instead of quietly grouping by website (people took that for the AI and uninstalled).
  const mode = opts.mode || await pickMode(provider, apiKey);
  if (mode === "needkey") return needKey(opts);

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
  if (tabs.length < 2) {
    const { scope = "window" } = await chrome.storage.sync.get("scope");
    const hint = scope === "space" && tabs.length === 0
      ? " Nothing happened because I couldn't tell which space you're in. Click any tab in the space you want tidied, then tidy again."
      : tabs.length < 2 ? ` Only ${tabs.length} loose tab${tabs.length === 1 ? "" : "s"} in scope; grouping needs at least 2.` : "";
    return { groups: 0, tabs: tabs.length, dupes, skipped: [], mode, note: hint.trim() };
  }

  const allGroups = await queryGroups(win.id);
  const stale = mode === "domain" ? new Set() : await domainGroupIds(win.id);   // website groups to re-sort in AI mode
  const inScopeGroups = new Set(all.map((t) => t.groupId));
  const existing = allGroups.filter((g) => !stale.has(g.id) && inScopeGroups.has(g.id));
  const todo = keepGroups ? tabs.filter((t) => t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE || stale.has(t.groupId)) : tabs;
  if (todo.length === 0) {
    const { scope = "window" } = await chrome.storage.sync.get("scope");
    const note = tabs.length
      ? `All ${tabs.length} tab${tabs.length === 1 ? "" : "s"} in ${scope === "space" ? "this space" : "scope"} are already grouped. Turn off "Leave existing groups alone" to re-sort them.`
      : "";
    return { groups: 0, tabs: 0, dupes, skipped: [], mode, note };
  }

  // Remember which space this tidy is for (Dia can only group tabs in the space that's showing).
  // Dia only: in other browsers there are no spaces, and treating a click on another tab as "switched
  // spaces" made the tidy stall for 20 seconds and then give up.
  const spaceMode = ((await chrome.storage.sync.get("scope")).scope || "window") === "space" && (await isDia(win.id));
  const startRun = spaceMode ? await currentRunId(win.id) : null;

  // Very big windows: send the most recently used tabs only, so the request stays a sensible size.
  // The rest stay loose this time and get picked up by the next tidy.
  const sendable = todo.length > MAX_TABS_PER_TIDY
    ? [...todo].sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0)).slice(0, MAX_TABS_PER_TIDY)
    : todo;
  const plan = opts.plan
    ? opts.plan
    : mode === "domain"
      ? byDomain(todo)
      : await byAI(sendable, groupContext(existing, all), mode, apiKey, granularity).catch((e) => { if (e.trialUsed) return null; throw e; });
  if (!plan) return needKey(opts);

  // Preview: show the plan on the settings page and wait for "Apply" instead of grouping now.
  if (previewFirst && !opts.plan) {
    const titleOf = Object.fromEntries(todo.map((t) => [t.id, (t.title || t.url || "").slice(0, 60)]));
    const groups = Object.entries(plan)
      .filter(([title, ids]) => (otherGroup || !/^other$/i.test(title.trim())) && ids.length >= (/^other$/i.test(title.trim()) ? 1 : 2))
      .map(([title, ids]) => ({ title, tabs: ids.map((id) => titleOf[id]).filter(Boolean) }));
    await chrome.storage.local.set({ pendingPlan: { plan, mode, at: Date.now() } });
    return { preview: true, previewGroups: groups, groups: groups.length, tabs: todo.length, dupes, skipped: [], mode, scope: (await chrome.storage.sync.get("scope")).scope || "window" };
  }

  // If the person switched spaces while the model was thinking, wait (up to 20s) for them to come back;
  // grouping tabs in a hidden space is refused by Dia and leaves half-made groups behind.
  if (spaceMode && startRun !== null) {
    const ok = await waitForRun(win.id, startRun, 20_000);
    if (!ok) {
      await setBadge("↩", "#d97706"); setTimeout(refreshBadge, 4000);
      return { groups: 0, tabs: todo.length, dupes, skipped: [], note: "You switched spaces while I was sorting, so I stopped. Go back to that space and tidy again." };
    }
  }

  await snapshotForUndo(tabs, allGroups, dupes);   // only now: a tidy that failed above must not wipe the last undo
  const byId = Object.fromEntries(todo.map((t) => [t.id, t]));
  const refused = new Map();   // tabId -> error; a tab the browser refuses once is skipped for the rest of the run
  let made = 0, aborted = false;
  const madeIds = [];
  const taken = new Set(existing.map((g) => g.color));
  const palette = [...COLORS.filter((c) => !taken.has(c) && c !== "grey"), ...COLORS.filter((c) => taken.has(c) && c !== "grey"), "grey"];

  for (const [title, ids] of Object.entries(plan)) {
    const isOther = /^other$/i.test(title.trim());
    if (isOther && !otherGroup) continue;   // default: strays stay loose, like Arc did
    const valid = ids.filter((id) => byId[id] && !refused.has(id));
    if (valid.length === 0) continue;

    const match = existing.find((g) => (g.title || "").toLowerCase() === (isOther ? "other" : title.toLowerCase()));
    if (match) { await addToGroup(match.id, valid, refused); continue; }
    if (!isOther && valid.length < 2) continue;

    if (spaceMode && startRun !== null && (await currentRunId(win.id)) !== startRun) {
      if (!(await waitForRun(win.id, startRun, 15_000))) { aborted = true; break; }
    }
    const groupId = await makeGroup(valid, win.id, refused);
    if (groupId == null) continue;
    madeIds.push(groupId);
    if (isOther) await updateGroup(groupId, { title: "Other", color: "grey", collapsed: true });
    else { await updateGroup(groupId, { title, color: palette[made % palette.length], collapsed: false }); made++; }
  }

  // Keep track of which groups were made by website rather than by topic (see domainGroupIds).
  {
    const { domainGroups = [] } = await chrome.storage.local.get("domainGroups");
    const liveIds = new Set((await queryGroups(win.id)).map((g) => g.id));
    const kept = domainGroups.filter((id) => liveIds.has(id) && !stale.has(id));
    await chrome.storage.local.set({ domainGroups: mode === "domain" ? [...new Set([...kept, ...madeIds])] : kept });
  }

  const skipped = [...refused].map(([id, err]) => ({ title: (byId[id]?.title || String(id)).slice(0, 40), err }));
  if (skipped.length) console.warn("Tidy Tabs: browser refused to group", skipped);
  await rememberPlacements(win.id, todo);
  const { scope = "window" } = await chrome.storage.sync.get("scope");
  let warn = lastUpdateError ? `Couldn't set a group's name/color: ${lastUpdateError}` : "";
  if (aborted) warn = `Stopped partway because you switched spaces, so only ${made} group${made === 1 ? "" : "s"} made. Go back and tidy again to finish.`;
  if (!aborted && sendable.length < todo.length) warn = (warn ? warn + " " : "") + `Sorted your ${sendable.length} most recent tabs; tidy again for the other ${todo.length - sendable.length}.`;
  lastUpdateError = "";
  return { groups: made, tabs: todo.length, dupes, skipped, scope, mode, note: warn };
}

// =============================================================================================
// Sessions: a named snapshot of the in-scope tabs and their groups. Local only; export/import as JSON.
// =============================================================================================

async function saveSession(name) {
  const win = await focusedWindow();
  const all = await inScope(await chrome.tabs.query({ windowId: win.id }));
  const prot = await protectedSet();
  const tabs = all.filter((t) => isWebTab(t) && !isProtected(t, prot));
  const groups = await queryGroups(win.id);
  const byGroup = new Map();
  const loose = [];
  for (const t of tabs) {
    const rec = { url: t.url, title: (t.title || "").slice(0, 120) };
    if (t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE) loose.push(rec);
    else (byGroup.get(t.groupId) || byGroup.set(t.groupId, []).get(t.groupId)).push(rec);
  }
  const session = {
    name, at: Date.now(),
    groups: [...byGroup].map(([gid, tabs]) => { const g = groups.find((x) => x.id === gid); return { title: g?.title || "", color: g?.color || "grey", tabs }; }),
    loose,
  };
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  await chrome.storage.local.set({ sessions: [session, ...sessions].slice(0, 50) });
  return { saved: true, name, groups: session.groups.length, tabs: tabs.length };
}

async function restoreSession(index) {
  busySince = Date.now();
  try { return await restoreInner(index); } finally { busySince = 0; }
}
async function restoreInner(index) {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  const sess = sessions[index];
  if (!sess) return { error: "That session no longer exists" };
  const win = await focusedWindow();
  const open = await chrome.tabs.query({ windowId: win.id });
  const openByUrl = new Map(open.map((t) => [(t.url || "").replace(/#.*$/, ""), t]));
  let opened = 0, alreadyOpen = 0, groupsMade = 0;
  const ensure = async (rec) => {
    const key = (rec.url || "").replace(/#.*$/, "");
    const hit = openByUrl.get(key);
    if (hit) { alreadyOpen++; return hit.id; }
    const t = await chrome.tabs.create({ windowId: win.id, url: rec.url, active: false });
    openByUrl.set(key, t); opened++;
    return t.id;
  };
  for (const g of sess.groups) {
    const ids = [];
    for (const rec of g.tabs) { try { ids.push(await ensure(rec)); } catch {} }
    if (!ids.length) continue;
    await sleep(300);   // let the new tabs register before grouping
    try {
      const existing = (await queryGroups(win.id)).find((x) => (x.title || "").toLowerCase() === (g.title || "").toLowerCase());
      if (existing) await group({ tabIds: ids, groupId: existing.id });
      else { const gid = await group({ tabIds: ids, createProperties: { windowId: win.id } }); await updateGroup(gid, { title: g.title, color: g.color }); groupsMade++; }
    } catch {}
  }
  for (const rec of sess.loose) { try { await ensure(rec); } catch {} }
  return { restoredSession: true, name: sess.name, opened, alreadyOpen, groups: groupsMade };
}

// =============================================================================================
// Learning from corrections
// Stored as short plain-language rules (not examples) — cheaper in tokens and, per the BYOC paper,
// more accurate than replaying past cases. Each rule is one line in the prompt's Preferences block.
// Rules: { kind, site, group?, from?, to?, text, at, hits }
//   never   — "never group <site>"                           (tab pulled out of a group, twice → protect too)
//   prefer  — "<site> belongs in <group>"                    (tab moved into a different group)
//   rename  — "call the group about <oldName> '<newName>'"   (group renamed after tidy)
//   nogroup — "don't make a group called <name>"             (group dissolved soon after tidy)
// =============================================================================================

const MAX_RULES = 80;
const PLACEMENT_TTL = 2 * 3600e3;   // only treat moves within 2h of a tidy as corrections

async function rememberPlacements(windowId, tabs) {
  const now = Date.now();
  const live = await chrome.tabs.query({ windowId });
  const groups = await queryGroups(windowId);
  const gTitle = Object.fromEntries(groups.map((g) => [g.id, g.title || ""]));
  const placements = {};
  for (const t of live) {
    if (!tabs.some((x) => x.id === t.id)) continue;
    placements[t.id] = { site: siteOf(t.url), title: (t.title || "").slice(0, 60), groupId: t.groupId, groupTitle: gTitle[t.groupId] || "", at: now };
  }
  const groupNames = Object.fromEntries(groups.map((g) => [g.id, { title: g.title || "", at: now }]));
  await chrome.storage.local.set({ placements, groupNames });
}

function siteOf(url) {
  try { const u = new URL(url || ""); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, "") : ""; } catch { return ""; }
}

async function loadRules() { return (await chrome.storage.sync.get("rules")).rules || []; }
async function saveRules(rules) {
  rules.sort((a, b) => b.at - a.at);
  await chrome.storage.sync.set({ rules: rules.slice(0, MAX_RULES) });
}
async function addRule(rule) {
  const rules = await loadRules();
  const same = rules.find((r) => r.kind === rule.kind && r.site === rule.site && (r.group || "") === (rule.group || "") && (r.from || "") === (rule.from || ""));
  if (same) { same.hits = (same.hits || 1) + 1; same.at = Date.now(); same.text = rule.text; }
  else rules.push({ ...rule, at: Date.now(), hits: 1 });
  // a site pulled out of groups twice is clearly "leave me alone": protect it
  if (rule.kind === "never") {
    const r = rules.find((x) => x.kind === "never" && x.site === rule.site);
    if (r && r.hits >= 2) {
      const { protectedUrls = [] } = await chrome.storage.sync.get("protectedUrls");
      const key = "https://" + rule.site;
      if (!protectedUrls.includes(key)) await chrome.storage.sync.set({ protectedUrls: [...protectedUrls, key] });
    }
  }
  await saveRules(rules);
}

// A tab's group changed. Was it one we placed, and did a person move it?
chrome.tabs.onUpdated.addListener(async (tabId, info, tab) => {
  if (info.groupId === undefined || isBusy()) return;
  const { placements = {}, groupNames = {} } = await chrome.storage.local.get(["placements", "groupNames"]);
  const p = placements[tabId];
  if (!p || Date.now() - p.at > PLACEMENT_TTL || !p.site) return;
  if (info.groupId === p.groupId) return;
  if (p.groupId !== -1 && info.groupId === -1) {
    // pulled out of a group we made
    await addRule({ kind: "never", site: p.site, group: p.groupTitle, text: `Do not put ${p.site} in a group${p.groupTitle ? ` (it was removed from "${p.groupTitle}")` : ""}.` });
  } else if (info.groupId !== -1) {
    let to = "";
    try { to = (await withTimeout(chrome.tabGroups.get(info.groupId), 3000)).title || ""; } catch {}
    if (to && to.toLowerCase() !== p.groupTitle.toLowerCase()) {
      await addRule({ kind: "prefer", site: p.site, group: to, text: `${p.site} belongs in "${to}"${p.groupTitle ? ` rather than "${p.groupTitle}"` : ""}.` });
    }
  }
  placements[tabId] = { ...p, groupId: info.groupId };
  await chrome.storage.local.set({ placements });
});

// A group we made was renamed → prefer that name. Removed soon after → don't make it again.
chrome.tabGroups.onUpdated.addListener(async (g) => {
  if (isBusy()) return;
  const { groupNames = {} } = await chrome.storage.local.get("groupNames");
  const known = groupNames[g.id];
  if (!known || Date.now() - known.at > PLACEMENT_TTL) return;
  const was = known.title, now = g.title || "";
  if (now && was && now.toLowerCase() !== was.toLowerCase()) {
    await addRule({ kind: "rename", site: "", from: was, group: now, text: `Call the group you would name "${was}" "${now}" instead.` });
    groupNames[g.id] = { ...known, title: now };
    await chrome.storage.local.set({ groupNames });
  }
});
chrome.tabGroups.onRemoved.addListener(async (g) => {
  if (isBusy()) return;
  const { groupNames = {} } = await chrome.storage.local.get("groupNames");
  const known = groupNames[g.id];
  if (!known || !known.title || Date.now() - known.at > 15 * 60e3) return;   // only "dissolved right after tidy"
  await addRule({ kind: "nogroup", site: "", group: known.title, text: `Do not make a group called "${known.title}"; leave those tabs loose.` });
});

async function rulesBlock() {
  const rules = await loadRules();
  if (!rules.length) return "";
  return `\n\nPreferences this person has shown (follow them):\n` + rules.map((r) => `- ${r.text}`).join("\n");
}

// ---- Undo --------------------------------------------------------------------------------------
// Before a tidy touches anything, remember each in-scope tab's group (and each group's title/color).
// Undo puts every tab back: loose tabs become loose, grouped tabs rejoin a group with the same title.

async function snapshotForUndo(tabs, groups, dupesClosed = 0) {
  const snap = {
    at: Date.now(),
    dupesClosed,
    tabs: tabs.map((t) => ({ id: t.id, groupId: t.groupId, index: t.index })),
    groups: groups.map((g) => ({ id: g.id, title: g.title || "", color: g.color, collapsed: g.collapsed })),
  };
  await chrome.storage.local.set({ undoSnap: snap });
}

async function undoTidy() {
  busySince = Date.now();
  try { return await undoInner(); } finally { busySince = 0; await chrome.storage.local.remove(["placements", "groupNames"]); }
}
async function undoInner() {
  const { undoSnap } = await chrome.storage.local.get("undoSnap");
  if (!undoSnap) return { error: "Nothing to undo" };
  if (Date.now() - undoSnap.at > 6 * 3600e3) return { error: "Last tidy was over 6 hours ago; undo expired" };
  const win = await focusedWindow();
  const live = new Map((await chrome.tabs.query({ windowId: win.id })).map((t) => [t.id, t]));
  const nowGroups = await queryGroups(win.id);
  const byTitle = new Map(nowGroups.map((g) => [(g.title || "").toLowerCase(), g]));

  let restored = 0, failed = 0;
  // 1) tabs that were loose → ungroup
  const wasLoose = undoSnap.tabs.filter((t) => t.groupId === -1 && live.has(t.id) && live.get(t.id).groupId !== -1).map((t) => t.id);
  if (wasLoose.length) { try { await withTimeout(chrome.tabs.ungroup(wasLoose)); restored += wasLoose.length; } catch { failed += wasLoose.length; } }
  // 2) tabs that were in a group → back into a group with that title (reuse if it still exists, else recreate)
  const wasGrouped = undoSnap.tabs.filter((t) => t.groupId !== -1 && live.has(t.id));
  const byOldGroup = new Map();
  for (const t of wasGrouped) (byOldGroup.get(t.groupId) || byOldGroup.set(t.groupId, []).get(t.groupId)).push(t.id);
  for (const [oldId, ids] of byOldGroup) {
    const meta = undoSnap.groups.find((g) => g.id === oldId) || { title: "", color: "grey" };
    const stillThere = live.get(ids[0])?.groupId === oldId ? oldId : null;
    let target = stillThere ?? byTitle.get(meta.title.toLowerCase())?.id ?? null;
    const need = ids.filter((id) => live.get(id).groupId !== target);
    if (!need.length) { restored += ids.length; continue; }
    try {
      if (target == null) {
        target = await group({ tabIds: need, createProperties: { windowId: win.id } });
        await updateGroup(target, { title: meta.title, color: meta.color, collapsed: !!meta.collapsed });
      } else {
        await group({ tabIds: need, groupId: target });
      }
      restored += ids.length;
    } catch { failed += need.length; }
  }
  await chrome.storage.local.remove("undoSnap");
  return { undone: true, restored, failed, dupesClosed: undoSnap.dupesClosed || 0 };
}

async function ungroup() {
  busySince = Date.now();
  try { return await ungroupInner(); } finally { busySince = 0; await chrome.storage.local.remove(["placements", "groupNames"]); }
}
async function ungroupInner() {
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
    try {
      const parts = new URL(t.url).hostname.replace(/^www\./, "").split(".");
      const twoPartTld = parts.length > 2 && parts.at(-1).length === 2 && /^(co|com|org|net|ac|gov|edu)$/.test(parts.at(-2));
      host = parts.at(twoPartTld ? -3 : -2) || parts[0] || "Other";
    } catch {}
    const title = host.charAt(0).toUpperCase() + host.slice(1);
    (plan[title] ||= []).push(t.id);
  }
  return plan;
}

let lastModel = "";   // which model answered most recently; shown by "Test AI key"
let lastRaw = "";     // the model's raw reply, for diagnostics

const MAX_TABS_PER_TIDY = 150;

// Existing groups as the model sees them: name plus a few tab titles, so "LEGO" means something and a new
// LEGO tab joins it instead of starting "LEGO sets".
function groupContext(groups, tabs) {
  return groups.filter((g) => g.title).map((g) => ({
    title: g.title,
    samples: tabs.filter((t) => t.groupId === g.id).slice(0, 3).map((t) => cleanTitle(t.title).slice(0, 40)),
  }));
}

// Titles carry noise that costs tokens and misleads: "(3) Inbox", "● Untitled", runs of spaces.
function cleanTitle(title) {
  return (title || "").replace(/^\(\d+\+?\)\s*/, "").replace(/^[●•*]\s*/, "").replace(/\s+/g, " ").trim();
}
// URLs: host and path are what say what a page is. Scheme, "www.", query strings and fragments are mostly
// tracking ids, tokens and noise, and they can be long.
function compactUrl(url) {
  try {
    const u = new URL(url);
    return (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "")).slice(0, 70);
  } catch { return (url || "").slice(0, 70); }
}

async function byAI(tabs, existing, provider, apiKey, granularity = "balanced") {
  existing = existing.map((g) => (typeof g === "string" ? { title: g, samples: [] } : g));
  // Free trial goes to Gemini's free tier, whose terms say not to send personal info: drop email addresses
  // (Gmail puts yours in its tab title). compactUrl already removes query strings and fragments.
  const scrub = provider === "trial" ? (x) => x.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]") : (x) => x;

  // Number the tabs 1..N in tab-bar order. Models copy short numbers reliably; raw tab ids are ten digits
  // long and get shortened or mistyped, which loses tabs or fails the whole tidy (seen in the benchmark).
  const ordered = [...tabs].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const numOf = new Map(ordered.map((t, i) => [t.id, i + 1]));
  const idOf = new Map(ordered.map((t, i) => [i + 1, t.id]));
  const n = ordered.length;
  const list = ordered.map((t, i) => {
    const from = t.openerTabId && numOf.get(t.openerTabId);
    return `${i + 1}\t${scrub(cleanTitle(t.title).slice(0, 90))}\t${scrub(compactUrl(t.url))}${from ? `\tfrom ${from}` : ""}`;
  }).join("\n");

  // How finely to split. Deliberately no target number of groups: asking for "6-9 groups" made models cut one
  // task in two to hit the number, and capped big windows so most tabs fell into Other.
  const levels = {
    broad: "Prefer fewer, larger groups: closely related goals may share one group (all trip planning together, all coursework for a term together).",
    balanced: "Do not cut one goal into parts (\"Lisbon flights\" plus \"Lisbon sightseeing\" is wrong; \"Lisbon trip\" is right) unless it would have more than 12 tabs.",
    specific: "Split finely: inside a big goal, separate clear sub-tasks when each has at least 2 tabs (flights apart from hotels; one group per assignment).",
  };

  // The examples below are deliberately about things unlikely to be in anyone's tabs, and none of them
  // appear in test/bench-data.js, so the benchmark can't be passed by parroting the prompt.
  const prompt = `You are tidying a browser sidebar. Sort this person's open tabs into tab groups the way they would by hand.

Step 1. Read every tab and work out the distinct things this person is in the middle of: a course, a trip, a purchase they are comparing, a bug, a hobby, an event they are planning. Each of those is a group.
Step 2. Give every tab exactly one home: one of those groups, or "Other".

What makes a group
- One goal is one group, whatever sites it spans. Flights, hotels, a map, a Reddit thread and a YouTube video about the same trip all belong together.
- ${levels[granularity] || levels.balanced}
- Different goals stay apart even when they are the same kind of thing or on the same site. Two courses are two groups. A Google Doc for a history essay and a Google Doc for a moving checklist go to different groups. A chess opening video and a bread baking video on YouTube have nothing to do with each other.
- A group needs at least 2 tabs.

What goes in "Other"
- Everyday tools the person keeps open rather than works on: email inbox, calendar, chat and messaging, a drive or files home, music, bank and account dashboards, a site's home page or feed, an overview list of all issues or documents. Only put one in a group when its title clearly names that group's subject.
- One-off pages that relate to nothing else here. Never stretch a group to fit a stray, and never invent a group just to empty Other.
- AI chat tabs (ChatGPT, Claude, Gemini) go with the group their title is about, otherwise Other.

Names
- 1 to 3 words naming the specific thing: the course code, the place, the product, the project ("BIO 201", "Lisbon trip", "Standing desk", "Billing migration").
- Never a broad category such as Work, School, Research, Shopping, Entertainment, Videos, Reading, Social or Misc.
- Use the language the tabs are in.

Hints
- Tabs are listed in tab-bar order. Neighbours were often opened together, and "from N" means the tab was opened from tab N. Both are weak evidence; titles and addresses decide.
${existing.length ? `
These groups already exist. When a tab fits one, use its exact name (no near-duplicate like "Chess openings" next to "Chess"):
${existing.map((g) => `  "${scrub(g.title)}"${g.samples.length ? `: ${g.samples.map(scrub).join("; ")}` : ""}`).join("\n")}
` : ""}${await rulesBlock()}

Answer with JSON only, in this shape:
{"group name": [tab numbers], ..., "Other": [tab numbers]}  with every number from 1 to ${n} appearing exactly once

Example
1\tGolden retriever puppies near me - Petfinder\tpetfinder.com/search/dogs
2\tInbox - Gmail\tmail.google.com/mail
3\tPuppy first-week checklist - Google Docs\tdocs.google.com/document/d/1x\tfrom 1
4\tCouch to 5K: week 1 - YouTube\tyoutube.com/watch
5\tCrate training schedule : r/puppy101\treddit.com/r/puppy101/comments/1a
6\tBest running shoes for beginners - Runner's World\trunnersworld.com/gear
7\tHow do volcanoes form? - YouTube\tyoutube.com/watch
Answer: {"Puppy adoption":[1,3,5],"5K training":[4,6],"Other":[2,7]}

The tabs (number, title, address, opened from):
${list}`;

  const ask = () =>
    provider === "ondevice" ? askOnDevice(prompt)
    : provider === "trial" ? askTrial(prompt)
    : provider === "gemini" ? askGemini(prompt, apiKey)
    : provider === "anthropic" ? askClaude(prompt, apiKey)
    : askOpenAI(prompt, apiKey);

  const valid = new Set(idOf.keys());
  let lastErr;
  const attempts = provider === "trial" ? 1 : 2;       // one retry: local models occasionally mangle the JSON (not worth a trial tidy)
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const byNumber = parsePlan(await ask(), valid);
      return Object.fromEntries(Object.entries(byNumber).map(([name, nums]) => [name, nums.map((k) => idOf.get(k))]));
    } catch (e) { if (e.trialUsed) throw e; lastErr = e; }
  }
  throw lastErr;
}

// Turns the model's answer into { groupName: [tab numbers] }. Built to lose as few tabs as possible when the
// answer isn't quite what was asked for: three shapes are understood, a cut-off answer still yields the groups
// it finished, repeated or differently-cased names merge, and a tab listed twice goes to the first group.
function parsePlan(text, validIds) {
  // Everything from the first bracket on. The patterns below ignore trailing prose, and reading to the end
  // (not just to the last closing bracket) is what lets a cut-off answer keep its half-finished last group.
  const raw = (text || "").match(/[\[{][\s\S]*/);
  if (!raw) throw new Error("Model returned no JSON");
  let parsed = null;
  try { parsed = JSON.parse((raw[0].match(/^[\s\S]*[\]}]/) || raw)[0]); } catch {}
  const unesc = (s) => s.replace(/\\(.)/g, "$1");
  let pairs = [];   // [group name, [tab numbers]]

  // Shape A (what we ask for): {"name": [1, 2]}. Read from the text rather than JSON.parse, which keeps only
  // the last of a repeated key (leaving the other tabs loose) and rejects trailing commas and cut-off answers.
  pairs = [...raw[0].matchAll(/"((?:[^"\\\n]|\\.){1,80})"\s*:\s*\[([^\]]*)(\]|$)/g)].map((m) => {
    const nums = m[2].match(/\d+/g) || [];
    if (!m[3]) nums.pop();   // answer was cut off mid-list: the last number may be half-written
    return [unesc(m[1]), nums];
  });
  if (!pairs.length) pairs = [...raw[0].matchAll(/'([^'\n]{1,80})'\s*:\s*\[([^\]]*)\]/g)].map((m) => [m[1], m[2].match(/\d+/g) || []]);

  // Shape B: [{"name":"X","tabs":[1,2]}] or {"groups":[{...}]}. The regex above reads those as groups called
  // "tabs" or "ids", so check for this shape first when the JSON parsed.
  const listShape = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.groups) && typeof parsed.groups[0] === "object" ? parsed.groups : null;
  if (listShape) pairs = listShape.filter((g) => g && typeof g === "object").map((g) => [g.name ?? g.title ?? g.group ?? "", g.tabs ?? g.ids ?? g.tab_ids ?? g.tabIds ?? []]);

  // Shape C: one label per tab, {"tabs": {"1": "name", "2": "name"}}.
  const perTab = [...raw[0].matchAll(/"(\d+)"\s*:\s*"((?:[^"\\\n]|\\.){1,80})"/g)];
  if (perTab.length && !listShape) {
    const by = new Map();
    for (const m of perTab) { const name = unesc(m[2]); (by.get(name) || by.set(name, []).get(name)).push(Number(m[1])); }
    pairs = [...by];
  }
  if (!pairs.length && parsed && typeof parsed === "object") pairs = Object.entries(parsed);
  if (!pairs.length) throw new Error("Model returned invalid JSON");

  const clean = {};
  const keyOf = new Map();   // lowercase name -> the spelling we kept, so "Lego" and "LEGO" become one group
  const used = new Set();    // models sometimes list a tab under two groups; first one wins
  for (const [k, v] of pairs) {
    const name = groupName(k);
    if (!name) continue;
    const ids = [].concat(v).map(Number).filter((id) => validIds.has(id) && !used.has(id) && used.add(id));
    if (!ids.length) continue;
    const key = keyOf.get(name.toLowerCase()) || name;
    keyOf.set(name.toLowerCase(), key);
    (clean[key] ||= []).push(...ids);
  }
  if (!Object.keys(clean).length) throw new Error("Model returned a plan with no real tab ids");
  return clean;
}

// Tidy a model-made group name: trim quotes and stray punctuation, cap length, and fold the many ways
// models say "misc" into "Other" so strays follow the Other setting.
function groupName(k) {
  let n = String(k).replace(/^[\s"'`*_#-]+|[\s"'`*_:.,-]+$/g, "").replace(/\s+/g, " ");
  if (/^(tabs|ids|tab_ids|tabids|groups|name|title)$/i.test(n)) return "";   // field names from a half-parsed answer, not groups
  if (/^(other|others|misc|miscellaneous|uncategori[sz]ed|various|general|unsorted|ungrouped|random|none)$/i.test(n)) return "Other";
  if (n.length > 30) n = n.slice(0, 30).replace(/\s+\S*$/, "");
  return n;
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
        ? { temperature: 0, maxOutputTokens: 4096 }
        : { temperature: 0, responseMimeType: "application/json", maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } };
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
  throw new Error("Gemini unavailable:\n" + log.join("\n"));
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
  try { return { state: await LanguageModel.availability({ expectedOutputs: [{ type: "text", languages: ["en"] }] }) }; }   // "available" | "downloadable" | "downloading" | "unavailable"
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
    const session = await withTimeout(LanguageModel.create({ expectedOutputs: [{ type: "text", languages: ["en"] }] }), 20_000);
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
    const opts = p ? { expectedOutputs: [{ type: "text", languages: ["en"] }], temperature: Math.max(p.minTemperature ?? 0, Math.min(0.2, p.maxTemperature ?? 1)), topK: Math.max(p.minTopK ?? 1, Math.min(3, p.maxTopK ?? 3)) } : {};
    session = await withTimeout(LanguageModel.create(opts), 20_000);
  } catch (e1) {
    try { session = await withTimeout(LanguageModel.create({ expectedOutputs: [{ type: "text", languages: ["en"] }] }), 20_000); }
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
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 4096, messages: [{ role: "user", content: prompt }] }),
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
  const { provider = "gemini", apiKey = "" } = await chrome.storage.sync.get(["provider", "apiKey"]);
  if (provider === "domain" || (provider !== "ondevice" && !apiKey)) return { ok: false, summary: "No AI key set. Pick a provider and paste a key above." };
  const sample = [
    { id: 1, title: "Flights to Tokyo - Google Flights", url: "https://www.google.com/travel/flights" },
    { id: 2, title: "Shinjuku hotels - Booking.com", url: "https://www.booking.com/city/jp/tokyo" },
    { id: 3, title: "useEffect - React", url: "https://react.dev/reference/react/useEffect" },
  ];
  const raw = {};
  if (provider === "ondevice") {
    await chrome.storage.local.remove("odProbe");   // a manual test should always re-probe
    raw.probe = await onDeviceIsReal();
    if (!raw.probe.real) return { ok: false, summary: "The built-in model API is here but isn't a working model yet: it echoed the prompt back in " + raw.probe.ms + " ms instead of answering. On-device will light up when this browser ships real inference; use Gemini's free tier until then.", raw };
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
  const t0 = Date.now();
  raw.recentEvents = evlog.map((e) => ({ agoSec: Math.round((t0 - e.t) / 1000), ...e, t: undefined }));

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
      ? "✅ Built-in on-device model works here. Pick \"On-device\" in Grouping and no key is needed."
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
// A page is protected by its exact key, or by its whole site (what "pulled out of a group twice" adds).
function isProtected(t, set) {
  const url = t.url || t.pendingUrl || "";
  if (set.has(protectKey(url))) return true;
  try { return set.has("https://" + new URL(url).hostname.replace(/^www\./, "")); } catch { return false; }
}

// Scope: which tabs in the window are "mine right now". Browsers with spaces/profiles in one window (Dia)
// don't tell extensions which space a tab belongs to, so "recently used" and "selected" are the proxies.
async function inScope(tabs) {
  const { scope = "window", scopeHours = 2 } = await chrome.storage.sync.get(["scope", "scopeHours"]);
  if (scope === "space") return (await isDia(tabs[0]?.windowId)) ? currentSpaceTabs(tabs) : tabs;
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

// ---- Current space (Dia) ---------------------------------------------------------------------
// Dia shows one space at a time but reports every space's tabs as one window, with no space field.
// What it does give us: a tab can only become active while its space is showing, and lastAccessed
// updates when that happens. So we watch activations; a jump to a tab that hadn't been touched in a
// while means a space switch. "Current space" = tabs used since the most recent such switch.
// Dia also drops a chrome://assistant/<uuid> tab in each space; when one of those gets activated it's
// a reliable space-boundary marker too.

const SPACE_GAP_MS = 20_000;           // backup signal: an activated tab idle longer than this means we came from elsewhere
let spaceEnteredAt = 0;                // when we last believe the current space was entered
let lastActiveId = 0;                  // the tab that was active before this activation
const ID_GAP = 12;                     // tab ids within this of each other were created in the same burst (= same space)

// Split web tabs into contiguous id runs; returns a Map tabId -> runIndex.
// Runs are then merged when a tab was opened from, or while looking at, a tab in another run: a tab you
// open in a space belongs to that space even though its id is far from the space's older tabs.
function idRuns(tabs, links = {}) {
  const sorted = tabs.filter(isWebTab).sort((a, b) => a.id - b.id);
  const runOf = new Map();
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i].id - sorted[i - 1].id > ID_GAP) run++;
    runOf.set(sorted[i].id, run);
  }
  // Union-find over runs.
  const parent = [...Array(run + 1).keys()];
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const join = (a, b) => { const ra = runOf.get(a), rb = runOf.get(b); if (ra !== undefined && rb !== undefined) parent[find(ra)] = find(rb); };
  for (const t of sorted) if (t.openerTabId) join(t.id, t.openerTabId);
  for (const [a, b] of Object.entries(links)) join(Number(a), b);
  for (const [id, r] of runOf) runOf.set(id, find(r));
  return runOf;
}

chrome.runtime.onStartup.addListener(() => chrome.storage.session.set({ browserStart: Date.now() }).catch(() => {}));
let spaceLinks = null;   // tabId -> the tab that was active when it was created
async function getLinks() {
  if (!spaceLinks) { try { spaceLinks = (await chrome.storage.local.get("spaceLinks")).spaceLinks || {}; } catch { spaceLinks = {}; } }
  return spaceLinks;
}
chrome.tabs.onCreated.addListener(async (t) => {
  if (!(await isDia(t.windowId))) return;
  // Only a tab opened in the foreground (Cmd+T, a link opened normally). Background tabs carry openerTabId,
  // which idRuns uses directly, and session restore creates a burst of background tabs that must not be
  // tied to whatever tab happened to be active.
  if (!t.active) return;
  try { const { browserStart = 0 } = await chrome.storage.session.get("browserStart"); if (Date.now() - browserStart < 15_000) return; } catch {}
  if (!lastActiveId) { try { lastActiveId = (await chrome.storage.local.get("lastActiveId")).lastActiveId || 0; } catch {} }
  const to = t.openerTabId || lastActiveId;
  if (!to || to === t.id) return;
  const l = await getLinks();
  l[t.id] = to;
  const keys = Object.keys(l);
  if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete l[k];
  try { await chrome.storage.local.set({ spaceLinks: l }); } catch {}
});

chrome.tabs.onActivated.addListener(async ({ tabId, windowId }) => {
  if (!(await isDia(windowId))) return;   // spaces only exist in Dia; don't pay for this elsewhere
  const now = Date.now();
  let t = null; try { t = await chrome.tabs.get(tabId); } catch { return; }
  const url = t.url || t.pendingUrl || "";
  const isAssistant = /^chrome:\/\/(assistant|start-page)\//.test(url);
  const isOurs = url.startsWith(chrome.runtime.getURL(""));   // our own settings/welcome pages aren't a space signal
  let switched = false;
  if (isAssistant) switched = true;
  else if (!isOurs && isWebTab(t) && lastActiveId) {
    // Primary signal: did we land in a different id run than the tab we came from?
    const all = await chrome.tabs.query({ windowId });
    const runOf = idRuns(all, await getLinks());
    const from = runOf.get(lastActiveId), to = runOf.get(tabId);
    if (from !== undefined && to !== undefined && from !== to) switched = true;
    // Backup: a tab idle for a while, when nothing else nearby was touched, means we came from elsewhere.
    if (!switched && now - (t.lastAccessed || 0) > SPACE_GAP_MS) switched = true;
  }
  if (switched || !spaceEnteredAt) spaceEnteredAt = now;
  if (!isOurs && isWebTab(t)) lastActiveId = tabId;
  try { await chrome.storage.local.set({ spaceEnteredAt, lastActiveId }); } catch {}
});

// Which id-run (≈ Dia space) is showing right now, judged by the active real tab.
async function currentRunId(windowId) {
  try {
    const all = await chrome.tabs.query({ windowId });
    const active = all.find((t) => t.active);
    const runOf = idRuns(all, await getLinks());
    if (!active || !isWebTab(active) || (active.url || "").startsWith(chrome.runtime.getURL(""))) {
      const r = runOf.get(lastActiveId); return r === undefined ? null : r;
    }
    const r = runOf.get(active.id); return r === undefined ? null : r;
  } catch { return null; }
}
async function waitForRun(windowId, run, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if ((await currentRunId(windowId)) === run) return true;
    await sleep(500);
  }
  return false;
}

// On a cold start we have no activation history; take the active real tab as the anchor so a tidy
// right after install/reload still scopes to the space you're looking at.
async function seedAnchor() {
  try {
    const st = await chrome.storage.local.get(["spaceEnteredAt", "lastActiveId"]);
    if (!spaceEnteredAt) spaceEnteredAt = st.spaceEnteredAt || 0;
    if (!lastActiveId) lastActiveId = st.lastActiveId || 0;
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && isWebTab(active) && !(active.url || "").startsWith(chrome.runtime.getURL(""))) {
      if (!lastActiveId) lastActiveId = active.id;
      if (!spaceEnteredAt) spaceEnteredAt = Date.now();
    }
  } catch {}
}
seedAnchor();
chrome.runtime.onStartup.addListener(seedAnchor);
chrome.runtime.onInstalled.addListener(seedAnchor);

async function currentSpaceTabs(tabs) {
  await seedAnchor();
  const web = tabs.filter(isWebTab);
  if (web.length === 0) return tabs;
  const runOf = idRuns(tabs, await getLinks());

  // Anchor: the last real tab we were on (not our own pages). Its id run is the current space.
  let anchorRun = runOf.get(lastActiveId);
  if (anchorRun === undefined) {
    const active = web.find((t) => t.active);
    anchorRun = active ? runOf.get(active.id) : undefined;
  }
  if (anchorRun === undefined) {
    // Genuinely no idea where we are. Do nothing rather than touch other spaces.
    return tabs.filter((t) => !isWebTab(t));
  }
  return tabs.filter((t) => !isWebTab(t) || runOf.get(t.id) === anchorRun);
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
let lastUpdateError = "";
async function updateGroup(id, props) {
  try { await withTimeout(chrome.tabGroups.update(id, props), 5000); }
  catch (e) { lastUpdateError = errMsg(e); return; }
  // Some browsers apply the title but drop the color on a fresh group; re-assert it after a beat.
  if (props.color) {
    setTimeout(async () => {
      try {
        const g = await withTimeout(chrome.tabGroups.get(id), 3000);
        if (g && g.color !== props.color) await withTimeout(chrome.tabGroups.update(id, { color: props.color }), 3000);
      } catch {}
    }, 400);
  }
}

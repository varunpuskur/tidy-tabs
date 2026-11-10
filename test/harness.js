// Loads background.js in a fake browser so the tidy flow can be tested in node. No dependencies.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

function makeBrowser({ dia = false, ua = "Mozilla/5.0 Chrome/154.0.0.0 Safari/537.36", fetchImpl, transformSource, realTimers = false, AbortControllerImpl = AbortController } = {}) {
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => (listeners[name] ||= []).push(fn) });
  const fire = async (name, ...args) => { for (const fn of listeners[name] || []) await fn(...args); };
  const area = () => {
    const data = {};
    return {
      data,
      get: async (keys) => {
        if (keys == null) return { ...data };
        const list = typeof keys === "string" ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
        const out = {};
        for (const k of list) if (k in data) out[k] = structuredClone(data[k]);
        return out;
      },
      set: async (obj) => { for (const [k, v] of Object.entries(obj)) data[k] = structuredClone(v); },
      remove: async (keys) => { for (const k of [].concat(keys)) delete data[k]; },
    };
  };
  const state = { tabs: [], groups: new Map(), nextGroup: 1000, created: [], uninstallUrl: "", badge: "" };
  const tabCopy = (t) => ({ ...t });
  const chrome = {
    storage: { sync: area(), local: area(), session: area(), onChanged: on("storage.onChanged") },
    tabs: {
      query: async (q = {}) => {
        let ts = state.tabs;
        if (q.windowId) ts = ts.filter((t) => t.windowId === q.windowId);
        if (q.active) ts = ts.filter((t) => t.active);
        return ts.sort((a, b) => a.index - b.index).map(tabCopy);
      },
      get: async (id) => { const t = state.tabs.find((x) => x.id === id); if (!t) throw new Error("No tab with id: " + id); return tabCopy(t); },
      group: async ({ tabIds, groupId, createProperties }) => {
        const ids = [].concat(tabIds);
        for (const id of ids) {
          const t = state.tabs.find((x) => x.id === id);
          if (!t) throw new Error("No tab with id: " + id);
          if (t.refuse) throw new Error("Tab not found for session ID");
        }
        let gid = groupId;
        if (gid == null) { gid = state.nextGroup++; state.groups.set(gid, { id: gid, windowId: createProperties?.windowId || 1, title: "", color: "grey", collapsed: false }); }
        for (const id of ids) state.tabs.find((x) => x.id === id).groupId = gid;
        prune();   // the browser deletes groups that end up empty
        return gid;
      },
      ungroup: async (ids) => { for (const id of [].concat(ids)) { const t = state.tabs.find((x) => x.id === id); if (t) t.groupId = -1; } prune(); },
      remove: async (id) => { state.tabs = state.tabs.filter((t) => t.id !== id); prune(); },
      move: async () => {},
      create: async (p) => { state.created.push(p.url); return { id: 99999 }; },
      onActivated: on("tabs.onActivated"), onCreated: on("tabs.onCreated"), onRemoved: on("tabs.onRemoved"),
      onUpdated: on("tabs.onUpdated"), onMoved: on("tabs.onMoved"), onHighlighted: on("tabs.onHighlighted"),
    },
    tabGroups: {
      TAB_GROUP_ID_NONE: -1,
      query: async ({ windowId }) => [...state.groups.values()].filter((g) => g.windowId === windowId).map((g) => ({ ...g })),
      get: async (id) => ({ ...state.groups.get(id) }),
      update: async (id, props) => { Object.assign(state.groups.get(id), props); },
      onUpdated: on("tabGroups.onUpdated"), onRemoved: on("tabGroups.onRemoved"),
    },
    windows: { getLastFocused: async () => ({ id: 1 }), onFocusChanged: on("windows.onFocusChanged") },
    action: { setBadgeText: async ({ text }) => { state.badge = text; }, setBadgeBackgroundColor: async () => {}, setTitle: async ({ title }) => { state.title = title; }, onClicked: on("action.onClicked") },
    contextMenus: { create: () => {}, removeAll: async () => {}, onClicked: on("contextMenus.onClicked") },
    commands: { onCommand: on("commands.onCommand") },
    runtime: {
      onInstalled: on("runtime.onInstalled"), onStartup: on("runtime.onStartup"), onMessage: on("runtime.onMessage"),
      getURL: (p) => "chrome-extension://abc/" + p,
      getManifest: () => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8")),
      setUninstallURL: (u) => { state.uninstallUrl = u; },
      openOptionsPage: () => state.created.push("options"),
    },
  };
  function prune() { for (const [id] of state.groups) if (!state.tabs.some((t) => t.groupId === id)) state.groups.delete(id); }

  let src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
  src = src.replace(/^const TRIAL_URL = ".*";/m, 'const TRIAL_URL = "https://tidy-tabs.test.workers.dev";');   // whatever URL is configured
  if (transformSource) src = transformSource(src);
  src += "\n;globalThis.__t = { diag, runWithFeedback, cleanTitle, compactUrl, groupName, tidy, applyPreview, undoTidy, parsePlan, byDomain, idRuns, inScope, isDia, currentSpaceTabs, pickMode, trialLeft, installId, shareUrl, scheduleAuto, setLastActive: (id) => { lastActiveId = id; } };";
  const timers = [];
  const ctx = {
    chrome, console: { log() {}, warn() {}, error: console.error },
    navigator: { userAgent: ua, userAgentData: { brands: [] } },
    fetch: (...a) => fetchImpl(...a), AbortController: AbortControllerImpl, URL, Response, structuredClone,
    crypto: require("crypto").webcrypto,
    setTimeout: (fn, ms) => { const h = setTimeout(fn, realTimers ? ms : Math.min(ms, 5)); timers.push(h); return h; },
    clearTimeout, Promise, Date, JSON, Math, Map, Set, Object, Array, Number, String, Error,
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx, { filename: "background.js" });
  return { chrome, state, fire, t: ctx.__t, ctx };
}

// Tab factory. ids matter: Dia space detection uses id runs.
let idx = 0;
function tab(id, url, title, extra = {}) {
  return { id, windowId: 1, index: idx++, url, title, pinned: false, groupId: -1, active: false, highlighted: false, lastAccessed: Date.now() - 3600e3, ...extra };
}
module.exports = { makeBrowser, tab };

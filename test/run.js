// node test/run.js
const assert = require("assert/strict");
const { makeBrowser, tab } = require("./harness");

// A stand-in model: groups tabs by the first word of the title ("LEGO ...", "Japan ...").
function fakeModel(prompt) {
  const rows = prompt.split("id\ttitle\turl\n")[1].trim().split("\n").map((l) => l.split("\t"));
  const plan = {};
  for (const [id, title] of rows) (plan[title.split(" ")[0]] ||= []).push(Number(id));
  return JSON.stringify(plan);
}
function server({ trialStatus = 200, remaining = 4 } = {}) {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body) : null });
    if (url.endsWith("/tidy")) {
      if (trialStatus === 402) return new Response(JSON.stringify({ error: "trial_used", remaining: 0 }), { status: 402 });
      if (trialStatus !== 200) return new Response(JSON.stringify({ error: "busy", message: "busy" }), { status: trialStatus });
      return new Response(JSON.stringify({ text: fakeModel(calls.at(-1).body.prompt), remaining }), { status: 200 });
    }
    if (url.includes("generativelanguage") && url.includes("/models?")) return new Response(JSON.stringify({ models: [] }), { status: 200 });
    if (url.includes("generativelanguage")) {
      const prompt = JSON.parse(opts.body).contents[0].parts[0].text;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: fakeModel(prompt) }] } }] }), { status: 200 });
    }
    throw new Error("unexpected fetch " + url);
  };
  return { impl, calls };
}
const chromeTabs = () => [
  tab(3, "https://lego.com/a", "LEGO Speed Champions"),
  tab(41, "https://amazon.com/lego", "LEGO light kit"),
  tab(77, "https://google.com/travel/flights", "Japan flights"),
  tab(150, "https://booking.com/tokyo", "Japan hotels Shinjuku"),
  tab(260, "https://leetcode.com/1", "LeetCode Two Sum"),
  tab(390, "https://leetcode.com/2", "LeetCode Valid Parens"),
  tab(905, "https://chromewebstore.google.com/detail/x", "Tidy Tabs - Chrome Web Store", { active: true, lastAccessed: Date.now() }),
];
const titles = (state) => [...state.groups.values()].map((g) => g.title).sort();

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test("Chrome 154 with LanguageModel is NOT treated as Dia; first tidy covers the whole window", async () => {
  const s = server();
  const b = makeBrowser({ fetchImpl: s.impl });
  b.ctx.LanguageModel = {};   // Chrome ships the Prompt API now; this used to trip the Dia check
  b.state.tabs = chromeTabs();
  await b.chrome.storage.sync.set({ scope: "space" });   // what 1.8 wrote for Chrome users by mistake
  assert.equal(await b.t.isDia(1), false);
  const r = await b.t.tidy();
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.mode, "trial");
  assert.deepEqual(titles(b.state), ["Japan", "LEGO", "LeetCode"]);
  assert.equal(r.groups, 3);
  assert.equal(s.calls.filter((c) => c.url.endsWith("/tidy")).length, 1);
});

test("trial request carries an install id and our prompt prefix, and never a key", async () => {
  const s = server();
  const b = makeBrowser({ fetchImpl: s.impl });
  b.state.tabs = chromeTabs();
  await b.t.tidy();
  const body = s.calls.find((c) => c.url.endsWith("/tidy")).body;
  assert.match(body.id, /^[0-9a-f-]{36}$/);
  assert.ok(body.prompt.startsWith("You are tidying a browser sidebar."));
  assert.deepEqual(Object.keys(body).sort(), ["id", "prompt"]);
  assert.equal((await b.chrome.storage.local.get("trialLeft")).trialLeft, 4);
});

test("trial prompts drop email addresses and URL query strings", async () => {
  const s = server();
  const b = makeBrowser({ fetchImpl: s.impl });
  b.state.tabs = [...chromeTabs(), tab(800, "https://mail.google.com/mail/u/0/?authuser=varun@x.com#inbox", "Inbox (3) - varun.puskur.dev@gmail.com - Gmail")];
  await b.t.tidy();
  const prompt = s.calls.find((c) => c.url.endsWith("/tidy")).body.prompt;
  assert.ok(!/@/.test(prompt.split("id\ttitle\turl")[1]), "email leaked");
  assert.ok(prompt.includes("Inbox (3) - [email] - Gmail"));
  assert.ok(!prompt.includes("authuser"));
});

test("trial used up: no groups, no website fallback, key page opens", async () => {
  const b = makeBrowser({ fetchImpl: server({ trialStatus: 402 }).impl });
  b.state.tabs = chromeTabs();
  const r = await b.t.tidy();
  assert.ok(r.needKey);
  assert.equal(b.state.groups.size, 0);
  assert.ok(b.state.created.some((u) => u.endsWith("welcome.html#key")));
  // and the next click doesn't even call the server
  const s2 = server(); b.ctx.fetch = s2.impl;
  const r2 = await b.t.tidy();
  assert.ok(r2.needKey);
});

test("trial server busy: clear error, nothing grouped, trial not marked used", async () => {
  const b = makeBrowser({ fetchImpl: server({ trialStatus: 502 }).impl });
  b.state.tabs = chromeTabs();
  const r = await b.t.tidy().catch((e) => ({ error: e.message }));
  assert.match(r.error, /busy/);
  assert.equal(b.state.groups.size, 0);
  assert.equal(await b.t.trialLeft(), 5);
});

test("own Gemini key bypasses the trial", async () => {
  const s = server();
  const b = makeBrowser({ fetchImpl: s.impl });
  b.state.tabs = chromeTabs();
  await b.chrome.storage.sync.set({ provider: "gemini", apiKey: "AIzaTEST" });
  const r = await b.t.tidy();
  assert.equal(r.mode, "gemini");
  assert.equal(s.calls.filter((c) => c.url.endsWith("/tidy")).length, 0);
  assert.equal(r.groups, 3);
});

test("Dia: tidies only the current space", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  b.state.tabs = [
    tab(10, "https://lego.com/a", "LEGO set"), tab(11, "https://lego.com/b", "LEGO kit"), tab(12, "https://x.com/japan", "Japan rail", { active: true }), tab(13, "https://y.com/japan", "Japan food"),
    tab(14, "chrome://assistant/aaa", "Assistant"),
    tab(100, "https://leetcode.com/1", "LeetCode one"), tab(101, "https://leetcode.com/2", "LeetCode two"), tab(102, "chrome://assistant/bbb", "Assistant"),
  ];
  await b.chrome.storage.sync.set({ scope: "space" });
  assert.equal(await b.t.isDia(1), true);
  b.t.setLastActive(12);
  const r = await b.t.tidy();
  assert.deepEqual(titles(b.state), ["Japan", "LEGO"]);
  assert.equal(b.state.tabs.find((t) => t.id === 100).groupId, -1);
});

test("Dia: a tab opened with Cmd+T joins the current space", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  b.state.tabs = [
    tab(10, "https://lego.com/a", "LEGO set"), tab(11, "https://x.com/japan", "Japan rail", { active: true }), tab(12, "chrome://assistant/a", "A"),
    tab(100, "https://leetcode.com/1", "LeetCode one"), tab(101, "https://leetcode.com/2", "LeetCode two"), tab(102, "chrome://assistant/b", "B"),
  ];
  await b.chrome.storage.sync.set({ scope: "space" });
  b.t.setLastActive(11);
  await b.chrome.storage.local.set({ lastActiveId: 11 });
  const fresh = tab(600, "https://lego.com/c", "LEGO lights", { active: true });
  b.state.tabs.find((t) => t.id === 11).active = false;
  b.state.tabs.push(fresh);
  await b.fire("tabs.onCreated", { ...fresh });
  const inScope = await b.t.inScope(await b.chrome.tabs.query({ windowId: 1 }));
  const ids = inScope.filter((t) => t.url.startsWith("http")).map((t) => t.id).sort((a, b) => a - b);
  assert.deepEqual(ids, [10, 11, 600]);
});

test("Dia: background tabs during session restore are not linked to the active tab", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  b.state.tabs = [tab(10, "https://a.com", "A one", { active: true }), tab(11, "https://a.com/2", "A two"), tab(12, "chrome://assistant/a", "A")];
  await b.chrome.storage.local.set({ lastActiveId: 10 });
  await b.chrome.storage.session.set({ browserStart: Date.now() });
  await b.fire("tabs.onCreated", { ...tab(700, "https://b.com", "B", { active: true }) });
  await b.fire("tabs.onCreated", { ...tab(701, "https://b.com/2", "B2", { active: false }) });
  assert.deepEqual((await b.chrome.storage.local.get("spaceLinks")).spaceLinks || {}, {});
});

test("Dia: a tab opened from a link (openerTabId) joins its opener's space", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  const tabs = [tab(10, "https://a.com", "A"), tab(11, "https://a.com/2", "A2"), tab(400, "https://a.com/3", "A3", { openerTabId: 10 }), tab(100, "https://b.com", "B"), tab(101, "https://b.com/2", "B2")];
  const runs = b.t.idRuns(tabs);
  assert.equal(runs.get(400), runs.get(10));
  assert.notEqual(runs.get(100), runs.get(10));
});

test("website groups get re-sorted once a key is added, even with 'leave groups alone' on", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  b.state.tabs = [
    tab(1, "https://docs.google.com/a", "Resume draft"), tab(2, "https://docs.google.com/b", "Japan itinerary"),
    tab(3, "https://linkedin.com/jobs", "Resume tips"), tab(4, "https://booking.com", "Japan hotel"),
  ];
  await b.chrome.storage.sync.set({ provider: "domain" });
  let r = await b.t.tidy();
  assert.equal(r.mode, "domain");
  assert.deepEqual(titles(b.state), ["Google"]);
  await b.chrome.storage.sync.set({ provider: "gemini", apiKey: "AIzaTEST", keepGroups: true });
  r = await b.t.tidy();
  assert.equal(r.mode, "gemini");
  assert.deepEqual(titles(b.state), ["Japan", "Resume"], JSON.stringify([...b.state.groups.values()]) + JSON.stringify(r));
  assert.deepEqual((await b.chrome.storage.local.get("domainGroups")).domainGroups, []);
});

test("AI-made groups are left alone on the next tidy", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  b.state.tabs = chromeTabs();
  await b.chrome.storage.sync.set({ provider: "gemini", apiKey: "k" });
  await b.t.tidy();
  b.state.tabs.push(tab(950, "https://lego.com/z", "LEGO minifig"), tab(951, "https://cnn.com", "News today"));
  const before = b.state.tabs.find((t) => t.id === 3).groupId;
  const r = await b.t.tidy();
  assert.equal(r.tabs, 3);   // only loose tabs were sent: the 2 new ones plus the lone store tab
  assert.equal(b.state.tabs.find((t) => t.id === 950).groupId, before);   // joined LEGO by name
});

test("preview: nothing moves until Apply; Apply makes no second model call", async () => {
  const s = server();
  const b = makeBrowser({ fetchImpl: s.impl });
  b.state.tabs = chromeTabs();
  await b.chrome.storage.sync.set({ previewFirst: true });
  const r = await b.t.tidy({ fromOptions: true });
  assert.ok(r.preview);
  assert.equal(b.state.groups.size, 0);
  assert.equal(r.previewGroups.length, 3);
  const n = s.calls.length;
  const a = await b.t.applyPreview();
  assert.equal(a.groups, 3);
  assert.equal(s.calls.length, n);
});

test("undo puts tabs back", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  b.state.tabs = chromeTabs();
  await b.t.tidy();
  assert.ok(b.state.groups.size > 0);
  const u = await b.t.undoTidy();
  assert.equal(u.error, undefined);
  assert.equal(b.state.tabs.filter((t) => t.groupId !== -1).length, 0);
});

test("a refused tab is skipped, the rest still group", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  b.state.tabs = chromeTabs();
  b.state.tabs.find((t) => t.id === 41).refuse = true;
  b.state.tabs.push(tab(42, "https://lego.com/q", "LEGO castle"));
  const r = await b.t.tidy();
  assert.equal(r.skipped.length, 1);
  assert.deepEqual(titles(b.state), ["Japan", "LEGO", "LeetCode"]);
});

test("double click while tidying is rejected, not run twice", async () => {
  const s = server();
  const b = makeBrowser({ fetchImpl: s.impl });
  b.state.tabs = chromeTabs();
  const [a, c] = await Promise.all([b.t.tidy(), b.t.tidy()]);
  assert.ok([a, c].some((r) => /Already tidying/.test(r.error || "")));
  assert.equal(s.calls.filter((x) => x.url.endsWith("/tidy")).length, 1);
});

test("parsePlan: fences, unknown ids, strings, duplicates", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  const p = b.t.parsePlan('```json\n{"A":[1,"2",99],"B":[2,3],"C":[]}\n```', new Set([1, 2, 3]));
  assert.equal(JSON.stringify(p), JSON.stringify({ A: [1, 2], B: [3] }));
  assert.throws(() => b.t.parsePlan("sorry I can't", new Set([1])));
  assert.throws(() => b.t.parsePlan('{"A":[42]}', new Set([1])));
});

test("auto-tidy never spends free trial tidies", async () => {
  const s = server();
  const b = makeBrowser({ fetchImpl: s.impl });
  b.state.tabs = [...chromeTabs(), ...[1, 2, 3, 4, 5].map((i) => tab(2000 + i, "https://x.com/" + i, "LEGO " + i))];
  await b.chrome.storage.sync.set({ autoTidy: true, autoThreshold: 3 });
  b.t.scheduleAuto();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(s.calls.filter((c) => c.url.endsWith("/tidy")).length, 0);
});

test("install opens welcome, sets uninstall survey; minor update opens What's new, patch doesn't", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  await b.fire("runtime.onInstalled", { reason: "install" });
  assert.ok(b.state.created.some((u) => u.endsWith("welcome.html")));
  assert.match(b.state.uninstallUrl, /^https:\/\/tidy-tabs\.test\.workers\.dev\/bye\?v=/);
  b.state.created = [];
  await b.fire("runtime.onInstalled", { reason: "update", previousVersion: "1.8.1" });
  assert.ok(b.state.created.some((u) => u.includes("whatsnew.html")));
  b.state.created = [];
  const v = b.chrome.runtime.getManifest().version;
  await b.fire("runtime.onInstalled", { reason: "update", previousVersion: v.split(".").slice(0, 2).join(".") + ".99" });
  assert.equal(b.state.created.filter((u) => u.includes("whatsnew")).length, 0);   // same feature release: stay quiet
});

test("a site learned as 'leave alone' protects every page on it, not just the homepage", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  b.state.tabs = [...chromeTabs(), tab(500, "https://www.leetcode.com/problems/3", "LeetCode three")];
  await b.chrome.storage.sync.set({ protectedUrls: ["https://leetcode.com"] });
  await b.t.tidy();
  assert.ok(b.state.tabs.filter((t) => /leetcode/.test(t.url)).every((t) => t.groupId === -1));
  assert.deepEqual(titles(b.state), ["Japan", "LEGO"]);
});

test("share link goes through the counter", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  assert.equal(b.t.shareUrl(), "https://tidy-tabs.test.workers.dev/get");
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log("  ok  " + name); }
    catch (e) { fail++; console.log("FAIL  " + name + "\n      " + (e.stack || e).split("\n").slice(0, 4).join("\n      ")); }
  }
  console.log(`\n${tests.length - fail}/${tests.length} passed`);
  process.exit(fail ? 1 : 0);
})();

// node test/run.js
const assert = require("assert/strict");
const { makeBrowser, tab } = require("./harness");

// A stand-in model: groups tabs by the first word of the title ("LEGO ...", "Japan ...").
// It reads the tab list the way a real model would: numbered rows after the "The tabs (...)" line.
const tabRows = (prompt) => prompt.split(/\nThe tabs \([^)]*\):\n/)[1].trim().split("\n").map((l) => l.split("\t"));
function fakeModel(prompt) {
  const plan = {};
  for (const [num, title] of tabRows(prompt)) (plan[title.split(" ")[0]] ||= []).push(Number(num));
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
  assert.equal(await b.t.trialLeft(), 10);
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

test("parsePlan: repeated keys are merged, not dropped; names differing only by case become one group", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  const ids = new Set([1, 2, 3, 4, 5, 6]);
  const p = b.t.parsePlan('{"LEGO":[1,2],"Japan":[3],"LEGO":[4],"lego":[5],"Japan":[6],}', ids);
  assert.equal(JSON.stringify(p), JSON.stringify({ LEGO: [1, 2, 4, 5], Japan: [3, 6] }));
});

test("parsePlan: apostrophes in names, list-of-objects shape, and 'Misc' folded into Other", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  const ids = new Set([1, 2, 3, 4]);
  assert.equal(JSON.stringify(b.t.parsePlan(`{"Mom's birthday":[1,2],"Miscellaneous":[3],"  **CS50**: ":[4]}`, ids)), JSON.stringify({ "Mom's birthday": [1, 2], Other: [3], CS50: [4] }));
  assert.equal(JSON.stringify(b.t.parsePlan('{"groups":[{"name":"Trip","tabs":[1,2]},{"title":"Work","ids":["3",4]}]}', ids)), JSON.stringify({ Trip: [1, 2], Work: [3, 4] }));
  assert.equal(JSON.stringify(b.t.parsePlan('Here you go:\n[{"name":"Trip","tab_ids":[1,2]}]', ids)), JSON.stringify({ Trip: [1, 2] }));
});

test("titles and URLs are cleaned before they reach the model", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  assert.equal(b.t.cleanTitle("(12) Inbox   -  Gmail"), "Inbox - Gmail");
  assert.equal(b.t.cleanTitle("● notes.md"), "notes.md");
  assert.equal(b.t.compactUrl("https://www.amazon.com/dp/B0C1/?tag=abc&ref=xyz#reviews"), "amazon.com/dp/B0C1");
  assert.equal(b.t.compactUrl("not a url"), "not a url");
});

test("existing groups are described to the model with sample tabs, and only groups in scope are offered", async () => {
  const s = server();
  const b = makeBrowser({ fetchImpl: s.impl });
  b.state.tabs = chromeTabs();
  await b.chrome.storage.sync.set({ provider: "gemini", apiKey: "k" });
  await b.t.tidy();
  b.state.tabs.push(tab(950, "https://lego.com/z", "LEGO minifig"), tab(951, "https://lego.com/y", "LEGO castle"));
  s.calls.length = 0;
  await b.t.tidy();
  const prompt = JSON.parse(JSON.stringify(s.calls.find((c) => c.url.includes("generateContent")).body)).contents[0].parts[0].text;
  assert.match(prompt, /"LEGO": LEGO Speed Champions; LEGO light kit/);
  assert.equal([...b.state.groups.values()].filter((g) => g.title === "LEGO").length, 1);   // joined, no second LEGO group
});

test("a 400-tab window sends only the 150 most recent tabs and says so", async () => {
  const s = server();
  const b = makeBrowser({ fetchImpl: s.impl });
  b.state.tabs = [...Array(400)].map((_, i) => tab(5000 + i, "https://site" + (i % 40) + ".com/p" + i, "Topic" + (i % 40) + " page " + i, { lastAccessed: Date.now() - i * 1000 }));
  const r = await b.t.tidy();
  const prompt = s.calls.find((c) => c.url.endsWith("/tidy")).body.prompt;
  assert.equal(tabRows(prompt).length, 150);
  assert.ok(prompt.length < 40000, "prompt too big for the trial server: " + prompt.length);
  assert.match(r.note, /150 most recent tabs; tidy again for the other 250/);
  assert.ok(b.state.tabs.filter((t) => t.id >= 5150).every((t) => t.groupId === -1));
});

test("Chrome: clicking another tab while it sorts does not stall or cancel the tidy", async () => {
  const s = server();
  let b;
  const slow = async (url, opts) => {     // the person clicks a far-away tab while the model is thinking
    if (url.endsWith("/tidy")) { b.state.tabs.forEach((t) => (t.active = t.id === 3)); await b.fire("tabs.onActivated", { tabId: 3, windowId: 1 }); }
    return s.impl(url, opts);
  };
  b = makeBrowser({ fetchImpl: slow });
  b.state.tabs = chromeTabs();
  await b.chrome.storage.sync.set({ scope: "space" });   // the default written at install
  const t0 = Date.now();
  const r = await b.t.tidy();
  assert.equal(r.groups, 3, JSON.stringify(r));
  assert.ok(!/switched spaces/.test(r.note || ""));
  assert.ok(Date.now() - t0 < 2000);
});

test("a failed tidy does not wipe the previous undo", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  b.state.tabs = chromeTabs();
  await b.t.tidy();
  b.state.tabs.push(tab(960, "https://a.com/1", "Zed one"), tab(961, "https://a.com/2", "Zed two"));
  b.ctx.fetch = server({ trialStatus: 502 }).impl;
  await b.t.tidy().catch(() => {});
  const u = await b.t.undoTidy();
  assert.equal(u.error, undefined);
  assert.equal(b.state.tabs.filter((t) => t.groupId !== -1).length, 0);
});

test("new groups get colours that aren't already on screen", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  b.state.tabs = chromeTabs();
  await b.chrome.storage.sync.set({ provider: "gemini", apiKey: "k" });
  await b.t.tidy();
  b.state.tabs.push(tab(970, "https://c.com/1", "Chess openings"), tab(971, "https://c.com/2", "Chess endgames"));
  await b.t.tidy();
  const colors = [...b.state.groups.values()].map((g) => g.color);
  assert.equal(new Set(colors).size, colors.length, colors.join(","));
});

test("long tab ids never reach the model; it sees 1..N and its answer maps back", async () => {
  const s = server();
  const b = makeBrowser({ fetchImpl: s.impl });
  b.state.tabs = chromeTabs().map((t, i) => ({ ...t, id: 1294830000 + i * 37 }));
  const r = await b.t.tidy();
  const prompt = s.calls.find((c) => c.url.endsWith("/tidy")).body.prompt;
  assert.ok(!/12948\d{5}/.test(prompt));
  assert.deepEqual(tabRows(prompt).map((row) => Number(row[0])), [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(r.groups, 3);
});

test("a cut-off answer keeps the groups it finished and drops the half-written number", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  const p = b.t.parsePlan('{"Trip": [1, 2, 3], "Work": [4, 5, 1', new Set([1, 2, 3, 4, 5, 6, 10, 11, 12]));
  assert.equal(JSON.stringify(p), JSON.stringify({ Trip: [1, 2, 3], Work: [4, 5] }));
  const q = b.t.parsePlan('{"groups":["A","B"],"tabs":{"1":"A","2":"B","3":"A"}}', new Set([1, 2, 3]));
  assert.equal(JSON.stringify(q), JSON.stringify({ A: [1, 3], B: [2] }));
});

test("by-website names handle two-part country domains", async () => {
  const b = makeBrowser({ fetchImpl: server().impl });
  const p = b.t.byDomain([{ id: 1, url: "https://www.bbc.co.uk/news" }, { id: 2, url: "https://docs.google.com/x" }, { id: 3, url: "https://localhost:3000/" }]);
  assert.equal(JSON.stringify(Object.keys(p)), JSON.stringify(["Bbc", "Google", "Localhost"]));
});

test("a failed or empty toolbar click explains itself in the icon's hover text", async () => {
  const b = makeBrowser({ fetchImpl: server({ trialStatus: 502 }).impl });
  b.state.tabs = chromeTabs();
  await b.t.runWithFeedback(b.t.tidy);
  assert.equal(b.state.badge, "!");
  assert.match(b.state.title, /busy/);
  b.ctx.fetch = server().impl;
  await b.t.runWithFeedback(b.t.tidy);
  assert.equal(b.state.badge, "✓");
  assert.match(b.state.title, /right-click for Settings/);
  b.state.tabs = [tab(1, "https://a.com", "Only one")];
  await b.t.runWithFeedback(b.t.tidy);
  assert.equal(b.state.badge, "0");
  assert.match(b.state.title, /needs at least 2/);
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

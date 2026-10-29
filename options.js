const $ = (id) => document.getElementById(id);
$("ver").textContent = "v" + chrome.runtime.getManifest().version;
if (/Mac/i.test(navigator.platform)) { $("shortcut").innerHTML = "<kbd>⌥ Option</kbd>+<kbd>T</kbd>"; $("shortcutUndo").innerHTML = "<kbd>⌥ Option</kbd>+<kbd>Z</kbd>"; }

// Waiting on the background script forever would leave the page stuck on "Tidying…" in browsers that hang.
const ask = (msg, ms = 60000) => Promise.race([
  chrome.runtime.sendMessage(msg),
  new Promise((res) => setTimeout(() => res({ ok: false, error: "No answer after 60s. Reload the extension and try again.", summary: "No answer after 60s. Reload the extension and try again." }), ms)),
]);

$("openWelcome").onclick = (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: "welcome" }); };

// --- settings -------------------------------------------------------------------------------
chrome.storage.sync
  .get(["provider", "apiKey", "keepGroups", "closeDupes", "otherGroup", "granularity", "scope", "scopeHours", "autoTidy", "autoThreshold"])
  .then(({ provider = "domain", apiKey = "", keepGroups = true, closeDupes = false, otherGroup = false, granularity = "balanced", scope = "window", scopeHours = 2, autoTidy = false, autoThreshold = 8 }) => {
    $("provider").value = provider; $("apiKey").value = apiKey;
    $("keepGroups").checked = keepGroups; $("closeDupes").checked = closeDupes; $("otherGroup").checked = otherGroup; $("granularity").value = granularity; $("scope").value = scope; $("scopeHours").value = scopeHours; scopeRows();
    $("autoTidy").checked = autoTidy; $("autoThreshold").value = autoThreshold;
  });

function scopeRows() { $("scopeHoursRow").style.display = $("scope").value === "recent" ? "" : "none"; }
$("scope").addEventListener("change", scopeRows);

// Every setting saves itself the moment it changes — no Save button to forget.
let saveTimer = null;
async function saveSettings() {
  await chrome.storage.sync.set({
    provider: $("provider").value,
    apiKey: $("apiKey").value.trim(),
    keepGroups: $("keepGroups").checked,
    closeDupes: $("closeDupes").checked,
    otherGroup: $("otherGroup").checked,
    granularity: $("granularity").value,
    scope: $("scope").value,
    scopeHours: Math.max(0.5, parseFloat($("scopeHours").value) || 2),
    autoTidy: $("autoTidy").checked,
    autoThreshold: Math.max(3, parseInt($("autoThreshold").value, 10) || 8),
  });
  $("saved").textContent = "Saved";
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => ($("saved").textContent = ""), 1200);
}
for (const id of ["provider", "keepGroups", "closeDupes", "otherGroup", "granularity", "scope", "scopeHours", "autoTidy", "autoThreshold"]) {
  $(id).addEventListener("change", saveSettings);
}
// The key field saves as you type (debounced), so pasting a key is enough.
$("apiKey").addEventListener("input", () => { clearTimeout($("apiKey")._t); $("apiKey")._t = setTimeout(saveSettings, 400); });

// --- on-device model (Chrome's built-in Prompt API) ------------------------------------------
// The download only progresses while something is waiting on it, and this page stays alive while
// open — so the download is driven from here, not from the background script.
let odDriving = false;
async function odRefresh() {
  const on = $("provider").value === "ondevice";
  $("odBox").hidden = !on; $("apiKey").hidden = on;
  if (!on) return;
  if (typeof LanguageModel === "undefined") { $("odStatus").textContent = "This browser doesn't expose a built-in model to extensions (Chrome 138+ and Dia do). Pick another provider."; return; }
  let state;
  try { state = await LanguageModel.availability({ expectedOutputs: [{ type: "text", languages: ["en"] }] }); } catch (e) { $("odStatus").textContent = "Couldn't check the built-in model: " + (e.message || e); return; }
  $("odDownload").hidden = true; $("odBar").hidden = true;
  if (state === "available") {
    const { odProbe } = await chrome.storage.local.get("odProbe");
    $("odStatus").textContent = odProbe && !odProbe.real
      ? "🟡 The built-in model API is here but isn't a working model yet in this browser (it echoes prompts back). Pick Gemini (free tier) for now; this will light up when the browser ships real on-device inference."
      : "✅ Built-in model is ready. Tidying runs locally, free, with nothing sent anywhere. Run \"Test AI key\" once to confirm it answers.";
  }
  else if (state === "unavailable") $("odStatus").textContent = "The built-in model isn't available on this device (needs ~4 GB free and a recent machine).";
  else if (odDriving) $("odStatus").textContent = "Downloading… keep this page open.";
  else { $("odStatus").textContent = state === "downloading" ? "Download is paused or stalled. Click to resume — keep this page open until it finishes." : "The model isn't downloaded yet (one-time, roughly 2 GB). Keep this page open while it downloads."; $("odDownload").hidden = false; }
}
$("odDownload").onclick = async () => {
  odDriving = true; $("odDownload").hidden = true; $("odBar").hidden = false; $("odFill").style.width = "0%";
  $("odStatus").textContent = "Starting download… keep this page open.";
  try {
    const session = await LanguageModel.create({
      expectedOutputs: [{ type: "text", languages: ["en"] }],
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          const frac = e.total ? e.loaded / e.total : e.loaded;   // newer API reports a 0–1 fraction in `loaded`
          const pct = Math.max(0, Math.min(100, Math.round(frac * 100)));
          $("odFill").style.width = pct + "%";
          $("odStatus").textContent = `Downloading… ${pct}% — keep this page open.`;
        });
      },
    });
    try { session.destroy(); } catch {}
    $("odFill").style.width = "100%";
  } catch (e) {
    $("odStatus").textContent = "Download failed: " + (e.message || e);
  }
  odDriving = false;
  odRefresh();
};
$("provider").addEventListener("change", odRefresh);
setTimeout(odRefresh, 50);   // after the saved provider has been applied
setInterval(() => { if (!odDriving && $("provider").value === "ondevice") odRefresh(); }, 5000);

// --- learned rules --------------------------------------------------------------------------
async function showRules() {
  const { rules = [] } = await ask({ type: "rules" });
  $("rulesClear").hidden = rules.length === 0;
  if (!rules.length) return;
  $("rulesList").innerHTML = rules.map((r, i) =>
    `<div class="rule"><span>${esc(r.text)}${r.hits > 1 ? ` <span style="color:var(--muted)">×${r.hits}</span>` : ""}</span><button data-i="${i}">Forget</button></div>`).join("");
  $("rulesList").querySelectorAll("button").forEach((b) => b.onclick = async () => { await ask({ type: "forgetRule", index: +b.dataset.i }); showRules(); });
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
showRules();
chrome.storage.onChanged.addListener((c, area) => { if (area === "sync" && c.rules) showRules(); });
$("rulesClear").onclick = async () => { await ask({ type: "forgetAll" }); $("rulesList").textContent = "Forgotten."; $("rulesClear").hidden = true; };

// --- sessions -------------------------------------------------------------------------------
async function showSessions() {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  $("sessExport").hidden = sessions.length === 0;
  if (!sessions.length) { $("sessList").textContent = "None saved. A session is a snapshot of this space's groups and tabs that you can bring back later."; return; }
  $("sessList").innerHTML = sessions.map((s, i) => {
    const n = s.groups.reduce((a, g) => a + g.tabs.length, 0) + s.loose.length;
    return `<div class="sess"><span><b>${esc(s.name)}</b><div class="meta">${s.groups.length} group${s.groups.length === 1 ? "" : "s"}, ${n} tabs · ${new Date(s.at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}</div></span>
      <span><button data-i="${i}" data-act="restore">Restore</button> <button data-i="${i}" data-act="del">Delete</button></span></div>`;
  }).join("");
  $("sessList").querySelectorAll("button").forEach((b) => b.onclick = async () => {
    const i = +b.dataset.i;
    if (b.dataset.act === "del") { const { sessions = [] } = await chrome.storage.local.get("sessions"); sessions.splice(i, 1); await chrome.storage.local.set({ sessions }); showSessions(); }
    else { b.disabled = true; b.textContent = "Restoring…"; const r = await ask({ type: "restoreSession", index: i }); await chrome.storage.local.set({ lastResult: { at: Date.now(), ...r } }); showSessions(); }
  });
}
showSessions();
chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.sessions) showSessions(); });
$("sessSave").onclick = async () => {
  const name = prompt("Name this session:", new Date().toLocaleDateString([], { month: "short", day: "numeric" }) + " space");
  if (name === null) return;
  const r = await ask({ type: "saveSession", name: name.trim() || "Untitled" });
  await chrome.storage.local.set({ lastResult: { at: Date.now(), ...r } });
};
$("sessExport").onclick = async () => {
  const { sessions = [] } = await chrome.storage.local.get("sessions");
  const blob = new Blob([JSON.stringify({ tidyTabsSessions: 1, sessions }, null, 2)], { type: "application/json" });
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "tidy-tabs-sessions.json"; a.click();
};
$("sessImportBtn").onclick = () => $("sessImport").click();
$("sessImport").onchange = async () => {
  const f = $("sessImport").files[0]; if (!f) return;
  try {
    const j = JSON.parse(await f.text());
    const incoming = Array.isArray(j.sessions) ? j.sessions : [];
    const { sessions = [] } = await chrome.storage.local.get("sessions");
    await chrome.storage.local.set({ sessions: [...incoming, ...sessions].slice(0, 50) });
  } catch { alert("That file didn't look like a Tidy Tabs export."); }
  $("sessImport").value = "";
};

// --- protected tabs -------------------------------------------------------------------------
async function showProtected() {
  const { protectedUrls = [] } = await chrome.storage.sync.get("protectedUrls");
  $("protClear").hidden = protectedUrls.length === 0;
  if (!protectedUrls.length) return;
  $("protList").innerHTML = protectedUrls.map((u) => `<div>🔒 ${u.replace(/^https?:\/\//, "")}</div>`).join("");
}
showProtected();
chrome.storage.onChanged.addListener((c, area) => { if (area === "sync" && c.protectedUrls) showProtected(); });
$("protClear").onclick = async () => {
  await chrome.storage.sync.set({ protectedUrls: [] });
  $("protList").innerHTML = "None yet. Right-click a page → <b>Never tidy this tab</b> to keep it out of groups (handy for Dia's pinned tabs).";
};

// --- last run -------------------------------------------------------------------------------
function describe(r) {
  if (!r) return "Nothing yet.";
  const when = new Date(r.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (r.error) return `<b>Error</b> at ${when}: ${r.error}`;
  if (r.ungrouped != null) return `Ungrouped <b>${r.ungrouped}</b> tabs at ${when}.`;
  if (r.saved) return `Saved session <b>${esc(r.name)}</b> at ${when}: ${r.groups} groups, ${r.tabs} tabs.`;
  if (r.restoredSession) return `Restored <b>${esc(r.name)}</b> at ${when}: opened ${r.opened} tabs in ${r.groups} groups${r.alreadyOpen ? ` (${r.alreadyOpen} were already open)` : ""}.`;
  if (r.undone) return `Undid the last tidy at ${when}: <b>${r.restored}</b> tabs put back${r.failed ? `, ${r.failed} couldn't be` : ""}.${r.dupesClosed ? ` (${r.dupesClosed} duplicate${r.dupesClosed === 1 ? "" : "s"} closed by that tidy stay closed — reopen with ⌘⇧T.)` : ""}`;
  const sc = { recent: " (recently used only)", highlighted: " (selected only)", space: " (current space only)" }[r.scope] || "";
  let s = `Made <b>${r.groups}</b> group${r.groups === 1 ? "" : "s"} from ${r.tabs} tabs${sc} at ${when}.`;
  if (r.dupes) s += ` Closed ${r.dupes} duplicate${r.dupes === 1 ? "" : "s"}.`;
  if (r.note) s += ` ${esc(r.note)}`;
  if (r.skipped?.length) s += ` Couldn't group: ${r.skipped.map((x) => x.title).join(", ")}.`;
  return s;
}
async function showLast() {
  const { lastResult } = await chrome.storage.local.get("lastResult");
  $("last").innerHTML = describe(lastResult);
}
showLast();
chrome.storage.onChanged.addListener((c, area) => { if (area === "local" && c.lastResult) showLast(); });

$("tidyNow").onclick = async () => {
  $("tidyNow").disabled = true; $("last").textContent = "Tidying…";
  const r = await ask({ type: "tidy" });
  if (r?.error && !r.at) await chrome.storage.local.set({ lastResult: { at: Date.now(), error: r.error } });
  $("tidyNow").disabled = false; showLast();
};
$("undo").onclick = async () => {
  const r = await ask({ type: "undo" });
  if (r?.error) await chrome.storage.local.set({ lastResult: { at: Date.now(), error: r.error } });
};
$("ungroup").onclick = async () => {
  const r = await ask({ type: "ungroup" });
  await chrome.storage.local.set({ lastResult: { at: Date.now(), ...r } });
};

// --- diagnostics ----------------------------------------------------------------------------
function showDiag(r) {
  $("diagOut").textContent = r?.summary || r?.error || "No response.";
  $("diagOut").style.color = r?.ok ? "" : "var(--bad)";
  const raw = r?.raw || null;
  $("rawWrap").hidden = !raw;
  if (raw) $("out").textContent = JSON.stringify(raw, null, 1);
}
$("diag").onclick = async () => { $("diagOut").style.color = ""; $("diagOut").textContent = "Checking…"; showDiag(await ask({ type: "diag" })); };
$("testai").onclick = async () => { $("diagOut").style.color = ""; $("diagOut").textContent = "Calling the model…"; showDiag(await ask({ type: "testai" })); };

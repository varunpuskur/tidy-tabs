const $ = (id) => document.getElementById(id);
$("ver").textContent = "v" + chrome.runtime.getManifest().version;
if (/Mac/i.test(navigator.platform)) $("shortcut").innerHTML = "<kbd>⌥ Option</kbd>+<kbd>T</kbd>";

// Waiting on the background script forever would leave the page stuck on "Tidying…" in browsers that hang.
const ask = (msg, ms = 60000) => Promise.race([
  chrome.runtime.sendMessage(msg),
  new Promise((res) => setTimeout(() => res({ ok: false, error: "No answer after 60s. Reload the extension and try again.", summary: "No answer after 60s. Reload the extension and try again." }), ms)),
]);

// --- settings -------------------------------------------------------------------------------
chrome.storage.sync
  .get(["provider", "apiKey", "keepGroups", "closeDupes", "otherGroup", "granularity", "autoTidy", "autoThreshold"])
  .then(({ provider = "domain", apiKey = "", keepGroups = true, closeDupes = false, otherGroup = false, granularity = "balanced", autoTidy = false, autoThreshold = 8 }) => {
    $("provider").value = provider; $("apiKey").value = apiKey;
    $("keepGroups").checked = keepGroups; $("closeDupes").checked = closeDupes; $("otherGroup").checked = otherGroup; $("granularity").value = granularity;
    $("autoTidy").checked = autoTidy; $("autoThreshold").value = autoThreshold;
  });

$("save").onclick = async () => {
  await chrome.storage.sync.set({
    provider: $("provider").value,
    apiKey: $("apiKey").value.trim(),
    keepGroups: $("keepGroups").checked,
    closeDupes: $("closeDupes").checked,
    otherGroup: $("otherGroup").checked,
    granularity: $("granularity").value,
    autoTidy: $("autoTidy").checked,
    autoThreshold: Math.max(3, parseInt($("autoThreshold").value, 10) || 8),
  });
  $("saved").textContent = "Saved";
  setTimeout(() => ($("saved").textContent = ""), 1500);
};

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
  try { state = await LanguageModel.availability(); } catch (e) { $("odStatus").textContent = "Couldn't check the built-in model: " + (e.message || e); return; }
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
  let s = `Made <b>${r.groups}</b> group${r.groups === 1 ? "" : "s"} from ${r.tabs} tabs at ${when}.`;
  if (r.dupes) s += ` Closed ${r.dupes} duplicate${r.dupes === 1 ? "" : "s"}.`;
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

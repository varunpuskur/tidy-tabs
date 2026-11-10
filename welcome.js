const $ = (id) => document.getElementById(id);
const prov = () => document.querySelector('input[name="prov"]:checked').value;
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: String(e?.message || e) }));

const isMac = /Mac/i.test(navigator.platform);
const kbd = (shortcut) => {
  // Chrome reports "⌥T" on Mac and "Alt+T" elsewhere; show each key as its own cap.
  const parts = isMac ? [...shortcut].map((c) => ({ "⌥": "⌥ Option", "⌘": "⌘ Cmd", "⇧": "⇧ Shift", "⌃": "⌃ Ctrl" }[c] || c)) : shortcut.split("+");
  return parts.map((k) => `<kbd>${k}</kbd>`).join("");
};
if (isMac) $("undoKey").innerHTML = "<kbd>⌥ Option</kbd>+<kbd>Z</kbd>";

// Lead with the keyboard shortcut so the very first tidy teaches it. If the browser didn't assign one
// (another extension already has Alt+T), fall back to a big button and a link to pick a shortcut.
chrome.commands.getAll().then((cmds) => {
  const key = cmds.find((c) => c.name === "tidy")?.shortcut || "";
  if (!key) { $("pressRow").classList.add("hidden"); $("noKeyRow").classList.remove("hidden"); $("shortcut").textContent = "your shortcut"; return; }
  $("bigKeys").innerHTML = kbd(key);
  $("shortcut").innerHTML = kbd(key).replace("</kbd><kbd>", "</kbd>+<kbd>");
}).catch(() => {});
$("setKeys").onclick = (e) => { e.preventDefault(); chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); };

// Dia detection lives in the background (it looks for Dia's assistant tabs); ask it.
chrome.tabs.query({}).then((tabs) => {
  if (tabs.some((t) => /^chrome:\/\/(assistant|start-page)\//.test(t.url || ""))) $("diaNote").classList.remove("hidden");
}).catch(() => {});

// ---- free trial status -----------------------------------------------------------------------
let trial = { left: 10, limit: 10, configured: true };
async function showTrial() {
  trial = (await send({ type: "trial" })) || trial;
  const { apiKey = "", provider = "gemini" } = await chrome.storage.sync.get(["apiKey", "provider"]);
  const own = (apiKey && provider !== "domain") || provider === "ondevice" || provider === "domain";
  if (own) $("trialLine").textContent = provider === "domain" ? "Grouping by website (no AI)." : "Using your own key: unlimited tidies.";
  else if (!trial.configured) $("trialLine").textContent = "Add a free Gemini key below to start.";
  else if (trial.left > 0) $("trialLine").textContent = `${trial.left} of ${trial.limit} free tidies left.`;
  else $("trialLine").textContent = "Free tidies used up. Add a free key below to keep going.";
  if (trial.shareUrl) $("shareUrl").value = trial.shareUrl;
}
showTrial();

// Arrived because the free tidies ran out: point straight at the key box.
if (location.hash === "#key") {
  $("key").classList.add("flash");
  $("keyIntro").innerHTML = "<b>Your free tidies are used up.</b> Add your own Gemini key to keep going. It's free and takes about a minute:";
  setTimeout(() => $("key").scrollIntoView({ behavior: "smooth", block: "center" }), 200);
}

// ---- settings ----------------------------------------------------------------------------------
chrome.storage.sync.get(["provider", "apiKey"]).then(({ provider, apiKey = "" }) => {
  if (provider) { const r = document.querySelector(`input[name="prov"][value="${provider}"]`); if (r) r.checked = true; }
  $("apiKey").value = apiKey;
  placeholder();
});
function placeholder() {
  const names = { gemini: "Gemini", anthropic: "Claude", openai: "OpenAI" };
  $("apiKey").placeholder = names[prov()] ? `Paste your ${names[prov()]} key` : "No key needed";
  $("apiKey").disabled = !names[prov()];
}
document.querySelectorAll('input[name="prov"]').forEach((r) => r.addEventListener("change", async () => {
  placeholder();
  await chrome.storage.sync.set({ provider: prov(), onboarded: true });
  showTrial();
}));

// Paste a key: save it and check it right away, no extra button.
$("apiKey").addEventListener("input", () => {
  clearTimeout($("apiKey")._t);
  $("apiKey")._t = setTimeout(async () => {
    const key = $("apiKey").value.trim();
    await chrome.storage.sync.set({ provider: prov(), apiKey: key, onboarded: true });
    showTrial();
    if (!key) { $("keyStatus").textContent = ""; return; }
    $("keyStatus").className = "status"; $("keyStatus").textContent = "Checking the key…";
    const r = await send({ type: "testai" });
    $("keyStatus").className = "status " + (r?.ok ? "ok" : "bad");
    $("keyStatus").textContent = r?.ok ? "✅ Key works. Unlimited tidies." : "❌ " + (r?.summary || r?.error || "No response");
  }, 600);
});

// ---- tidy ----------------------------------------------------------------------------------------
// Both paths end up in showResult: the button asks the background directly; the shortcut runs in the
// background and we hear about it through lastResult in storage.
async function clickTidy() {
  $("tidy").disabled = $("tidyBig").disabled = true;
  $("tidyStatus").className = "status"; $("tidyStatus").textContent = "Sorting your tabs…";
  const r = await send({ type: "tidy", fromOptions: true });
  $("tidy").disabled = $("tidyBig").disabled = false;
  showResult(r);
}
$("tidy").onclick = clickTidy;
$("tidyBig").onclick = clickTidy;
let lastSeen = Date.now();
chrome.storage.onChanged.addListener((c, area) => {
  const r = area === "local" && c.lastResult?.newValue;
  if (!r || r.at <= lastSeen) return;
  lastSeen = r.at;
  if (r.groups != null || r.error || r.preview) showResult(r, true);
});
// viaShortcut: the background already opened whatever page it needed (Settings for a preview, this page for a key).
function showResult(r, viaShortcut = false) {
  showTrial();
  if (!r) return;
  if (r?.needKey) {
    $("tidyStatus").className = "status bad"; $("tidyStatus").textContent = r.error;
    $("key").classList.add("flash"); $("key").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (r?.error) { $("tidyStatus").className = "status bad"; $("tidyStatus").textContent = "❌ " + r.error; return; }
  if (r.preview) { $("tidyStatus").textContent = `Preview ready in Settings: ${r.groups} groups proposed.`; if (!viaShortcut) chrome.runtime.openOptionsPage(); return; }
  if (r.groups) {
    $("tidyStatus").className = "status ok";
    $("tidyStatus").textContent = `✅ Made ${r.groups} group${r.groups === 1 ? "" : "s"} from ${r.tabs} tabs. Look at your tab bar. Undo with ${isMac ? "⌥Z" : "Alt+Z"}.`;
    document.querySelector(".hero").classList.add("done-flash");
    $("shareCard").classList.remove("hidden");
  } else {
    $("tidyStatus").className = "status";
    $("tidyStatus").textContent = r.note || `Nothing to group: ${r.tabs} loose tab${r.tabs === 1 ? "" : "s"}. Open a few more tabs and try again.`;
  }
};

// ---- share ------------------------------------------------------------------------------------
$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("shareUrl").value); } catch { $("shareUrl").select(); document.execCommand("copy"); }
  $("copy").textContent = "Copied ✓";
  setTimeout(() => ($("copy").textContent = "Copy link"), 1500);
};

$("settings").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

// On-device availability.
(async () => {
  const d = $("odDesc");
  if (typeof LanguageModel === "undefined") { d.textContent = "Not available in this browser."; $("odOpt").style.opacity = 0.5; return; }
  try {
    const state = await LanguageModel.availability({ expectedOutputs: [{ type: "text", languages: ["en"] }] });
    const { odProbe } = await chrome.storage.local.get("odProbe");
    if (state === "available" && odProbe && !odProbe.real) { d.textContent = "This browser's model doesn't answer yet."; $("odOpt").style.opacity = 0.5; }
    else if (state === "available") d.textContent = "Ready here.";
    else if (state === "downloadable" || state === "downloading") d.textContent = "Needs a one-time 2 GB download from Settings.";
    else { d.textContent = "Not available on this device."; $("odOpt").style.opacity = 0.5; }
  } catch { d.textContent = "Couldn't check."; }
})();

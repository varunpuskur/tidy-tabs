const $ = (id) => document.getElementById(id);
const prov = () => document.querySelector('input[name="prov"]:checked').value;
if (/Mac/i.test(navigator.platform)) $("shortcut").innerHTML = "<kbd>⌥ Option</kbd>+<kbd>T</kbd>";

const isDia = /\bDia\b/i.test(navigator.userAgent) || typeof LanguageModel !== "undefined" && /Chrome\/15[0-9]/.test(navigator.userAgent);
if (isDia) $("diaNote").classList.remove("hidden");

// Load whatever's already saved (e.g. someone reopening this page).
chrome.storage.sync.get(["provider", "apiKey"]).then(({ provider, apiKey = "" }) => {
  if (provider) { const r = document.querySelector(`input[name="prov"][value="${provider}"]`); if (r) r.checked = true; }
  $("apiKey").value = apiKey;
  refresh();
});

const KEY_HELP = {
  gemini: ["Get a free Gemini key", 'Open <a href="https://aistudio.google.com/apikey" target="_blank">aistudio.google.com/apikey</a> → <b>Create API key</b> → copy it (starts with <code>AIza</code>). Free tier covers hundreds of tidies a day.'],
  anthropic: ["Get a Claude key", 'Open <a href="https://console.anthropic.com/settings/keys" target="_blank">console.anthropic.com</a>, add $5 of credit under Billing, then <b>Create Key</b>. A tidy costs about three hundredths of a cent.'],
  openai: ["Get an OpenAI key", 'Open <a href="https://platform.openai.com/api-keys" target="_blank">platform.openai.com/api-keys</a>, add $5 of credit, then <b>Create new secret key</b>. A tidy costs about three hundredths of a cent.'],
};

function refresh() {
  const p = prov();
  const needsKey = p in KEY_HELP;
  $("keyStep").classList.toggle("hidden", !needsKey);
  if (needsKey) { $("keyTitle").textContent = KEY_HELP[p][0]; $("keyHelp").innerHTML = KEY_HELP[p][1]; }
  save();
}
document.querySelectorAll('input[name="prov"]').forEach((r) => r.addEventListener("change", refresh));
$("apiKey").addEventListener("input", () => { clearTimeout($("apiKey")._t); $("apiKey")._t = setTimeout(save, 400); });

async function save() {
  await chrome.storage.sync.set({ provider: prov(), apiKey: $("apiKey").value.trim(), onboarded: true });
}

// On-device availability: show it as an option only if this browser has a real model.
(async () => {
  const d = $("odDesc");
  if (typeof LanguageModel === "undefined") { d.textContent = "Not available in this browser (Chrome 138+ has it)."; $("odOpt").style.opacity = .5; return; }
  try {
    const state = await LanguageModel.availability({ expectedOutputs: [{ type: "text", languages: ["en"] }] });
    const { odProbe } = await chrome.storage.local.get("odProbe");
    if (state === "available" && odProbe && !odProbe.real) { d.textContent = "This browser has the API but the model doesn't answer yet. Use Gemini for now."; $("odOpt").style.opacity = .5; }
    else if (state === "available") d.textContent = "Built-in model is ready. Nothing leaves your machine.";
    else if (state === "downloadable" || state === "downloading") d.textContent = "Needs a one-time ~2 GB download — set it up from Settings.";
    else { d.textContent = "Not available on this device."; $("odOpt").style.opacity = .5; }
  } catch { d.textContent = "Couldn't check availability."; }
})();

$("test").onclick = async () => {
  await save();
  $("test").disabled = true; $("keyStatus").className = "status"; $("keyStatus").textContent = "Checking…";
  const r = await chrome.runtime.sendMessage({ type: "testai" });
  $("test").disabled = false;
  $("keyStatus").className = "status " + (r?.ok ? "ok" : "bad");
  $("keyStatus").textContent = r?.ok ? "✅ " + r.summary : "❌ " + (r?.summary || r?.error || "No response");
};

$("tidy").onclick = async () => {
  await save();
  $("tidy").disabled = true; $("tidyStatus").className = "status"; $("tidyStatus").textContent = "Tidying… look at your sidebar.";
  const r = await chrome.runtime.sendMessage({ type: "tidy" });
  $("tidy").disabled = false;
  if (r?.error) { $("tidyStatus").className = "status bad"; $("tidyStatus").textContent = "❌ " + r.error; return; }
  $("tidyStatus").className = "status ok";
  $("tidyStatus").textContent = r.groups ? `✅ Made ${r.groups} group${r.groups === 1 ? "" : "s"} from ${r.tabs} tabs.` : `Nothing to group yet (${r.tabs} tabs in scope). Open a few related tabs and try again.`;
};
$("settings").onclick = () => chrome.runtime.openOptionsPage();

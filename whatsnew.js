const $ = (id) => document.getElementById(id);
$("ver").textContent = chrome.runtime.getManifest().version;
$("rate").href = "https://chromewebstore.google.com/detail/cadaopjbichjjgljabfkokckndfgnpoa/reviews";
chrome.runtime.sendMessage({ type: "trial" }).then((t) => { if (t?.shareUrl) $("shareUrl").value = t.shareUrl; }).catch(() => {});
$("copy").onclick = async () => {
  try { await navigator.clipboard.writeText($("shareUrl").value); } catch { $("shareUrl").select(); document.execCommand("copy"); }
  $("copy").textContent = "Copied ✓";
  setTimeout(() => ($("copy").textContent = "Copy link"), 1500);
};
$("settings").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

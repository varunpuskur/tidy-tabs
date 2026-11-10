# 🧹 Tidy Tabs: AI Tab Organizer & Group Manager

One-click AI tab grouping, in the spirit of Arc's Tidy Tabs. Click the broom, and your loose tabs get sorted into named groups like "LEGO", "Japan trip", "CS50", the way you'd organize them by hand.

Works in **Dia, Chrome, Brave, Edge**, and any other Chromium browser with native tab groups. **It does not work in Arc** (Arc doesn't let extensions create groups in its sidebar; see FAQ).

<!-- screenshot: sidebar before/after -->

## What it does

Tidy Tabs is a tab organizer and tab manager that groups your open tabs by topic with one click, using the AI provider of your choice.

- **Click the icon → tidy.** Loose tabs are grouped by topic with sensible names and colors. Pinned tabs and tabs already in a group are left alone.
- **Re-tidy anytime.** New tabs join an existing group if the name fits ("Japan trip" picks up a new flight tab), otherwise they get a new one. If you rename a group, the new name is respected.
- **Everyday tools stay loose.** Gmail, Calendar, Drive and the like aren't forced into topic groups.
- **Auto-tidy** (optional): once loose tabs pass a threshold you set, it tidies on its own. The badge shows your loose-tab count and turns red at the threshold.
- **Close duplicates** (optional): keeps the newest copy, never closes the tab you're looking at.
- **Keyboard shortcut:** `Alt+T` (`⌥ Option+T` on Mac). Right-click the icon or any page for Tidy / Ungroup all / Auto-tidy / Settings.

## What's new in 1.9

- **Works on the first click.** New installs get 5 free tidies through a small server that holds the Gemini key, so there's nothing to set up. After that it asks for your own free key. It never silently falls back to grouping by website.
- **Fixed "no tabs found" in Chrome.** Chrome 150+ ships the same built-in AI API Dia does, so it was being treated as Dia and scoped to one or two tabs. Dia is now detected by its assistant tabs, and every other browser tidies the whole window.
- **Better Dia spaces.** A tab opened in a space (Cmd+T, or from a link) counts as part of that space immediately.
- **One-button welcome page**, a **What's new** page on feature updates, a **share link**, and a one-question **uninstall survey**.
- Fixes: a tab listed in two groups by the model is no longer grouped twice; a site you've pulled out of groups twice is now protected on every page, not just its homepage; the diagnostic event log no longer writes to storage on every tab event.

## What's new in 1.8.1

- **Clearer first run.** The welcome page won't let you tidy until your key tests OK (or you explicitly choose "Skip AI"), so your first tidy is a real one. The Last run line now says how tabs were grouped: "by topic with Gemini" or "by website, no AI".
- **Adding a key now changes something.** Groups made in "by website" mode get re-sorted the first time you tidy with AI, even with "Leave existing groups alone" on.
- **Same site, different projects.** The model is told to split tabs from one website across groups when the titles are about different things.
- **Preview before applying** (optional, in Settings): see the proposed groups and click Apply, or Cancel.
- Plainer message when nothing happens because it couldn't tell which space you're in.

## What's new in 1.8

- **Undo** (⌥Z / Alt+Z) puts everything back after a tidy.
- **Learns from corrections.** Drag a tab out of a group, into another group, or rename a group, and it remembers next time. See *What it's learned* in Settings.
- **Sessions.** Save a space's groups and tabs; restore later; export/import as JSON.
- **Current-space scope for Dia.** Tidies only the space you're looking at, including tabs you haven't clicked.
- **Welcome page** on first install walks through getting a free Gemini key.
- **Granularity** control (Broad / Balanced / Specific) and a "Never tidy this tab" right-click option.

## Install (2 minutes)

1. [Download the latest release](../../releases) and unzip it somewhere permanent (not Downloads; the browser loads it from that path every time).
2. Open `chrome://extensions` (works in Dia/Brave/Edge too).
3. Turn on **Developer mode** (top right) → **Load unpacked** → pick the unzipped `tidy-tabs` folder.
4. Right-click the broom icon → **Settings…**
5. Pick an AI provider and paste a key (below). Save. Click the broom.

## AI providers and cost

The grouping uses a small language model. Nothing goes through any server of mine.

| Provider | Model | Cost | Notes |
|---|---|---|---|
| **On-device** (recommended where it works) | Browser's built-in model (Gemini Nano) | **Free, fully local** | Chrome 138+. One-time ~2 GB download from the Settings page; nothing leaves your machine. Dia exposes the API but, as of now, the model behind it isn't functional, and the extension detects this and tells you. |
| **Gemini** | Flash-Lite | **Free** | For browsers without a built-in model. Key at [aistudio.google.com](https://aistudio.google.com/apikey); free tier is ~500 tidies/day, no card. |
| Claude | Haiku | ~$0.0003 per tidy | [console.anthropic.com](https://console.anthropic.com, $5 minimum credit. |
| OpenAI | gpt-4o-mini | ~$0.0003 per tidy | [platform.openai.com](https://platform.openai.com, $5 minimum credit. |
| None | n/a | Free | "By domain" mode groups by website instead of topic. Works, but it's not the point. |

The first 5 tidies need no key: they go through a small server of mine that forwards titles and URLs to Gemini and stores none of them (see PRIVACY.md). After that, with your own key, each tidy sends tab **titles and URLs** straight to the provider you chose: not page contents, not history, not anything else. Keys are stored in your browser's extension storage and never leave it except to call that provider.

## FAQ

**Why doesn't it work in Arc?**
Arc's sidebar is its own thing. Extensions can read your tabs, but Arc never responds to the `chrome.tabs.group()` call that creates a group, so no extension can make folders or sections in Arc's sidebar. Arc's own Tidy Tabs could only do it because it was built into the browser. If you're on Arc and miss the feature, this works the moment you open the same tabs in Dia.

**Some of my tabs say "couldn't group".**
Some browsers refuse to group certain tabs. Dia refuses tabs inside its split view and some of its own special tabs, and every browser refuses internal pages like `chrome://extensions`. Those get skipped; everything else groups normally. "Check browser support" in Settings will tell you which ones.

**Can it run without an API key?**
In Chrome 138+, yes: pick **On-device** in Settings and download the browser's built-in model once (~2 GB). After that, tidying runs locally and nothing is sent anywhere. Dia has the same API but the model behind it doesn't answer yet (it echoes prompts back); the extension checks for this and will switch on automatically once Dia ships real inference. Until then, Gemini's free tier is the no-cost route in Dia, or "By domain" mode (groups by website, no AI).

**Why does it ask to "read browsing history"?**
That's Chrome's wording for the `tabs` permission, which is what lets an extension see tab titles and URLs, the only input to the grouping. It doesn't read your history. Every tab manager shows the same line.

**Does it close tabs?**
Only duplicates, only if you turn that option on, and never the active tab. Grouping never closes anything.

**Where do my settings live?**
In your browser's synced extension storage, so they follow you between profiles on the same account. The rules it learns from your corrections live there too (see *What it's learned* in Settings to review or delete them). Sessions and the undo snapshot are local only. Deleting the extension deletes all of it.

## Development

No build step:

- `background.js`: grouping, providers, free trial, auto-tidy, badge, diagnostics
- `options.html` / `options.js`: settings page
- `welcome.*`, `whatsnew.*`, `pages.css`: first-run and update pages
- `worker/`: the free-trial server (Cloudflare Worker). See `worker/DEPLOY.md`.
- `test/`: `node test/run.js` runs the extension in a fake browser; `node worker/test.mjs` tests the server.

Edit, then hit reload on the extension card in `chrome://extensions`.

## Credits

Modeled on Arc's Tidy Tabs by The Browser Company. Built by Varun Puskur. MIT licensed.

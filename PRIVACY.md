# Tidy Tabs Privacy Policy

_Last updated: November 10, 2026_

Tidy Tabs is a browser extension that groups your open tabs by topic. This page explains exactly what it touches.

## What the extension reads

- **Tab titles and URLs** of the tabs in your current window, at the moment you click Tidy (or when auto-tidy runs). It does not read page contents, browsing history, cookies, or form data.

## Where that data goes

- **In "By domain" mode:** nowhere. Grouping is done locally in your browser.
- **In "On-device" mode:** nowhere. Tab titles and URLs are passed to the browser's built-in language model, which runs on your computer.
- **Free trial (the first 10 tidies, before you add a key):** tab titles and URLs, plus a random install ID the extension generates, are sent to the developer's small server (a Cloudflare Worker), which forwards the titles and URLs to Google's Gemini API and returns the result. The server does not store tab titles or URLs. It stores only: the random install ID with a count of tidies used; a daily counter keyed by a one-way scramble of your IP address (the address itself is never stored, and the scramble can't be reversed or linked across days), which expires after 2 days, to stop abuse; and daily totals. The trial currently uses Gemini's free tier, under which Google may use what it receives (the tab titles and URLs of trial tidies) to improve its products; see the Gemini API terms. Once you add your own key, nothing goes through this server.
- **With your own key (Gemini, Claude, or OpenAI mode):** tab titles and URLs are sent directly from your browser to the AI provider you selected, using the API key you supplied. Nothing goes through the developer's server. Those providers' own privacy policies apply to what they receive:
  - Google Gemini API: https://ai.google.dev/gemini-api/terms
  - Anthropic: https://www.anthropic.com/privacy
  - OpenAI: https://openai.com/policies/privacy-policy

## What is stored

- Your settings and API key are stored in your browser's extension storage (`chrome.storage.sync`), which the browser may sync between your own devices if you're signed in. They are never sent to the developer.
- The rules it learns from your corrections ("never group github.com", "call the group about flights 'Japan trip'") are short plain-language lines stored the same way, in `chrome.storage.sync`. They contain website hostnames and group names, not page contents. In AI modes they are included in the prompt sent to your chosen provider, so it can follow them. You can see and delete every rule under "What it's learned" in Settings.
- Saved sessions, the undo snapshot, and the list of groups made in "by website" mode are stored locally only (`chrome.storage.local`) and never sync.
- A short record of the last run (counts, errors) is stored locally for the settings page.

## Other things the server counts

- **Share links.** The "Copy link" share link goes through the same server, which adds 1 to a click counter and forwards to the Chrome Web Store. Nothing about the person clicking is stored.
- **Uninstall survey.** When you remove the extension, the browser opens a one-question page asking why. If you answer, the server stores the reason you picked and any comment you typed, with the extension version. Nothing else.

## What is not done

- No analytics, telemetry, or crash reporting inside the extension.
- No data is sold, shared, or used for advertising.
- No remote code is loaded; everything the extension runs ships in the package.

## Permissions, in plain language

| Permission | Why |
|---|---|
| `tabs` | Read tab titles and URLs (Chrome labels this "read your browsing history," but the extension only looks at open tabs). |
| `tabGroups` | Create and name the tab groups. |
| `storage` | Save your settings. |
| `contextMenus` | The right-click menu (Tidy, Ungroup, Never tidy this tab). |
| `api.anthropic.com`, `api.openai.com`, `generativelanguage.googleapis.com` | Call the AI provider you chose, only in those modes. |

The free-trial server needs no extra permission; it is called like any website that allows it.

## Contact

Varun Puskur, varun.puskur.dev@gmail.com
Source code: https://github.com/varunpuskur/tidy-tabs

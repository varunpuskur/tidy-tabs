# Tidy Tabs — Privacy Policy

_Last updated: October 28, 2026_

Tidy Tabs is a browser extension that groups your open tabs by topic. This page explains exactly what it touches.

## What the extension reads

- **Tab titles and URLs** of the tabs in your current window, at the moment you click Tidy (or when auto-tidy runs). It does not read page contents, browsing history, cookies, or form data.

## Where that data goes

- **In "By domain" mode:** nowhere. Grouping is done locally in your browser.
- **In "On-device" mode:** nowhere. Tab titles and URLs are passed to the browser's built-in language model, which runs on your computer.
- **In Gemini, Claude, or OpenAI mode:** tab titles and URLs are sent directly from your browser to the AI provider you selected, using the API key you supplied. The extension has no server of its own; there is nothing in between you and that provider. Those providers' own privacy policies apply to what they receive:
  - Google Gemini API: https://ai.google.dev/gemini-api/terms
  - Anthropic: https://www.anthropic.com/privacy
  - OpenAI: https://openai.com/policies/privacy-policy

## What is stored

- Your settings and API key are stored in your browser's extension storage (`chrome.storage.sync`), which the browser may sync between your own devices if you're signed in. They are never sent to the developer.
- A short record of the last run (counts, errors) is stored locally for the settings page.

## What is not done

- No analytics, telemetry, or crash reporting.
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

## Contact

Varun Puskur — varun.puskur.dev@gmail.com
Source code: https://github.com/varunpuskur/tidy-tabs

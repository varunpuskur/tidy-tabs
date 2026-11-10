// The grouping code exactly as shipped in 1.8.0 (the store version before this work), kept so the
// benchmark can measure "before". Swapped into background.js by test/eval.js; never shipped.
module.exports = `
async function byAI(tabs, existingTitles, provider, apiKey, granularity = "balanced") {
  existingTitles = existingTitles.map((g) => (typeof g === "string" ? g : g.title));
  const list = tabs.map((t) => \`\${t.id}\\t\${(t.title || "").slice(0, 80)}\\t\${(t.url || "").slice(0, 120)}\`).join("\\n");
  const ex = tabs.slice(0, 3).map((t) => t.id);
  const example = ex.length >= 3 ? \`{"Example topic": [\${ex[0]}, \${ex[1]}], "Other": [\${ex[2]}]}\` : \`{"Example topic": [\${ex.join(", ")}]}\`;
  const n = tabs.length;
  const levels = {
    broad: { size: "Prefer a few large groups. A slightly broader name is fine when it lets a related tab join.", count: \`Aim for 2-4 groups.\`, max: 99 },
    balanced: {
      size: "Group by the specific project or activity, not the general field: \\"LeetCode\\" and \\"CS50\\" are different groups even though both are coding; \\"Flights\\" and \\"Hotels\\" can share a \\"Japan trip\\" group because they're one task.",
      count: \`Aim for \${Math.max(2, Math.min(8, Math.round(n / 4)))}-\${Math.max(3, Math.min(10, Math.round(n / 2.5)))} groups.\`, max: 8,
    },
    specific: {
      size: "Be precise. Each group is one concrete task, site, or subject: separate LeetCode problems from CS50 lectures from unrelated videos. Never merge different subjects just because they're both \\"work\\" or \\"coding\\".",
      count: \`Aim for \${Math.max(3, Math.min(10, Math.round(n / 3)))}-\${Math.max(4, Math.min(12, Math.round(n / 2)))} groups.\`, max: 5,
    },
  };
  const g = levels[granularity] || levels.balanced;
  const prompt = \`You are tidying a browser sidebar. Group these tabs by what the person is actually working on, the way they would organize them by hand.

Rules:
- Group names: 1-3 words, specific enough that a stranger would know what's inside.
- \${g.size}
- \${g.count} A group needs at least 2 tabs. No group may have more than \${g.max} tabs; if it would, split it by subtopic.
- Everyday tools (email inbox, calendar, drive, messaging, settings) do NOT belong in a topic group. Leave them in "Other" unless the title clearly ties them to a project.
- Unrelated one-off pages and random videos go in "Other" rather than being forced into the nearest group.
- AI chat tabs (ChatGPT, Claude, Gemini, etc.) go with the project their title is about, if one exists; otherwise "Other".
- Every tab id appears exactly once.\${existingTitles.length ? \`
- These groups already exist; reuse their exact names when a tab fits: \${existingTitles.join(", ")}.\` : ""}

\${await rulesBlock()}

Return ONLY a JSON object. Keys are group names you invent; values are arrays of the numeric ids from the list below. The shape is like \${example} but with your own group names and all \${n} ids.

id\\ttitle\\turl
\${list}\`;
  const ask = () => provider === "ondevice" ? askOnDevice(prompt) : provider === "gemini" ? askGemini(prompt, apiKey) : provider === "anthropic" ? askClaude(prompt, apiKey) : askOpenAI(prompt, apiKey);
  const validIds = new Set(tabs.map((t) => t.id));
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return parsePlan(await ask(), validIds); }
    catch (e) { lastErr = e; }
  }
  throw lastErr;
}

function parsePlan(text, validIds) {
  const m = (text || "").match(/\\{[\\s\\S]*\\}/);
  if (!m) throw new Error("Model returned no JSON");
  let plan;
  try { plan = JSON.parse(m[0]); } catch (e) { throw new Error("Model returned invalid JSON: " + errMsg(e)); }
  const clean = {};
  for (const [k, v] of Object.entries(plan)) {
    const ids = [].concat(v).map(Number).filter((id) => validIds.has(id));
    if (ids.length) clean[String(k).trim()] = ids;
  }
  if (!Object.keys(clean).length) throw new Error("Model returned a plan with no real tab ids");
  return clean;
}
`;

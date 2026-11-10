# Deploying the free-trial server (about 10 minutes, all in the browser)

The extension's first 5 tidies go through this Worker. It holds your Gemini key as a secret, so the key
never ships inside the extension, where anyone could unzip it and read it.

## 1. A Gemini key just for this
1. Go to https://aistudio.google.com/apikey and click **Create API key**. Make a new key; don't reuse your personal one.
2. Optional, later: click **Set up billing** on that project and set a budget alert (Google Cloud console > Billing > Budgets, say $5/month).
   - The free tier is fine to start: about 500 tidies a day per Flash-Lite model, and the Worker tries two. When it runs out, users see "out of capacity for today, add your own key" and nothing else breaks.
   - Why you might switch later: the free tier is shared by all your users, and Google may use free-tier prompts to improve its products. Paid tier is about $0.0002 per tidy (5,000 tidies is about $1) and isn't used for training.
   - The Worker also caps itself at 2,000 tidies a day, so the most it can cost is well under $1/day.

## 2. Cloudflare (free account, no card)
Free plan: 100,000 requests/day and 1,000 KV writes/day. Each trial tidy uses 3 or 4 writes, so about
250 trial tidies a day. Past that, the counters stop updating for the day (tidies still work);
Workers Paid ($5/month) lifts it.

1. Sign up at https://dash.cloudflare.com.
2. **Storage & Databases > KV > Create**. Name it `TRIAL`.
3. **Compute (Workers) > Create > Start with Hello World**. Name it `tidy-tabs`. Click **Deploy**.
4. Click **Edit code**, delete everything, paste all of `worker.js`, click **Deploy**.
5. Go to the Worker's **Settings**:
   - **Bindings > Add > KV namespace**: variable name `TRIAL`, namespace `TRIAL`.
   - **Variables and Secrets > Add**: type **Secret**, name `GEMINI_KEY`, value = the key from step 1.
   - Add another **Secret**: name `STATS_KEY`, value = any password you make up.
6. Your URL is shown at the top, like `https://tidy-tabs.yourname.workers.dev`. Open it: you should see `{"ok":true,"service":"tidy-tabs-trial"}`.

## 3. Build the extension with your URL
```
cd ~/code/tidy-tabs
./build.sh https://tidy-tabs.yourname.workers.dev
```
That writes the URL into background.js, runs the tests, and makes `tidy-tabs-store.zip` for the Web Store.

## Checking on it
- `https://tidy-tabs.yourname.workers.dev/stats?key=YOUR_STATS_KEY` shows tidies per day, first-time tidies
  (people who got the extension working), share-link clicks, and uninstall reasons with comments.
- Changing the limits: edit `LIMIT`, `IP_PER_DAY`, `GLOBAL_PER_DAY` at the top of worker.js and redeploy.

## If something goes wrong
- Extension says "free trial server didn't answer": open the Worker URL; check the `GEMINI_KEY` secret and the `TRIAL` binding.
- Gemini quota: the free tier ran out for the day. Turn on billing (step 1.2).

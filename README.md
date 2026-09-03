# tabanni Instagram Bot — Setup Guide

This is a small server that reads tabanni's Instagram DMs and replies automatically,
using Claude and the knowledge base in `src/knowledge.js`. It also detects when
*you* reply manually and pauses itself for that conversation so you don't double-reply.

You'll do three things: **(A)** create a Meta app and connect your Instagram
account, **(B)** deploy this server somewhere it can run 24/7, **(C)** connect
the two together.

---

## Testing with your team before going live on Instagram

You don't need the full Instagram/Meta setup just to let your team try the
bot. Once deployed (see Part B below), visit:

```
https://your-deployed-url/test.html
```

This is a simple web chat page — anyone with the link can talk to the exact
same bot brain (`src/knowledge.js`), no Claude account and no Instagram
needed. Your `ANTHROPIC_API_KEY` stays safely on the server the whole
time — the page never sees it.

For just this test page, you only need `ANTHROPIC_API_KEY` set in your
environment — you can skip the Instagram-specific variables (`PAGE_ACCESS_TOKEN`,
`IG_ACCOUNT_ID`, `VERIFY_TOKEN`) until you're ready for Part A/C below.

---

## A) Meta / Instagram setup

1. Go to **developers.facebook.com** and log in with the Facebook account
   linked to tabanni's Instagram professional account (Instagram must be set
   to a **Professional/Business account**, not personal — check
   Instagram app → Settings → Account type).
2. Click **My Apps → Create App**. Choose the **"Other"** use case, then
   app type **"Business"**.
3. In the app dashboard, find **Instagram** in the left sidebar and add the
   product **"API setup with Instagram login"** (this is the current path
   Meta uses to connect an Instagram professional account directly, without
   needing a separate Facebook Page).
4. Follow Meta's prompts to connect tabanni's Instagram account. This will
   generate:
   - An **Instagram professional account ID** → this is your `IG_ACCOUNT_ID`
   - An **access token** → this is your `PAGE_ACCESS_TOKEN`
   (Meta's UI names change over time — look for "Generate token" and
   "Instagram account ID" on that setup page.)
5. **Webhooks**: In the same Instagram product settings, find the Webhooks
   section. You'll enter:
   - **Callback URL**: `https://YOUR-DEPLOYED-URL/webhook` (you'll have this
     after step B)
   - **Verify token**: any string you make up — put the same string in your
     `.env` file as `VERIFY_TOKEN`
   - Subscribe to the **`messages`** field (this is what delivers DMs to you).
6. **App Review**: while testing, Meta lets you add up to 25 "test users"
   without review. To go fully live for the public, you'll need to submit
   for App Review requesting the `instagram_business_basic` and
   `instagram_business_manage_messages` permissions, with a short explanation
   of what the bot does. This usually takes a few days — plan for it.

---

## B) Deploy the server

You need this running somewhere reachable 24/7 with an HTTPS URL — your own
laptop won't work since it needs to always be on. Easiest free/cheap options:

- **Render.com** (free tier available, easiest for beginners)
- **Railway.app** (simple, usage-based pricing)
- Any small VPS if you're comfortable with servers

### Using Render (recommended for a first deploy)
1. Push this folder to a GitHub repo (or upload it directly if Render supports that).
2. On Render: **New → Web Service**, connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add all the variables from `.env.example` under Render's **Environment**
   tab, with your real values.
6. Deploy. Render will give you a URL like `https://tabanni-bot.onrender.com`
   — that's your base URL. Your webhook callback URL is
   `https://tabanni-bot.onrender.com/webhook`.

---

## C) Connect them

1. Go back to the Meta app's Webhooks section and paste in your real
   `https://your-url/webhook` as the Callback URL, plus your `VERIFY_TOKEN`.
2. Click **Verify and Save** — if it succeeds, your server is correctly
   receiving Meta's verification request.
3. Send a real DM to tabanni's Instagram from a test account and confirm you
   get a bot reply back.
4. Reply manually to that same test conversation from the Instagram app —
   confirm the bot goes quiet (check your server logs for "pausing bot for
   this conversation").

---

## Setting up Telegram notifications

When the bot flags a conversation for a volunteer (someone asks for Sereen,
asks for a human, or asks something the bot can't answer like a specific
animal's availability), it pings a Telegram chat so someone actually notices.
This takes about 5 minutes, no cost, no business verification needed.

### Step 1 — Create the bot
1. Open Telegram (app or web.telegram.org) and search for **@BotFather**
2. Send it `/newbot`
3. Give it a name (e.g. "tabanni Alerts") and a username ending in `bot`
   (e.g. `tabanni_alerts_bot`)
4. BotFather replies with a token that looks like `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`
   — this is your `TELEGRAM_BOT_TOKEN`

### Step 2 — Decide who gets notified
**Option A — a group chat (recommended for a team):**
1. Create a new Telegram group with whoever should see the alerts
2. Add your new bot to the group (search its username, add as member)
3. Send any message in the group, then visit this URL in your browser
   (replace `<TOKEN>` with your real token):
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Look for `"chat":{"id":-100123456789,...}` in the response — that negative
   number (including the minus sign) is your `TELEGRAM_CHAT_ID`

**Option B — just you, one-on-one:**
1. Search for your bot's username in Telegram and send it any message (e.g. "hi")
2. Visit the same `getUpdates` URL as above
3. Your `chat.id` will be a positive number this time — that's your `TELEGRAM_CHAT_ID`

### Step 3 — Add both values to your environment
Add `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in Render's Environment
settings (same place as your other variables), then redeploy.

### Step 4 — Test it
Open `/test.html` and type something like "can I speak to Sereen" — you
should get a Telegram message within a couple seconds. If nothing arrives,
check Render's logs for a line starting with "Telegram notification failed"
or "(Telegram not configured...)" to see what went wrong.

---

## Ready-to-post story images

Once an adoption intake is complete (all fields collected, including photos
and a video — see `knowledge.js`), the bot automatically generates a
finished, branded story image (1080x1920 PNG) from up to 4 of the photos
plus the pet's name, age, gender, vaccination status, a short story caption,
and phone number — and sends it to your Telegram group as a file, ready to
save and post directly to Instagram Stories.

- The layout code lives in `src/storyTemplate.js`. Colors, fonts, and
  positioning are all editable there if you want to adjust the look.
- Real font files are bundled in `/fonts` (Latin + Arabic) so text renders
  consistently regardless of the server's system fonts. Don't delete that
  folder.
- This uses the `sharp` image library, which is already in `package.json` —
  no extra setup needed, it installs automatically on deploy.
- If image generation fails for any reason (bad photo URL, network hiccup),
  the bot falls back to just sending the text summary, so an intake is never
  silently lost — check the logs for a "Story image generation failed"
  entry if this happens.
- The video (if one was sent) is NOT merged into the image — Instagram
  Stories are one image or one video, not both combined. Post the generated
  image first, then the raw video (already forwarded separately) as a
  second story slide right after.

## Editing the bot's brain

Everything about tone and knowledge lives in `src/knowledge.js` — edit the
`SYSTEM_PROMPT` text and redeploy any time you want to change how it talks or
add new answers. No other file needs to change for that.

## Manually pausing/resuming a conversation

Until you have a dashboard, you can trigger this with curl (replace values):

```bash
curl -X POST https://your-url/admin/pause \
  -H "Content-Type: application/json" \
  -H "x-admin-secret: YOUR_ADMIN_SECRET" \
  -d '{"userId": "the_igsid_from_your_logs"}'
```

Use `/admin/resume` the same way to un-pause.

## Notes & limits worth knowing

- Instagram's API only lets you freely message someone within **24 hours**
  of their last message to you. After that, only limited "human agent"
  replies are allowed for a further window — automated bot replies outside
  the 24-hour window aren't permitted by Meta's rules.
- The auto-pause after your manual reply lasts `AUTO_PAUSE_MINUTES` (default
  60) — adjust in `.env`.
- Conversation memory currently resets if the server restarts (it's stored
  in memory, not a database). Fine to start; let me know if you want it
  made persistent later.

require('dotenv').config();
const express = require('express');
const {
  isPaused,
  pauseAfterHumanReply,
  setManualPause,
  addUserMessage,
  addAssistantMessage,
  getHistory,
} = require('./conversationState');
const { sendInstagramMessage, getClaudeReply } = require('./apis');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ---------------------------------------------------------------------------
// Team test page — a simple web chat at /test.html for your team to try the
// bot's brain in a browser, no Instagram or Claude account needed. The
// Anthropic API key stays on the server the whole time; this endpoint is
// the only thing the test page talks to.
// ---------------------------------------------------------------------------
app.post('/api/test-chat', async (req, res) => {
  try {
    const history = Array.isArray(req.body.history) ? req.body.history : [];
    const reply = await getClaudeReply(history);
    const HANDOFF_MARKER = '[[HANDOFF]]';
    let outgoingText = reply;
    let handoff = false;
    if (reply.startsWith(HANDOFF_MARKER)) {
      handoff = true;
      outgoingText = reply.slice(HANDOFF_MARKER.length).trim();
    }
    res.json({ reply: outgoingText, handoff });
  } catch (err) {
    console.error('Test chat error:', err);
    res.status(500).json({ reply: "Something went wrong — check server logs.", handoff: false });
  }
});

// ---------------------------------------------------------------------------
// 1) Webhook verification — Meta calls this once when you set up the webhook
//    in the App Dashboard, to confirm you control this server.
// ---------------------------------------------------------------------------
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
    console.log('Webhook verified.');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------------------------------------------------------------------------
// 2) Webhook events — every incoming DM (and every message YOU send from the
//    Instagram app itself, delivered back as an "echo") arrives here.
// ---------------------------------------------------------------------------
app.post('/webhook', async (req, res) => {
  // Always respond fast so Meta doesn't retry/duplicate the event.
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== 'instagram') return;

  for (const entry of body.entry || []) {
    for (const event of entry.messaging || []) {
      try {
        await handleMessagingEvent(event);
      } catch (err) {
        console.error('Error handling event:', err);
      }
    }
  }
});

async function handleMessagingEvent(event) {
  const senderId = event.sender?.id;
  const message = event.message;
  if (!message || !senderId) return;

  // --- Human handoff: is this message an "echo" of something YOU sent ---
  // manually from the Instagram app (not the bot)? If so, pause the bot on
  // this conversation instead of treating it as a customer message.
  if (message.is_echo) {
    pauseAfterHumanReply(senderId);
    console.log(`Detected manual reply to ${senderId} — pausing bot for this conversation.`);
    return;
  }

  const userText = message.text;
  if (!userText) return; // ignore stickers/attachments-only messages for now

  addUserMessage(senderId, userText);

  if (isPaused(senderId)) {
    console.log(`Conversation with ${senderId} is paused — bot staying quiet.`);
    return;
  }

  const reply = await getClaudeReply(getHistory(senderId));
  addAssistantMessage(senderId, reply);

  // --- Human handoff: did Claude flag this as something it can't safely ---
  // answer (e.g. real-time animal availability)? If so, strip the silent
  // marker, send the warm acknowledgement anyway, then pause the bot on
  // this conversation so a volunteer picks up the actual answer.
  const HANDOFF_MARKER = '[[HANDOFF]]';
  let outgoingText = reply;
  let needsHandoff = false;
  if (reply.startsWith(HANDOFF_MARKER)) {
    needsHandoff = true;
    outgoingText = reply.slice(HANDOFF_MARKER.length).trim();
  }

  await sendInstagramMessage(senderId, outgoingText);

  if (needsHandoff) {
    setManualPause(senderId, true);
    // TODO: once you're ready, replace this log with a real notification —
    // e.g. an email via a transactional mail API, or a Slack/WhatsApp
    // webhook — so a volunteer actually sees this instead of only the logs.
    console.log(`⚠️ Conversation with ${senderId} flagged for a volunteer — bot paused. Reply manually, then resume via /admin/resume when done.`);
  }
}

// ---------------------------------------------------------------------------
// 3) Admin controls — pause/resume a conversation manually. This is meant to
//    be called from a small internal tool or even just curl/Postman for now;
//    wire up a real dashboard button later if you want.
// ---------------------------------------------------------------------------
function checkAdminSecret(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (provided !== process.env.ADMIN_SECRET) return res.sendStatus(401);
  next();
}

app.post('/admin/pause', checkAdminSecret, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  setManualPause(userId, true);
  res.json({ ok: true, userId, paused: true });
});

app.post('/admin/resume', checkAdminSecret, (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  setManualPause(userId, false);
  res.json({ ok: true, userId, paused: false });
});

// Simple health check for your hosting provider.
app.get('/', (req, res) => res.send('tabanni bot is running 🐾'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`tabanni bot listening on port ${PORT}`));

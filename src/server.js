require('dotenv').config();
const express = require('express');
const {
  isPaused,
  pauseAfterHumanReply,
  setManualPause,
  addUserMessage,
  addAssistantMessage,
  getHistory,
  markBotMessageId,
  wasSentByBot,
} = require('./conversationState');
const { sendInstagramMessage, getClaudeReply, sendTelegramNotification, getInstagramUserProfile, sendTelegramPhoto, sendTelegramVideo } = require('./apis');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// Instagram rejects any single message over 1000 characters. Rather than let
// that fail outright, split long replies into multiple messages sent one
// after another, breaking at paragraph/sentence/word boundaries so it still
// reads naturally instead of getting cut mid-word.
const INSTAGRAM_MAX_MESSAGE_LENGTH = 950; // a little under 1000 for safety margin
function splitForInstagram(text, maxLen = INSTAGRAM_MAX_MESSAGE_LENGTH) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text.trim();
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n\n', maxLen);
    if (splitAt < maxLen * 0.4) splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.4) splitAt = remaining.lastIndexOf('. ', maxLen);
    if (splitAt > 0 && remaining[splitAt] === '.') splitAt += 1; // keep the period with the chunk
    if (splitAt < maxLen * 0.4) splitAt = remaining.lastIndexOf(' ', maxLen);
    if (splitAt <= 0) splitAt = maxLen; // last resort: hard cut
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// Sends a (possibly long) reply to Instagram as one or more messages, and
// marks every chunk's message ID so the bot recognizes its own echoes.
async function sendInstagramReply(senderId, text) {
  const chunks = splitForInstagram(text);
  for (const chunk of chunks) {
    const sendResult = await sendInstagramMessage(senderId, chunk);
    markBotMessageId(sendResult?.messageId);
  }
}

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
      const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
      await sendTelegramNotification(
        `🧪 [TEST PAGE] tabanni bot flagged a conversation for a volunteer.\n\nLast message: "${lastUserMsg ? lastUserMsg.content : '(unknown)'}"\n\nThis came from the /test.html team test page, not real Instagram.`
      );
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

  // --- Human handoff: is this message an "echo" of something a HUMAN sent ---
  // manually from the Instagram app? Instagram echoes back EVERY message sent
  // from your account, including the bot's own replies — so we check whether
  // this specific message ID is one the bot just sent itself. If so, ignore
  // it silently. If it's an echo the bot doesn't recognize, a human really
  // did send it manually, so pause the bot on this conversation.
  if (message.is_echo) {
    if (wasSentByBot(message.mid)) {
      return; // this is just our own reply bouncing back — not a human reply
    }
    pauseAfterHumanReply(senderId);
    console.log(`Detected manual reply to ${senderId} — pausing bot for this conversation.`);
    return;
  }

  const userText = message.text;

  // --- Photo/video forwarding: if they sent media (adoption-story photos, ---
  // injured-animal photos, lost/found photos, etc.), forward it straight to
  // Telegram so the team has it ready to grab, regardless of whether there's
  // also text in this message.
  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    const profile = await getInstagramUserProfile(senderId);
    const displayName = profile?.username ? `@${profile.username}` : (profile?.name || `IGSID ${senderId}`);
    for (const att of message.attachments) {
      const attUrl = att?.payload?.url;
      if (!attUrl) continue;
      const caption = `📸 From ${displayName}${userText ? `\n"${userText}"` : ''}`;
      if (att.type === 'image') {
        await sendTelegramPhoto(caption, attUrl);
      } else if (att.type === 'video') {
        await sendTelegramVideo(caption, attUrl);
      }
    }
  }

  if (!userText) return; // ignore attachment-only messages for the text/reply logic below

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

  await sendInstagramReply(senderId, outgoingText);

  if (needsHandoff) {
    setManualPause(senderId, true);
    console.log(`⚠️ Conversation with ${senderId} flagged for a volunteer — bot paused.`);

    const profile = await getInstagramUserProfile(senderId);
    const displayName = profile?.username
      ? `@${profile.username}`
      : (profile?.name || `IGSID ${senderId}`);

    await sendTelegramNotification(
      `🐾 tabanni bot needs a volunteer!\n\nFrom: ${displayName}\nMessage: "${userText}"\n\nOpen Instagram DMs to reply — the bot is paused on this conversation until you resume it (see README for /admin/resume).`
    );
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

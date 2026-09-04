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
  addPhotoUrl,
  getPhotoUrls,
  claimIncomingMessage,
} = require('./conversationState');
const { sendInstagramMessage, getClaudeReply, sendTelegramNotification, getInstagramUserProfile, sendTelegramPhoto, sendTelegramVideo, sendTelegramSpacer, sendTelegramStoryImage, sendTelegramMediaGroup, editTelegramMessageReplyMarkup, answerTelegramCallbackQuery, queueTelegramCall } = require('./apis');
const { generateStoryImage } = require('./storyTemplate');

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
    await markBotMessageId(sendResult?.messageId);
  }
}

// The [[INTAKE]] marker is different from [[HANDOFF]] and [[FLAG]]: it wraps
// a structured summary block, followed by the actual reply to send the
// person. Format: [[INTAKE]]...summary...[[/INTAKE]]reply text here
// Returns null if the reply doesn't start with [[INTAKE]] or is malformed.
const INTAKE_MARKER_START = '[[INTAKE]]';
const INTAKE_MARKER_END = '[[/INTAKE]]';
function parseIntakeMarker(reply) {
  if (!reply.startsWith(INTAKE_MARKER_START)) return null;
  const endIdx = reply.indexOf(INTAKE_MARKER_END);
  if (endIdx === -1) return null;
  const summary = reply.slice(INTAKE_MARKER_START.length, endIdx).trim();
  const outgoingText = reply.slice(endIdx + INTAKE_MARKER_END.length).trim();
  return { summary, outgoingText };
}

// Pulls the labeled fields (Name, Type, Age, Gender, Vaccination status,
// Phone number, Story) out of the [[INTAKE]] summary block, so they can be
// passed to the story image generator as structured data instead of raw
// text. Matches the format defined in knowledge.js — if that format ever
// changes, update the labels here to match.
function parseIntakeFields(summary) {
  const getField = (label) => {
    const re = new RegExp(`${label}\\s*:\\s*(.+)`, 'i');
    const match = summary.match(re);
    return match ? match[1].trim() : '';
  };
  return {
    name: getField('Name') || getField('🐾 Name'),
    animalType: getField('Type'),
    age: getField('Age'),
    gender: getField('Gender'),
    vaccination: getField('Vaccination status'),
    phone: getField('Phone number'),
    story: getField('Story'),
  };
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
    const FLAG_MARKER = '[[FLAG]]';
    let outgoingText = reply;
    let handoff = false;
    let intake = false;
    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');

    const intakeParsed = parseIntakeMarker(reply);
    if (intakeParsed) {
      intake = true;
      outgoingText = intakeParsed.outgoingText;
      await sendTelegramNotification(
        `🧪🐾🆕 [TEST PAGE] New adoption intake ready to post!\n\n${intakeParsed.summary}\n\nThis came from the /test.html team test page, not real Instagram.`
      );
      await sendTelegramSpacer();
    } else if (reply.startsWith(HANDOFF_MARKER)) {
      handoff = true;
      outgoingText = reply.slice(HANDOFF_MARKER.length).trim();
      await sendTelegramNotification(
        `🧪 [TEST PAGE] tabanni bot flagged a conversation for a volunteer.\n\nLast message: "${lastUserMsg ? lastUserMsg.content : '(unknown)'}"\n\nThis came from the /test.html team test page, not real Instagram.`
      );
      await sendTelegramSpacer();
    } else if (reply.startsWith(FLAG_MARKER)) {
      outgoingText = reply.slice(FLAG_MARKER.length).trim();
      await sendTelegramNotification(
        `🧪🚩 [TEST PAGE] tabanni bot flagged a conversation.\n\nLast message: "${lastUserMsg ? lastUserMsg.content : '(unknown)'}"\n\nThis came from the /test.html team test page, not real Instagram.`
      );
      await sendTelegramSpacer();
    }
    res.json({ reply: outgoingText, handoff, intake });
  } catch (err) {
    console.error('Test chat error:', err);
    res.status(500).json({ reply: "Something went wrong — check server logs.", handoff: false });
  }
});

// ---------------------------------------------------------------------------
// Telegram webhook — receives button-tap events (the "posted / not posted"
// checkbox on story images). Separate from the Instagram webhook above.
// One-time setup required — see README.
// ---------------------------------------------------------------------------
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);

  const callbackQuery = req.body?.callback_query;
  if (!callbackQuery) return;

  if (callbackQuery.data === 'toggle_posted') {
    const currentText = callbackQuery.message?.reply_markup?.inline_keyboard?.[0]?.[0]?.text || '';
    const isCurrentlyPosted = currentText.includes('✅');
    const newText = isCurrentlyPosted ? '☐ Not posted yet' : '✅ Posted to Instagram';
    const newMarkup = { inline_keyboard: [[{ text: newText, callback_data: 'toggle_posted' }]] };

    await editTelegramMessageReplyMarkup(callbackQuery.message.chat.id, callbackQuery.message.message_id, newMarkup);
    await answerTelegramCallbackQuery(callbackQuery.id, isCurrentlyPosted ? 'Marked as not posted' : 'Marked as posted!');
  } else {
    await answerTelegramCallbackQuery(callbackQuery.id);
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

// --- Media batching: when photos/videos arrive, wait up to this long for ---
// more to come in before forwarding everything to Telegram together and
// generating one reply, instead of reacting to every single photo
// separately. Matches how people actually send a batch of photos: several
// quick messages in a row, not one at a time with pauses.
const MEDIA_BATCH_WINDOW_MS = 100 * 1000;
const pendingMediaBatches = new Map(); // senderId -> { items: [{url,type}], texts: [string], timer }

async function handleMessagingEvent(event) {
  const senderId = event.sender?.id;
  const message = event.message;
  if (!message || !senderId) return;

  // --- Deduplication: Instagram/Meta can redeliver the same webhook event ---
  // (most commonly when Render's free tier is slow to wake up from sleep and
  // Meta doesn't get a fast enough response). Without this, a redelivered
  // message gets processed twice — two Claude API calls, two identical
  // replies sent to the person, double the cost. This claims the message ID
  // atomically; if it's already been claimed (a genuine duplicate), stop
  // here immediately before doing anything else.
  if (!(await claimIncomingMessage(message.mid))) {
    console.log(`Skipped duplicate delivery of message ${message.mid} — already processed.`);
    return;
  }

  // --- Human handoff: is this message an "echo" of something a HUMAN sent ---
  // manually from the Instagram app? Instagram echoes back EVERY message sent
  // from your account, including the bot's own replies — so we check whether
  // this specific message ID is one the bot just sent itself. If so, ignore
  // it silently. If it's an echo the bot doesn't recognize, a human really
  // did send it manually, so pause the bot on this conversation.
  if (message.is_echo) {
    if (await wasSentByBot(message.mid)) {
      return; // this is just our own reply bouncing back — not a human reply
    }
    await pauseAfterHumanReply(senderId);
    console.log(`Detected manual reply to ${senderId} — pausing bot for this conversation.`);
    return;
  }

  const userText = message.text;
  const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;

  if (hasAttachments) {
    // Buffer this media instead of processing immediately — see flushMediaBatch.
    let batch = pendingMediaBatches.get(senderId);
    if (!batch) {
      batch = { items: [], texts: [], timer: null };
      pendingMediaBatches.set(senderId, batch);
      batch.timer = setTimeout(() => {
        flushMediaBatch(senderId).catch((err) => console.error('Media batch flush error:', err));
      }, MEDIA_BATCH_WINDOW_MS);
    }
    for (const att of message.attachments) {
      const attUrl = att?.payload?.url;
      if (!attUrl) continue;
      if (att.type === 'image' || att.type === 'video') {
        batch.items.push({ url: attUrl, type: att.type });
      }
    }
    if (userText) batch.texts.push(userText);
    console.log(`Buffered ${message.attachments.length} attachment(s) for ${senderId} — will flush in up to ${MEDIA_BATCH_WINDOW_MS / 1000}s.`);
    return;
  }

  // A real text message arrived. If there's a media batch waiting for this
  // same person, flush it first (so photos get handled in the order they
  // actually came in), then continue with this text message normally.
  if (pendingMediaBatches.has(senderId)) {
    await flushMediaBatch(senderId);
  }

  if (!userText) return; // nothing to respond to (e.g. a sticker with no attachments array)

  await processTurn(senderId, userText);
}

// Called once the 100-second window closes: forwards everything collected
// as one grouped album, tracks photo URLs for story generation, then
// processes it as a single turn (same as a normal text message).
async function flushMediaBatch(senderId) {
  const batch = pendingMediaBatches.get(senderId);
  if (!batch) return;
  pendingMediaBatches.delete(senderId);
  if (batch.timer) clearTimeout(batch.timer);
  if (batch.items.length === 0) return;

  if (await isPaused(senderId)) {
    console.log(`Conversation with ${senderId} is paused — dropping buffered media batch without replying.`);
    return;
  }

  const profile = await getInstagramUserProfile(senderId);
  const displayName = profile?.username ? `@${profile.username}` : (profile?.name || `IGSID ${senderId}`);

  const photoCount = batch.items.filter((i) => i.type === 'image').length;
  const videoCount = batch.items.filter((i) => i.type === 'video').length;

  const caption = `📸 From ${displayName}${batch.texts.length ? `\n"${batch.texts.join(' ')}"` : ''}`;
  await sendTelegramMediaGroup(caption, batch.items);

  for (const item of batch.items) {
    if (item.type === 'image') await addPhotoUrl(senderId, item.url);
  }

  const kindParts = [];
  if (photoCount) kindParts.push(`${photoCount} photo(s)`);
  if (videoCount) kindParts.push(`${videoCount} video(s)`);
  const attachmentNote = `[sent ${kindParts.join(' and ')}]`;
  const effectiveText = batch.texts.length ? `${batch.texts.join(' ')} ${attachmentNote}` : attachmentNote;

  await processTurn(senderId, effectiveText, displayName);
}

// Shared logic for handling one "turn": add the message to history, ask
// Claude for a reply, act on any [[HANDOFF]] / [[FLAG]] / [[INTAKE]]
// marker, send the reply, and fire the right Telegram notification. Used
// by both a normal text message and a flushed media batch, so behavior is
// identical either way.
async function processTurn(senderId, effectiveText, precomputedDisplayName) {
  await addUserMessage(senderId, effectiveText);

  if (await isPaused(senderId)) {
    console.log(`Conversation with ${senderId} is paused — bot staying quiet.`);
    return;
  }

  const reply = await getClaudeReply(await getHistory(senderId));
  await addAssistantMessage(senderId, reply);

  // --- Human handoff: did Claude flag this as something it can't safely ---
  // answer (e.g. real-time animal availability)? If so, strip the silent
  // marker, send the warm acknowledgement anyway, then pause the bot on
  // this conversation so a volunteer picks up the actual answer.
  const HANDOFF_MARKER = '[[HANDOFF]]';
  // --- Flag: same as HANDOFF — pauses the bot on this conversation for ---
  // 24 hours and notifies the team. Used for things that need a human's
  // attention (e.g. an abuse report), just with different Telegram wording
  // than a general handoff.
  const FLAG_MARKER = '[[FLAG]]';
  let outgoingText = reply;
  let needsHandoff = false;
  let needsFlag = false;
  let intakeSummary = null;

  const intakeParsed = parseIntakeMarker(reply);
  if (intakeParsed) {
    intakeSummary = intakeParsed.summary;
    outgoingText = intakeParsed.outgoingText;
  } else if (reply.startsWith(HANDOFF_MARKER)) {
    needsHandoff = true;
    outgoingText = reply.slice(HANDOFF_MARKER.length).trim();
  } else if (reply.startsWith(FLAG_MARKER)) {
    needsFlag = true;
    outgoingText = reply.slice(FLAG_MARKER.length).trim();
  }

  await sendInstagramReply(senderId, outgoingText);

  const getDisplayName = async () => {
    if (precomputedDisplayName) return precomputedDisplayName;
    const profile = await getInstagramUserProfile(senderId);
    return profile?.username ? `@${profile.username}` : (profile?.name || `IGSID ${senderId}`);
  };

  if (needsHandoff) {
    await setManualPause(senderId, true);
    console.log(`⚠️ Conversation with ${senderId} flagged for a volunteer — bot paused.`);

    const displayName = await getDisplayName();

    // The whole block (notification + spacer) runs as ONE atomic unit on
    // the shared Telegram queue, so it can never get split up by another
    // conversation's messages landing in between.
    await queueTelegramCall(async () => {
      await sendTelegramNotification(
        `🐾 tabanni bot needs a volunteer!\n\nFrom: ${displayName}\nMessage: "${effectiveText}"\n\nOpen Instagram DMs to reply — the bot is paused on this conversation until you resume it (see README for /admin/resume).`
      );
      await sendTelegramSpacer();
    });
  } else if (needsFlag) {
    await setManualPause(senderId, true);
    console.log(`🚩 Conversation with ${senderId} flagged — bot paused.`);

    const displayName = await getDisplayName();

    await queueTelegramCall(async () => {
      await sendTelegramNotification(
        `🚩 tabanni bot flagged a conversation!\n\nFrom: ${displayName}\nMessage: "${effectiveText}"\n\nThe bot is paused on this conversation until you resume it (see README for /admin/resume).`
      );
      await sendTelegramSpacer();
    });
  } else if (intakeSummary) {
    console.log(`🆕 Adoption intake ready for ${senderId} — generating story image.`);

    const displayName = await getDisplayName();

    // Do the slow part (fetching photos, compositing the image) BEFORE
    // touching the Telegram queue, so this conversation's image generation
    // time doesn't hold up other conversations' Telegram messages. Only
    // the actual sends get queued as one atomic block below.
    let imageBuffer = null;
    let fields = null;
    let imageGenError = null;
    try {
      fields = parseIntakeFields(intakeSummary);
      const allPhotoUrls = await getPhotoUrls(senderId);
      const photoUrls = allPhotoUrls.slice(-4); // most recent 4
      if (photoUrls.length > 0 && fields.name) {
        imageBuffer = await generateStoryImage({
          photoUrls,
          name: fields.name,
          animalType: fields.animalType,
          age: fields.age,
          gender: fields.gender,
          vaccination: fields.vaccination,
          story: fields.story,
          phone: fields.phone,
        });
      } else {
        console.log(`Skipped story image for ${senderId}: missing photos or name.`);
      }
    } catch (err) {
      console.error('Story image generation failed:', err);
      imageGenError = err;
    }

    await queueTelegramCall(async () => {
      await sendTelegramNotification(
        `🐾🆕 New adoption intake ready to post!\n\nFrom: ${displayName}\n\n${intakeSummary}`
      );

      if (imageBuffer && fields) {
        await sendTelegramStoryImage(
          `🖼️ Ready-to-post story card for ${fields.name} — save and add to Instagram Stories. Tap the checkbox below once it is posted.`,
          imageBuffer,
          `tabanni_story_${fields.name.replace(/\s+/g, '_')}.png`
        );
      } else if (imageGenError) {
        await sendTelegramNotification('⚠️ Could not auto-generate the story image for the intake above — please build it manually this time.');
      }

      await sendTelegramSpacer();
    });

    // The intake task itself is done — your team's Telegram record now has
    // everything needed (text summary + story image + checkbox to track
    // posting), so there's nothing further for the TEAM to do on this
    // conversation unless they choose to. But the bot stays fully active
    // and keeps replying normally if the person messages again (e.g. to
    // say thanks, or ask something else) — it is not paused.
    console.log(`✅ Adoption intake fully sent to Telegram for ${senderId} — bot remains active for this conversation.`);
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

app.post('/admin/pause', checkAdminSecret, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  await setManualPause(userId, true);
  res.json({ ok: true, userId, paused: true });
});

app.post('/admin/resume', checkAdminSecret, async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  await setManualPause(userId, false);
  res.json({ ok: true, userId, paused: false });
});

// Simple health check for your hosting provider.
app.get('/', (req, res) => res.send('tabanni bot is running 🐾'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`tabanni bot listening on port ${PORT}`));

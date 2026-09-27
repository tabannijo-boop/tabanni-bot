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
const { sendInstagramMessage, getClaudeReply, sendTelegramNotification, getInstagramUserProfile, sendTelegramPhoto, sendTelegramVideo, sendTelegramSpacer, sendTelegramStoryImage, sendTelegramMediaGroup, editTelegramMessageReplyMarkup, answerTelegramCallbackQuery, queueTelegramCall, sendTelegramAlertPhoto, sendTelegramNotificationWithButton } = require('./apis');
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

// Same idea for the [[NURSING]] marker — a structured phone-number block
// followed by the actual reply. Defined once here (module scope) so it can
// be reused both by processTurn's marker handling and by the language
// verification step below, instead of being redefined every call.
const NURSING_MARKER_START = '[[NURSING]]';
const NURSING_MARKER_END = '[[/NURSING]]';
function parseNursingMarker(reply) {
  if (!reply.startsWith(NURSING_MARKER_START)) return null;
  const endIdx = reply.indexOf(NURSING_MARKER_END);
  if (endIdx === -1) return null;
  const summary = reply.slice(NURSING_MARKER_START.length, endIdx).trim();
  const outgoing = reply.slice(endIdx + NURSING_MARKER_END.length).trim();
  const phoneMatch = summary.match(/Phone number\s*:\s*(.+)/i);
  return { phone: phoneMatch ? phoneMatch[1].trim() : '', outgoingText: outgoing };
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

// --- Language enforcement -------------------------------------------------
// The prompt already instructs Claude to match the person's language, but
// that's not 100% reliable on its own. This adds a real code-level check:
// after getting a reply, compare the language of the person's last message
// against the language of the actual outgoing (user-facing) text, and if
// they don't match, retry once with an explicit correction.

// Strips off any [[MARKER]]...[[/MARKER]] or [[MARKER]] tag, wherever it
// appears in the reply, and returns just the part that will actually be
// sent to the person — that's the only part that needs to match their
// language (structured summaries like the intake fields are internal, in
// English on purpose, and should not be checked). Using a global find/strip
// rather than requiring the marker to be a strict prefix, since the model
// can occasionally place it elsewhere in the reply.
function extractOutgoingText(reply) {
  const intake = parseIntakeMarker(reply);
  if (intake) return intake.outgoingText;
  const nursing = parseNursingMarker(reply);
  if (nursing) return nursing.outgoingText;
  return reply.split('[[HANDOFF]]').join('').split('[[FLAG]]').join('').trim();
}

// Simple language detector: counts Arabic-script characters vs Latin
// letters. Returns 'ar', 'en', or null if the text is too ambiguous to
// tell (e.g. just a phone number or emoji) — in that case we skip the
// check rather than force a language based on no real signal.
function detectLanguage(text) {
  if (!text) return null;
  const arabicChars = (text.match(/[\u0600-\u06FF]/g) || []).length;
  const latinChars = (text.match(/[A-Za-z]/g) || []).length;
  if (arabicChars === 0 && latinChars === 0) return null;
  return arabicChars > latinChars ? 'ar' : 'en';
}

// Wraps getClaudeReply with a language check + one automatic retry if the
// reply came back in the wrong language. This is the real fix for language
// mismatches — a prompt instruction alone was not reliable enough on its
// own, this actually verifies the output before it gets sent.
async function getVerifiedClaudeReply(history) {
  const reply = await getClaudeReply(history);

  const lastUserMsg = [...history].reverse().find((m) => m.role === 'user');
  const expectedLang = detectLanguage(lastUserMsg?.content);
  const actualLang = detectLanguage(extractOutgoingText(reply));

  if (expectedLang && actualLang && expectedLang !== actualLang) {
    const languageNames = { ar: 'Arabic', en: 'English' };
    console.log(`⚠️ Language mismatch detected (expected ${languageNames[expectedLang]}, got ${languageNames[actualLang]}) — retrying once.`);
    const correctionNote = `CRITICAL CORRECTION: your previous reply was in the wrong language. The person's most recent message was in ${languageNames[expectedLang]}. Rewrite your ENTIRE reply in ${languageNames[expectedLang]} only, keeping the same meaning and keeping any [[MARKER]] you used exactly as it was. Do not mix languages.`;
    const retryReply = await getClaudeReply(history, correctionNote);
    const retryLang = detectLanguage(extractOutgoingText(retryReply));
    if (retryLang === expectedLang) {
      console.log(`✅ Language corrected on retry.`);
    } else {
      console.log(`⚠️ Retry still did not match the expected language — sending it anyway (best effort, no further retries).`);
    }
    return retryReply;
  }

  return reply;
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
    const reply = await getVerifiedClaudeReply(history);
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
      await sendTelegramNotificationWithButton(
        `🧪🐾🆕 [TEST PAGE] New adoption intake ready to post!\n\n${intakeParsed.summary}\n\nThis came from the /test.html team test page, not real Instagram.`,
        'toggle_handled',
        '☐ Not handled yet'
      );
      await sendTelegramSpacer();
    } else if (reply.includes(HANDOFF_MARKER)) {
      handoff = true;
      outgoingText = reply.split(HANDOFF_MARKER).join('').trim();
      await sendTelegramNotificationWithButton(
        `🧪 [TEST PAGE] tabanni bot flagged a conversation for a volunteer.\n\nLast message: "${lastUserMsg ? lastUserMsg.content : '(unknown)'}"\n\nThis came from the /test.html team test page, not real Instagram.`,
        'toggle_handled',
        '☐ Not handled yet'
      );
      await sendTelegramSpacer();
    } else if (reply.includes(FLAG_MARKER)) {
      outgoingText = reply.split(FLAG_MARKER).join('').trim();
      await sendTelegramNotificationWithButton(
        `🧪🚩 [TEST PAGE] tabanni bot flagged a conversation.\n\nLast message: "${lastUserMsg ? lastUserMsg.content : '(unknown)'}"\n\nThis came from the /test.html team test page, not real Instagram.`,
        'toggle_handled',
        '☐ Not handled yet'
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
// Telegram webhook — receives button-tap events (the checkboxes on story
// images, nursing-mom alerts, handoffs, flags, and voice-note alerts).
// Separate from the Instagram webhook above. One-time setup required —
// see README.
// ---------------------------------------------------------------------------
app.post('/telegram-webhook', async (req, res) => {
  res.sendStatus(200);

  const callbackQuery = req.body?.callback_query;
  if (!callbackQuery) return;

  const TOGGLE_CONFIG = {
    toggle_posted: { off: '☐ Not posted yet', on: '✅ Posted to Instagram', onMsg: 'Marked as posted!', offMsg: 'Marked as not posted' },
    toggle_nursing: { off: '☐ Not handled yet', on: '✅ Handled', onMsg: 'Marked as handled!', offMsg: 'Marked as not handled' },
    toggle_handled: { off: '☐ Not handled yet', on: '✅ Handled by team', onMsg: 'Marked as handled!', offMsg: 'Marked as not handled' },
  };

  const config = TOGGLE_CONFIG[callbackQuery.data];
  if (config) {
    const currentText = callbackQuery.message?.reply_markup?.inline_keyboard?.[0]?.[0]?.text || '';
    const isOn = currentText === config.on;
    const newText = isOn ? config.off : config.on;
    const newMarkup = { inline_keyboard: [[{ text: newText, callback_data: callbackQuery.data }]] };

    await editTelegramMessageReplyMarkup(callbackQuery.message.chat.id, callbackQuery.message.message_id, newMarkup);
    await answerTelegramCallbackQuery(callbackQuery.id, isOn ? config.offMsg : config.onMsg);
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
  const mediaAttachments = Array.isArray(message.attachments)
    ? message.attachments.filter((a) => a.type === 'image' || a.type === 'video')
    : [];
  const otherAttachments = Array.isArray(message.attachments)
    ? message.attachments.filter((a) => a.type !== 'image' && a.type !== 'video')
    : [];
  const hasAttachments = mediaAttachments.length > 0;

  // Voice notes, story mentions, post/reel shares, or any other attachment
  // type we cannot process automatically (Meta labels these with types
  // like audio, story_mention, share, ig_post, reel, ig_reel — none of
  // which are image/video, so they land here rather than being treated as
  // real photos/videos): goes straight to a volunteer with a general
  // acknowledgment, instead of trying to handle it automatically. Bypasses
  // Claude entirely for speed/reliability.
  if (!hasAttachments && otherAttachments.length > 0) {
    if (pendingMediaBatches.has(senderId)) {
      await flushMediaBatch(senderId);
    }

    // Sent in both languages together, since there's often no text to
    // detect a language from (e.g. a bare story mention with no caption).
    const ackText = 'شكراً لرسالتكم سيتم الرد عليكم من قبل احد متطوعين تبني بأسرع وقت ممكن\n\nThank you for your message. One of tabanni\'s volunteers will get back to you as soon as possible.';
    await sendInstagramReply(senderId, ackText);

    await setManualPause(senderId, true);
    console.log(`🎙️ Voice note/unsupported attachment from ${senderId} — bot paused, team alerted.`);

    const profile = await getInstagramUserProfile(senderId);
    const displayName = profile?.username ? `@${profile.username}` : (profile?.name || `IGSID ${senderId}`);

    await queueTelegramCall(async () => {
      await sendTelegramNotificationWithButton(
        `🎙️ tabanni bot needs a volunteer!\n\nFrom: ${displayName}\nSent a voice note or unsupported file type${userText ? `\nMessage text: "${userText}"` : ''}\n\nOpen Instagram DMs to listen and reply — the bot is paused on this conversation until you resume it (see README for /admin/resume).`,
        'toggle_handled',
        '☐ Not handled yet'
      );
      await sendTelegramSpacer();
    });
    return;
  }

  if (hasAttachments) {
    // Buffer this media instead of processing immediately — see flushMediaBatch.
    let batch = pendingMediaBatches.get(senderId);
    if (!batch) {
      batch = { items: [], texts: [], timer: null };
      pendingMediaBatches.set(senderId, batch);
    }
    // Reset the timer on every new arrival — this makes it a rolling
    // "100 seconds of silence" window instead of a fixed one-shot window
    // from the first photo, so someone sending photos in slow bursts over
    // several minutes still gets bundled into ONE batch, not several.
    if (batch.timer) clearTimeout(batch.timer);
    batch.timer = setTimeout(() => {
      flushMediaBatch(senderId).catch((err) => console.error('Media batch flush error:', err));
    }, MEDIA_BATCH_WINDOW_MS);
    for (const att of mediaAttachments) {
      const attUrl = att?.payload?.url;
      if (!attUrl) continue;
      batch.items.push({ url: attUrl, type: att.type });
    }
    if (userText) batch.texts.push(userText);
    console.log(`Buffered ${mediaAttachments.length} attachment(s) for ${senderId} — will flush in up to ${MEDIA_BATCH_WINDOW_MS / 1000}s.`);
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
  const effectiveText =

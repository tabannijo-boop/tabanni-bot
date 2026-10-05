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
  checkNeedsGreetingRefresh,
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
// Finds every [[INTAKE]]...[[/INTAKE]] block in a reply (there can be more
// than one, when someone is surrendering multiple pets together and each
// animal gets its own summary block), and returns the outgoing text with
// all of them stripped out. Returns null if there are no intake blocks at
// all. A single-pet intake is just the length-1 case of this.
function parseAllIntakeMarkers(reply) {
  const regex = /\[\[INTAKE\]\]([\s\S]*?)\[\[\/INTAKE\]\]/g;
  const summaries = [];
  let match;
  while ((match = regex.exec(reply)) !== null) {
    summaries.push(match[1].trim());
  }
  if (summaries.length === 0) return null;
  const outgoingText = reply.replace(regex, '').trim();
  return { summaries, outgoingText };
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
  const photoCountRaw = getField('Photo count');
  const photoCount = photoCountRaw ? parseInt(photoCountRaw, 10) : null;
  return {
    name: getField('Name') || getField('🐾 Name'),
    animalType: getField('Type'),
    age: getField('Age'),
    gender: getField('Gender'),
    vaccination: getField('Vaccination status'),
    phone: getField('Phone number'),
    story: getField('Story'),
    // How many of the pooled photos belong to this specific pet, in a
    // multi-pet intake (see PHOTO ATTRIBUTION note where this is used).
    // null when not present (e.g. single-pet intakes never need this).
    photoCount: Number.isFinite(photoCount) ? photoCount : null,
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
  const intake = parseAllIntakeMarkers(reply);
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

// The bot adds a note like "[sent 3 photo(s) and 1 video(s)]" to a person's
// message when they send media. That note is in English whatever language
// the person writes, so it must never be used to decide what language they
// are speaking (it used to make Arabic speakers look like English speakers
// right after sending photos).
function stripAttachmentNotes(text) {
  return String(text || '').replace(/\[sent [^\]]*\]/gi, ' ').trim();
}

// The language the person is actually writing in: their most recent message
// that has real words in it. Messages that are just a phone number, an
// emoji, or the automatic photo note are skipped and the previous message
// is used instead (same rule the prompt gives Claude).
function languageOfConversation(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== 'user') continue;
    const lang = detectLanguage(stripAttachmentNotes(history[i].content));
    if (lang) return lang;
  }
  return null;
}

// Safeguard: a conversation that has been trimmed to its latest messages
// can start with one of the bot's own replies. Drop any such leading bot
// messages so the history always opens with the person's message.
function dropLeadingBotMessages(history) {
  let i = 0;
  while (i < history.length && history[i].role !== 'user') i++;
  return history.slice(i);
}

// --- The thank-you sent when an adoption intake is complete ----------------
// This is a fixed message, written here instead of being left to Claude, so
// the wording is always exactly right (Claude used to improvise and
// sometimes garbled it). It thanks the owner, and reminds THEM to check that
// whoever contacts them is a responsible person who will look after the
// animal and take it to the vet. tabanni does not vet adopters for these
// owner-surrendered animals, so this is not a promise that tabanni will.
function classifyGender(g) {
  const t = String(g || '').toLowerCase();
  if (/female|girl|\bshe\b|انثى|أنثى|انثي|أنثي|بنت|بنوتة|صبية/.test(t)) return 'female';
  if (/male|boy|\bhe\b|ذكر|ولد|صبي/.test(t)) return 'male';
  return null;
}

function buildIntakeThanks(lang, fieldsList) {
  const many = fieldsList.length > 1;
  const g = many ? null : classifyGender(fieldsList[0] && fieldsList[0].gender);

  const arForms = g === 'female'
    ? { about: 'عنها', care: 'فيها', take: 'ياخدها' }
    : g === 'male'
      ? { about: 'عنه', care: 'فيه', take: 'ياخده' }
      : { about: 'عنهم', care: 'فيهم', take: 'ياخدهم' };
  const ar = `شكراً لتزويدنا بكل التفاصيل. وصلتنا كل المعلومات ورح ننشر ${arForms.about} بالستوري قريباً.

لطفاً تأكدوا انه اي حدا بيتواصل معكم شخص مسؤول، رح يهتم ${arForms.care} منيح و${arForms.take} على العيادة للفحص والتطعيمات.

شكراً كتير على رعايتكم.`;

  const en_obj = g === 'female' ? 'her' : g === 'male' ? 'him' : 'them';
  const en = `Thank you for sharing all the details. We received everything and will post about ${en_obj} on our stories soon.

Please make sure that whoever contacts you is a responsible person who will take good care of ${en_obj} and take ${en_obj} to the vet for a check-up and vaccinations.

Thank you very much for your care.`;

  if (lang === 'ar') return ar;
  if (lang === 'en') return en;
  return `${ar}\n\n${en}`;
}

// Wraps getClaudeReply with a language check + one automatic retry if the
// --- Ages must have a unit --------------------------------------------------
// "5" could mean five years or five months, and the story card prints the age
// as a tag, so a bare number must never get through. The prompt tells Claude
// to ask, and this is the safeguard behind it: if an intake arrives with an
// age that is only a number (Latin or Arabic-Indic digits, no words such as
// years, months, weeks, سنة, شهور), the intake is held back and the person is
// asked instead.
function isBareNumberAge(age) {
  const a = String(age || '').trim();
  if (!a) return false;
  const hasDigit = /[0-9\u0660-\u0669\u06F0-\u06F9]/.test(a);
  const hasWord = /[A-Za-z\u0621-\u064A]/.test(a); // Arabic letters only, not Arabic digits
  return hasDigit && !hasWord;
}

// Returns the question to send, or null when every age already has a unit.
function buildAgeClarification(lang, fieldsList) {
  const bare = fieldsList.filter((f) => isBareNumberAge(f.age));
  if (bare.length === 0) return null;
  const names = bare.map((f) => f.name).filter(Boolean);
  const ar = names.length
    ? `ممكن توضحوا إذا عمر ${names.join(' و ')} بالسنوات ولا بالشهور؟`
    : 'ممكن توضحوا إذا العمر بالسنوات ولا بالشهور؟';
  const en = names.length
    ? `Could you please tell us if the age of ${names.join(' and ')} is in years or months?`
    : 'Could you please tell us if the age is in years or months?';
  if (lang === 'ar') return ar;
  if (lang === 'en') return en;
  return `${ar}\n\n${en}`;
}

// Wraps getClaudeReply with a language check + one automatic retry if the// mismatches — a prompt instruction alone was not reliable enough on its
// own, this actually verifies the output before it gets sent.
//
// baseNote (optional): extra context included in EVERY call for this turn,
// not just a retry — used for the 7-day greeting refresh below, so Claude
// knows to treat this as a fresh conversation start even though the stored
// history might still contain older messages.
async function getVerifiedClaudeReply(history, baseNote = '') {
  history = dropLeadingBotMessages(history);
  const reply = await getClaudeReply(history, baseNote);

  const expectedLang = languageOfConversation(history);
  const actualLang = detectLanguage(extractOutgoingText(reply));

  if (expectedLang && actualLang && expectedLang !== actualLang) {
    const languageNames = { ar: 'Arabic', en: 'English' };
    console.log(`⚠️ Language mismatch detected (expected ${languageNames[expectedLang]}, got ${languageNames[actualLang]}) — retrying once.`);
    const correctionNote = `CRITICAL CORRECTION: your previous reply was in the wrong language. The person's most recent message was in ${languageNames[expectedLang]}. Rewrite your ENTIRE reply in ${languageNames[expectedLang]} only, keeping the same meaning and keeping any [[MARKER]] you used exactly as it was. Do not mix languages.`;
    const combinedNote = baseNote ? `${baseNote}\n\n${correctionNote}` : correctionNote;
    const retryReply = await getClaudeReply(history, combinedNote);
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

    const intakeParsed = parseAllIntakeMarkers(reply);
    if (intakeParsed) {
      intake = true;
      outgoingText = buildIntakeThanks(languageOfConversation(history), intakeParsed.summaries.map(parseIntakeFields));
      for (let i = 0; i < intakeParsed.summaries.length; i++) {
        const petLabel = intakeParsed.summaries.length > 1 ? ` (pet ${i + 1} of ${intakeParsed.summaries.length})` : '';
        await sendTelegramNotificationWithButton(
          `🧪🐾🆕 [TEST PAGE] New adoption intake ready to post!${petLabel}\n\n${intakeParsed.summaries[i]}\n\nThis came from the /test.html team test page, not real Instagram.`,
          'toggle_handled',
          '☐ Not handled yet'
        );
      }
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
// images, nursing-mom alerts, handoffs, flags, and unsupported-attachment
// alerts). Separate from the Instagram webhook above. One-time setup
// required — see README.
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

// --- Gathering a person's messages before replying -------------------------
// People rarely send one tidy message. They send a name, then an age, then a
// photo, then a phone number, as separate messages seconds apart. Replying to
// each one separately produces a pile of half-answers and repeated questions.
// So after a person's message the bot waits for a quiet moment, collecting
// everything they send, and then replies ONCE to all of it. Every new message
// restarts the wait, up to a hard limit so a long stream of messages cannot
// delay the reply forever.
//
//   REPLY_WAIT_SECONDS  quiet time after a TEXT message before replying (default 60,
//                       0 = reply immediately to each text message)
//   MEDIA_WAIT_SECONDS  quiet time after a PHOTO or VIDEO (default 100, because
//                       uploading several photos takes people longer)
//   MAX_BATCH_WAIT_SECONDS  longest the bot will keep waiting in total (default 240)
//
// Every message is saved the moment it arrives, so nothing is lost if the
// server restarts during the wait; only the reply is delayed.
function secondsFromEnv(name, defaultSeconds) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultSeconds * 1000;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n * 1000 : defaultSeconds * 1000;
}
const replyWaitMs = () => secondsFromEnv('REPLY_WAIT_SECONDS', 60);
const mediaWaitMs = () => secondsFromEnv('MEDIA_WAIT_SECONDS', 100);
const maxBatchWaitMs = () => secondsFromEnv('MAX_BATCH_WAIT_SECONDS', 240);

const pendingTurns = new Map(); // senderId -> { texts: [string], items: [{url,type}], timer, firstAt }

// Runs jobs for the same person one at a time, so two replies to the same
// person can never be generated at the same moment.
const senderQueues = new Map();
function runSerialized(senderId, fn) {
  const previous = senderQueues.get(senderId) || Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  senderQueues.set(senderId, next);
  next.catch(() => {}).then(() => {
    if (senderQueues.get(senderId) === next) senderQueues.delete(senderId);
  });
  return next;
}

function flushPendingTurnNow(senderId) {
  return runSerialized(senderId, () => flushPendingTurn(senderId));
}

// Adds a message (text and/or photos/videos) to the person's waiting batch
// and (re)starts the quiet-time countdown.
async function addToPendingTurn(senderId, { text, mediaItems }) {
  let pending = pendingTurns.get(senderId);
  if (!pending) {
    pending = { texts: [], items: [], timer: null, firstAt: Date.now() };
    pendingTurns.set(senderId, pending);
  }
  const hasText = !!(text && text.trim());
  const hasMedia = !!(mediaItems && mediaItems.length);

  if (hasText) {
    pending.texts.push(text.trim());
    await addUserMessage(senderId, text.trim()); // saved right away, see note above
  }
  if (hasMedia) pending.items.push(...mediaItems);

  if (pending.timer) clearTimeout(pending.timer);
  const wait = hasMedia ? mediaWaitMs() : replyWaitMs();
  if (wait <= 0) {
    await flushPendingTurnNow(senderId);
    return;
  }
  const untilHardLimit = Math.max(0, pending.firstAt + maxBatchWaitMs() - Date.now());
  const delay = Math.min(wait, untilHardLimit);
  pending.timer = setTimeout(() => {
    flushPendingTurnNow(senderId).catch((err) => console.error('Error replying after wait:', err));
  }, delay);
  console.log(`⏳ Holding ${senderId}'s message(s) — will reply in ${Math.round(delay / 1000)}s unless more arrive.`);
}

// The wait is over: forward any photos/videos to Telegram, remember the
// photos for the story card, and reply once to everything the person sent.
async function flushPendingTurn(senderId) {
  const pending = pendingTurns.get(senderId);
  if (!pending) return;
  pendingTurns.delete(senderId);
  if (pending.timer) clearTimeout(pending.timer);

  const parts = [...pending.texts];
  let displayName;

  if (pending.items.length > 0) {
    if (await isPaused(senderId)) {
      console.log(`Conversation with ${senderId} is paused — dropping buffered photos/videos without replying.`);
    } else {
      const profile = await getInstagramUserProfile(senderId);
      displayName = profile?.username ? `@${profile.username}` : (profile?.name || `IGSID ${senderId}`);

      const photoCount = pending.items.filter((i) => i.type === 'image').length;
      const videoCount = pending.items.filter((i) => i.type === 'video').length;

      // Telegram caps captions at 1024 characters; stay safely under it.
      const caption = `📸 From ${displayName}${pending.texts.length ? `\n"${pending.texts.join(' ')}"` : ''}`.slice(0, 900);
      await sendTelegramMediaGroup(caption, pending.items);

      for (const item of pending.items) {
        if (item.type === 'image') await addPhotoUrl(senderId, item.url);
      }

      const kindParts = [];
      if (photoCount) kindParts.push(`${photoCount} photo(s)`);
      if (videoCount) kindParts.push(`${videoCount} video(s)`);
      const attachmentNote = `[sent ${kindParts.join(' and ')}]`;
      parts.push(attachmentNote);
      await addUserMessage(senderId, attachmentNote);
    }
  }

  if (parts.length === 0) return;
  await processTurn(senderId, parts.join('\n'), displayName);
}

// Pulls a usable message out of a link-preview ("fallback") attachment.
// Prefers what the person actually typed. If they typed nothing, looks for a
// phone number in the preview's title or link (Instagram turns numbers into
// "tel:" links), and failing that uses the preview's own title or link.
// Returns null if there is nothing usable, so the caller can fall back to
// asking the person to type their message.
function recoverTextFromLinkPreview(typedText, previews) {
  if (typedText && typedText.trim()) return typedText.trim();

  const candidates = [];
  for (const p of previews) {
    const url = p?.payload?.url || p?.url || '';
    const title = p?.payload?.title || p?.title || '';
    let decodedUrl = url;
    try { decodedUrl = decodeURIComponent(url); } catch (e) { /* keep raw */ }
    candidates.push(decodedUrl.replace(/^tel:/i, ''), title);
  }

  // A phone number: 7 to 15 digits, optionally with +, spaces, dashes, dots, brackets.
  for (const c of candidates) {
    const m = String(c).match(/\+?\d[\d\s\-().]{5,}\d/);
    if (m) {
      const digits = m[0].replace(/\D/g, '');
      if (digits.length >= 7 && digits.length <= 15) return m[0].trim();
    }
  }

  const fallbackText = candidates.map((c) => String(c).trim()).find(Boolean);
  return fallbackText || null;
}

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
    if (await wasSentByBot(message.mid)) return;
    await pauseAfterHumanReply(senderId);
    console.log(`Detected manual reply to ${senderId} — pausing bot for this conversation.`);
    return;
  }

  // A bare emoji "quick reaction" tapped directly on one of tabanni's
  // Stories arrives as a message with reply_to.story set, and text that
  // is just the emoji itself, no real content. This is intentionally
  // suppressed entirely, no reply, no pause, no Telegram alert, nothing.
  // A genuine typed reply to a story (someone actually asking a real
  // question, e.g. "is this dog still available?") also carries
  // reply_to.story, but has real language content, so it is NOT
  // suppressed, it flows through to Claude normally like any message.
  if (message.reply_to?.story) {
    const hasRealTextContent = !!(message.text && /[A-Za-z\u0600-\u06FF]/.test(message.text));
    const hasRealAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
    if (!hasRealTextContent && !hasRealAttachments) {
      console.log(`Story reaction (no real content) from ${senderId} — no action taken.`);
      return;
    }
  }

  let userText = message.text;
  const mediaAttachments = Array.isArray(message.attachments)
    ? message.attachments.filter((a) => a.type === 'image' || a.type === 'video')
    : [];
  const otherAttachments = Array.isArray(message.attachments)
    ? message.attachments.filter((a) => a.type !== 'image' && a.type !== 'video')
    : [];
  const hasAttachments = mediaAttachments.length > 0;

  // Log what kind of non-photo attachment arrived (type only, never the
  // contents) so any new kind of attachment is easy to diagnose in Render.
  if (otherAttachments.length > 0) {
    console.log(`📎 Non-media attachment(s) from ${senderId}: ${JSON.stringify(otherAttachments.map((a) => ({ type: a.type, hasUrl: !!a?.payload?.url, hasTitle: !!a?.payload?.title })))}${userText ? ' (message also has text)' : ''}`);
  }

  // LINK PREVIEWS ("fallback" attachments). When someone sends a phone
  // number, a web address, or anything else Instagram turns into a tappable
  // link, Instagram wraps it in a little preview card and sends it as a
  // "fallback" attachment, usually with the text they actually typed still
  // in message.text. That is not a voice note and not a story/post share, so
  // it must not trigger the "can't receive this" reply or pause the chat.
  // The typed text (or, if there is none, the number/link found in the
  // preview) is used as the message instead.
  const linkPreviewAttachments = otherAttachments.filter((a) => a.type === 'fallback');
  const otherNonPreviewAttachments = otherAttachments.filter((a) => a.type !== 'fallback');
  let linkPreviewHandledAsText = false;
  if (!hasAttachments && linkPreviewAttachments.length > 0 && otherNonPreviewAttachments.length === 0) {
    const recovered = recoverTextFromLinkPreview(userText, linkPreviewAttachments);
    if (recovered) {
      userText = recovered;
      linkPreviewHandledAsText = true;
    }
  }

  // Voice notes specifically: the bot cannot transcribe audio, but this is
  // fully self-resolvable by just asking the person to type instead, so no
  // human needs to get involved. No pause, no Telegram alert, bot stays
  // fully active and ready for their next (typed) message.
  const voiceNoteAttachments = otherAttachments.filter((a) => a.type === 'audio');
  // "fallback" (or anything else with no usable payload URL) is what Meta
  // sends for an unsupported share it could not represent properly — this
  // includes cases like a failed contact/phone-number share. There is
  // nothing here worth pausing the conversation or alerting the team
  // over, so it is handled the same gentle way as a voice note: just ask
  // the person to type it normally.
  const emptyFallbackAttachments = linkPreviewHandledAsText ? [] : otherAttachments.filter((a) => a.type !== 'audio' && !a?.payload?.url);
  const trulyUnsupportedAttachments = linkPreviewHandledAsText ? [] : otherAttachments.filter((a) => a.type !== 'audio' && a?.payload?.url);

  if (!hasAttachments && voiceNoteAttachments.length > 0) {
    await flushPendingTurnNow(senderId);
    const askToTypeText = 'عذراً، ما نقدر نستمع للرسائل الصوتية لأن هذا بوت ذكاء اصطناعي. ممكن تكتبولنا اللي حابين تحكوه بالنص لو سمحتوا؟\n\nSorry, we are not able to listen to voice notes as this is an AI chatbot. Could you please write down what you would like to say instead?';
    await sendInstagramReply(senderId, askToTypeText);
    console.log(`🎙️ Voice note from ${senderId} — asked them to type instead, bot stays active.`);
    return;
  }

  if (!hasAttachments && emptyFallbackAttachments.length > 0) {
    await flushPendingTurnNow(senderId);
    const askToTypeText = 'عذراً، ما قدرنا نستقبل هاد النوع من الرسائل. ممكن تكتبولنا اللي حابين تحكوه بالنص لو سمحتوا؟\n\nSorry, we were not able to receive that type of message. Could you please write it out as text instead?';
    await sendInstagramReply(senderId, askToTypeText);
    console.log(`📎 Empty/fallback attachment (e.g. failed share) from ${senderId} — asked them to type instead, bot stays active.`);
    return;
  }

  // Story mentions, post/reel shares, or any other attachment type we
  // genuinely cannot process (there is nothing to "type instead" for a
  // story mention): goes to a volunteer with a general acknowledgment.
  if (!hasAttachments && trulyUnsupportedAttachments.length > 0) {
    await flushPendingTurnNow(senderId);
    const ackText = 'شكراً لرسالتكم سيتم الرد عليكم من قبل احد متطوعين تبني بأسرع وقت ممكن\n\nThank you for your message. One of tabanni\'s volunteers will get back to you as soon as possible.';
    await sendInstagramReply(senderId, ackText);
    await setManualPause(senderId, true);
    console.log(`📎 Unsupported attachment from ${senderId} — bot paused, team alerted.`);
    const profile = await getInstagramUserProfile(senderId);
    const displayName = profile?.username ? `@${profile.username}` : (profile?.name || `IGSID ${senderId}`);
    await queueTelegramCall(async () => {
      await sendTelegramNotificationWithButton(
        `📎 tabanni bot needs a volunteer!\n\nFrom: ${displayName}\nSent a story mention, share, or other unsupported content${userText ? `\nMessage text: "${userText}"` : ''}\n\nOpen Instagram DMs to review and reply — the bot is paused on this conversation until you resume it (see README for /admin/resume).`,
        'toggle_handled',
        '☐ Not handled yet'
      );
      await sendTelegramSpacer();
    });
    return;
  }

  if (hasAttachments) {
    // Photos/videos: collect them (and any caption) and wait for more.
    const mediaItems = [];
    for (const att of mediaAttachments) {
      const attUrl = att?.payload?.url;
      if (!attUrl) continue;
      mediaItems.push({ url: attUrl, type: att.type });
    }
    await addToPendingTurn(senderId, { text: userText, mediaItems });
    return;
  }

  if (!userText) return; // nothing to respond to (e.g. a sticker with no attachments array)

  // A text message: collect it and wait for more before replying.
  await addToPendingTurn(senderId, { text: userText });
}

// Shared logic for handling one "turn": add the message to history, ask
// Claude for a reply (with a language check + retry), act on any
// [[HANDOFF]] / [[FLAG]] / [[INTAKE]] / [[NURSING]] marker, send the
// reply, and fire the right Telegram notification. Used by both a normal
// text message and a flushed media batch, so behavior is identical either
// way.
async function processTurn(senderId, effectiveText, precomputedDisplayName) {
  // The person's message(s) were already saved to the history when they
  // arrived (see addToPendingTurn / flushPendingTurn).
  if (await isPaused(senderId)) {
    console.log(`Conversation with ${senderId} is paused — bot staying quiet.`);
    return;
  }

  // If the last thing in the history is already the bot's own reply, there
  // is nothing new to answer (this can happen when messages arrive while a
  // reply is being written). Replying again would just continue the bot's
  // previous message.
  const history = await getHistory(senderId);
  if (!history.length || history[history.length - 1].role !== 'user') {
    console.log(`Nothing new to answer for ${senderId} — skipping.`);
    return;
  }

  // If this is a brand new conversation, or the person has been silent for
  // 7+ days, treat this reply as worth the full opening/disclosure message
  // again (the "you are talking to tabanni's AI agent" note), even though
  // the stored history might still technically contain older messages.
  // Claude only sees the conversation TEXT, not real timestamps, so it has
  // no way to know time has passed unless told explicitly here.
  const needsGreetingRefresh = await checkNeedsGreetingRefresh(senderId);
  const greetingNote = needsGreetingRefresh
    ? 'CONTEXT NOTE: the person has either never messaged before, or has been silent for 7 or more days since their last message. Treat this reply as a fresh conversation start: include the full opening/disclosure message pattern (mentioning this is tabanni\'s AI agent, plus the trial-phase note), the same as you would for a brand new conversation, even if the message history below shows earlier messages.'
    : '';

  const reply = await getVerifiedClaudeReply(history, greetingNote);
  await addAssistantMessage(senderId, reply);

  // --- Human handoff: did Claude flag this as something it can't safely ---
  // answer (e.g. real-time animal availability)? If so, strip the silent
  // marker (wherever it appears in the reply, not just as a strict
  // prefix), send the warm acknowledgement anyway, then pause the bot on
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
  let intakeSummaries = null; // array, one entry per pet
  let nursingInfo = null;

  const intakeParsed = parseAllIntakeMarkers(reply);
  const nursingParsed = parseNursingMarker(reply);
  if (intakeParsed) {
    intakeSummaries = intakeParsed.summaries;
    // The thank-you for a completed intake is a fixed message (see
    // buildIntakeThanks), not whatever Claude happened to write after the block.
    outgoingText = buildIntakeThanks(languageOfConversation(history), intakeSummaries.map(parseIntakeFields));
  } else if (nursingParsed) {
    nursingInfo = nursingParsed;
    outgoingText = nursingParsed.outgoingText;
  } else if (reply.includes(HANDOFF_MARKER)) {
    // Normally the marker is the very first characters of the reply, but
    // the model can occasionally place it elsewhere (e.g. at the end).
    // Searching for it anywhere and stripping it out, rather than
    // requiring it to be a strict prefix, prevents the raw marker text
    // from ever leaking into what the person actually sees, and ensures
    // the handoff/notification logic below still fires correctly either
    // way.
    needsHandoff = true;
    outgoingText = reply.split(HANDOFF_MARKER).join('').trim();
  } else if (reply.includes(FLAG_MARKER)) {
    needsFlag = true;
    outgoingText = reply.split(FLAG_MARKER).join('').trim();
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
      await sendTelegramNotificationWithButton(
        `🐾 tabanni bot needs a volunteer!\n\nFrom: ${displayName}\nMessage: "${effectiveText}"\n\nOpen Instagram DMs to reply — the bot is paused on this conversation until you resume it (see README for /admin/resume).`,
        'toggle_handled',
        '☐ Not handled yet'
      );
      await sendTelegramSpacer();
    });
  } else if (needsFlag) {
    await setManualPause(senderId, true);
    console.log(`🚩 Conversation with ${senderId} flagged — bot paused.`);

    const displayName = await getDisplayName();

    await queueTelegramCall(async () => {
      await sendTelegramNotificationWithButton(
        `🚩 tabanni bot flagged a conversation!\n\nFrom: ${displayName}\nMessage: "${effectiveText}"\n\nThe bot is paused on this conversation until you resume it (see README for /admin/resume).`,
        'toggle_handled',
        '☐ Not handled yet'
      );
      await sendTelegramSpacer();
    });
  } else if (intakeSummaries) {
    // An intake is now treated as a full handoff case too: pause for 24
    // hours the same way HANDOFF/FLAG do, since the team needs to review
    // and post the story card(s) themselves. Everything else about the
    // intake (photos, story card, checkbox) stays exactly the same, now
    // done once per pet when there is more than one in the same intake.
    await setManualPause(senderId, true);
    console.log(`🆕 Adoption intake ready for ${senderId} — ${intakeSummaries.length} pet(s). Bot paused for 24h.`);

    const displayName = await getDisplayName();
    const allPhotoUrls = await getPhotoUrls(senderId);

    // PHOTO ATTRIBUTION: with multiple pets in one intake, the pooled
    // photos need to be split correctly per animal. Each pet's summary
    // reports how many of the photos belong to it (see the "Photo count"
    // field in knowledge.js's multi-pet instructions), and pets are
    // collected and photographed in order, so consuming that many photos
    // per pet, in sequence, from the front of the pool gives the right
    // slice for each one. Falls back to giving a single pet all the
    // pooled photos when there is only one pet (the normal case).
    let photoCursor = 0;
    const perPetResults = [];
    for (let i = 0; i < intakeSummaries.length; i++) {
      const summary = intakeSummaries[i];
      let fields = null;
      let imageBuffer = null;
      let imageGenError = null;
      try {
        fields = parseIntakeFields(summary);
        let photoUrls;
        if (intakeSummaries.length === 1) {
          photoUrls = allPhotoUrls.slice(-8); // single pet: recent photos; the card drops duplicates and uses up to 4 distinct ones
        } else {
          const count = fields.photoCount != null ? fields.photoCount : 0;
          photoUrls = allPhotoUrls.slice(photoCursor, photoCursor + count);
          photoCursor += count;
        }
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
          console.log(`Skipped story image for ${senderId} (pet ${i + 1}/${intakeSummaries.length}): missing photos or name.`);
        }
      } catch (err) {
        console.error(`Story image generation failed for pet ${i + 1}/${intakeSummaries.length}:`, err);
        imageGenError = err;
      }
      perPetResults.push({ summary, fields, imageBuffer, imageGenError });
    }

    await queueTelegramCall(async () => {
      for (let i = 0; i < perPetResults.length; i++) {
        const { summary, fields, imageBuffer, imageGenError } = perPetResults[i];
        const petLabel = perPetResults.length > 1 ? ` (pet ${i + 1} of ${perPetResults.length})` : '';
        await sendTelegramNotification(
          `🐾🆕 New adoption intake ready to post!${petLabel}\n\nFrom: ${displayName}\n\n${summary}`
        );
        if (imageBuffer && fields) {
          await sendTelegramStoryImage(
            `🖼️ Ready-to-post story card for ${fields.name}${petLabel} — save and add to Instagram Stories. Tap the checkbox below once it is posted.`,
            imageBuffer,
            `tabanni_story_${fields.name.replace(/\s+/g, '_')}.png`
          );
        } else if (imageGenError) {
          await sendTelegramNotificationWithButton(
            `⚠️ Could not auto-generate the story image for the intake above${petLabel} — please build it manually this time.`,
            'toggle_handled',
            '☐ Not handled yet'
          );
        }
      }
      await sendTelegramSpacer();
    });

    console.log(`✅ Adoption intake (${intakeSummaries.length} pet(s)) fully sent to Telegram for ${senderId} — bot paused 24h.`);
  } else if (nursingInfo) {
    console.log(`🍼 Nursing mother case flagged for ${senderId}.`);

    const displayName = await getDisplayName();
    const allPhotoUrls = await getPhotoUrls(senderId);
    const latestPhoto = allPhotoUrls[allPhotoUrls.length - 1];

    await queueTelegramCall(async () => {
      if (latestPhoto) {
        await sendTelegramAlertPhoto(
          `🍼 Nursing Mom Alert\n\nFrom: ${displayName}\nPhone: ${nursingInfo.phone || 'not provided'}`,
          latestPhoto,
          'toggle_nursing',
          '☐ Not handled yet'
        );
      } else {
        await sendTelegramNotificationWithButton(
          `🍼 Nursing Mom Alert (no photo received)\n\nFrom: ${displayName}\nPhone: ${nursingInfo.phone || 'not provided'}`,
          'toggle_handled',
          '☐ Not handled yet'
        );
      }
      await sendTelegramSpacer();
    });
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

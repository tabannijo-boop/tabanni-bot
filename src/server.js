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
  markBotSend,
  recentlySentByBot,
  setCollecting,
  isCollecting,
  addPhotoUrl,
  getPhotoUrls,
  claimIncomingMessage,
  claimWelcome,
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
    // Noted BEFORE sending as well as after: Instagram can echo the message
    // back before our send call has even returned, and that echo must never
    // be mistaken for a team member typing.
    await markBotSend(senderId);
    const sendResult = await sendInstagramMessage(senderId, chunk);
    await markBotMessageId(sendResult?.messageId);
    await markBotSend(senderId);
  }
}

// --- The welcome message ------------------------------------------------------
// Sent by the bot, word for word, the moment a person first writes (and again
// after 7 days of silence). It replaces the automatic reply that Instagram
// itself used to send, which has been switched off. It is fixed text on
// purpose: it carries the partner clinics' phone numbers, which must never be
// changed or dropped, and it must reach the person immediately, not after the
// bot's short wait before answering.
//
// To change the welcome, edit the two texts below. Nothing else needs to change.
const WELCOME_EN = `Hello, thank you for contacting tabanni. You are talking to tabanni's AI agent. We will reply as soon as possible.

If an animal is very sick, injured, poisoned, abused, or was run over, please contact one of our partner clinics directly so the animal can be seen as soon as possible, and mention that tabanni referred you:
Pets Corner (Dr Mohammad Bakhit), Wadi Saqra: 07 9835 5477
First Pet, Abdoun: 07 9501 3824
First Pet, Swefieh: 0797177835
Petpark (Dr Rakan), Swefieh: 065866557

For lost or found pets: contact @tabanni.jordan.lostandfound

Please note, we are currently in a trial phase while testing this chatbot. If you notice any errors, please know this is part of the trial period. If you would like to report anything about the chatbot, please email info@tabanni.org with the subject CHATBOT error report. Thank you.`;

const WELCOME_AR = `مرحبًا، شكرًا لتواصلكم مع تبنّي. أنتم تتحدثون مع مساعد تبني الذكي الاصطناعي. سنرد في أقرب وقت ممكن.

إذا كان الحيوان مريضًا جدًا، أو مصابًا، أو متسممًا، أو تعرض للإساءة أو الدهس، لطفاً تواصلوا مباشرة مع إحدى عياداتنا الشريكة ليتم فحصه بأسرع وقت، وقولوا انكم أخدتوا الرقم من تبني:
Pets Corner (د. محمد بخيت)، وادي صقرة: 07 9835 5477
First Pet، عبدون: 07 9501 3824
First Pet، صويفية: 0797177835
Petpark (د. ركان)، صويفية: 065866557

للإبلاغ عن حيوان مفقود أو عثر عليه: @tabanni.jordan.lostandfound

يرجى العلم اننا حاليا بمرحلة تجريبية انتقالية لتجربة البوت، فاذا صادفتكم اي أخطاء يرجى العلم انها جزء من هذه المرحلة التجريبية. اذا لاحظتوا اي شي حابين تبلغونا عنه بخصوص البوت، ممكن ترسلولنا ايميل ع info@tabanni.org بعنوان CHATBOT error report. شكرًا.`;

// The welcome goes out in the language the person wrote in. If their first
// message has no words to go by (only a photo, a shared post, an emoji), both
// languages are sent.
function welcomeMessagesFor(firstText) {
  const lang = detectLanguage(stripAttachmentNotes(firstText));
  if (lang === 'ar') return [WELCOME_AR];
  if (lang === 'en') return [WELCOME_EN];
  return [WELCOME_EN, WELCOME_AR];
}

// Sends the welcome if this is the person's first message (or their first
// after 7 days of silence). Not sent while a team member has taken over the
// conversation. SEND_WELCOME_MESSAGE=false in Render switches it off.
async function sendWelcomeIfFirstContact(senderId, firstText) {
  if (process.env.SEND_WELCOME_MESSAGE === 'false') return;
  if (await isPaused(senderId)) return;
  if (!(await claimWelcome(senderId))) return;
  for (const text of welcomeMessagesFor(firstText)) {
    await sendInstagramReply(senderId, text);
  }
  console.log(`👋 Sent the welcome message to ${senderId}.`);
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
  const foundInMatch = summary.match(/Found in\s*:\s*(.+)/i);
  return {
    phone: phoneMatch ? phoneMatch[1].trim() : '',
    foundIn: foundInMatch ? foundInMatch[1].trim() : '',
    outgoingText: outgoing,
  };
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
  reply = stripCollectingMarker(reply);
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

// --- Silent marker: the bot is collecting an animal's details -------------------
// While a surrender/rehoming intake or the nursing-mother flow is going,
// Claude starts its replies with [[COLLECTING]] (invisible to the person).
// That switches on "photos and videos are wanted" for this conversation (see
// isCollecting). As a second way to notice, any reply that asks for photos or
// videos switches it on too, except the lost & found redirect, which sends
// photos to the other account instead.
const COLLECTING_MARKER = '[[COLLECTING]]';
function stripCollectingMarker(text) {
  return String(text || '').split(COLLECTING_MARKER).join('').trim();
}
function asksForMedia(text) {
  return /(photos?|pictures?|pics?|videos?|صور|صورة|فيديو)/i.test(text) && !/lostandfound/i.test(text);
}

// --- Words that must never reach a customer -----------------------------------
// The prompt bans these Gulf/Iraqi/Egyptian words and tells Claude to use
// Jordanian ones, but Claude still slips occasionally. This is the guarantee
// behind the rule: any banned word in an Arabic reply is swapped for its
// Jordanian equivalent right before the message is sent. (Only whole words are
// changed. "زين" and "دي" are left to the prompt because they are also common
// names, and replacing them could change an animal's name.)
const ARABIC_LETTERS = '\u0621-\u0652';
const BANNED_ARABIC_WORDS = {
  'شنو': 'شو',
  'الحين': 'هلأ',
  'وش': 'شو',
  'وايد': 'كتير',
  'ابغى': 'بدي',
  'كذا': 'هيك',
  'زغار': 'صغار',
  'تحطوهن': 'تحطوهم',
  'هلق': 'هلأ',
  'هسع': 'هسا',
  'فهمنا': 'بنتفهم', // "we understood" is never used, see the prompt
};
// A one-letter prefix (و ف ب ل, as in "وابغى" = "and I want") is also caught
// for the words where that cannot clash with a real word.
const WORDS_THAT_MAY_HAVE_A_PREFIX = new Set(['شنو', 'ابغى', 'وايد', 'فهمنا']);
const BANNED_WORD_PATTERNS = Object.entries(BANNED_ARABIC_WORDS).map(([bad, good]) => {
  const prefix = WORDS_THAT_MAY_HAVE_A_PREFIX.has(bad) ? '([وفبل]?)' : '()';
  return [new RegExp(`(?<![${ARABIC_LETTERS}])${prefix}${bad}(?![${ARABIC_LETTERS}])`, 'g'), `$1${good}`];
});
function fixArabicWording(text) {
  if (!/[\u0600-\u06FF]/.test(text)) return text;
  let out = text;
  // Asking someone to confirm a phone number: the right wording is "هاد رقم حضرتكم؟".
  out = out.replace(/ها[يد]\s+رقمك(\s+صح)?\s*[؟?]/g, 'هاد رقم حضرتكم؟');
  out = out.replace(new RegExp(`(?<![${ARABIC_LETTERS}])رقمك(?![${ARABIC_LETTERS}])`, 'g'), 'رقمكم');
  for (const [pattern, replacement] of BANNED_WORD_PATTERNS) out = out.replace(pattern, replacement);
  if (out !== text) console.log('✏️ Corrected the wording of an Arabic reply before sending it.');
  return out;
}

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

// --- The team never calls anyone ------------------------------------------------
// tabanni's team does not phone people, so a reply must never promise a call,
// or promise to "contact the number" the person gave. The prompt says so, and
// this is the safeguard behind it: a reply that makes such a promise is
// rewritten once by Claude before anything is sent. The patterns are narrow on
// purpose: they only catch the TEAM promising a call, so a reply that tells
// the person to call a clinic is left alone.
const NOT_ARABIC_LETTER_BEFORE = '(?<![\\u0621-\\u0652])';
const NOT_ARABIC_LETTER_AFTER = '(?![\\u0621-\\u0652])';
const CALL_PROMISE_PATTERNS = [
  // English: "we will call you", "someone from our team can phone you", "our team will ring you"
  /\b(?:we|our team|the team|a team member|someone(?: from (?:the|our) team)?|a volunteer)\s+(?:will|shall|can|could|would|may|are going to|going to|try to|be able to)\s+(?:also\s+|then\s+)?(?:call|phone|ring)\b/i,
  /\bwe(?:'|\u2019)ll\s+(?:call|phone|ring)\b/i,
  /\bgive you a (?:call|ring)\b/i,
  // English: "we will contact the number you gave us"
  /\b(?:we|our team|the team|someone|a team member)\b[^.!?\n]{0,40}\b(?:contact|reach|text|message|whatsapp)\b[^.!?\n]{0,30}\b(?:the number|your number|that number|the phone)\b/i,
  // Arabic: "رح نتصل فيكم", "بنكلمكم", "حدا رح يتصل فيكم"
  new RegExp(NOT_ARABIC_LETTER_BEFORE + '(?:بنتصل|نتصل|نتّصل|بنتصّل|نتصّل|يتصل|يتصلوا|بيتصل|بيتصلوا|بنكلمكم|بنكلمك|نكلمكم|نكلمك|يكلمكم|يكلمك|بيكلمكم|بيكلمك)' + NOT_ARABIC_LETTER_AFTER),
  // Arabic: "رح نتواصل مع الرقم", "نتواصل معكم على الرقم", "يتواصلوا عالرقم"
  /[ني]تواصل(?:وا)?\s+(?:معكم\s+|معك\s+)?(?:على|عل|عا|ع|مع|ب|بـ)\s*(?:ال)?(?:رقم|تليفون|هاتف)/,
];
function promisesACall(text) {
  const t = String(text || '');
  return CALL_PROMISE_PATTERNS.some((p) => p.test(t));
}

// Wraps getClaudeReply with checks on the reply before it is sent, and ONE
// automatic retry (with an explicit correction) if a check fails:
//   - the reply is in the wrong language (a prompt instruction alone was not
//     reliable enough on its own, this actually verifies the output), or
//   - the reply promises that the team will call someone.
//
// baseNote (optional): extra context included in EVERY call for this turn,
// not just a retry. (Currently unused: the opening message is now sent by
// the system itself, see sendWelcomeIfFirstContact.)
async function getVerifiedClaudeReply(history, baseNote = '') {
  history = dropLeadingBotMessages(history);
  const reply = await getClaudeReply(history, baseNote);

  const expectedLang = languageOfConversation(history);
  const outgoing = extractOutgoingText(reply);
  const actualLang = detectLanguage(outgoing);
  const wrongLanguage = !!(expectedLang && actualLang && expectedLang !== actualLang);
  const callPromised = promisesACall(outgoing);

  if (!wrongLanguage && !callPromised) return reply;

  const languageNames = { ar: 'Arabic', en: 'English' };
  const notes = [];
  if (wrongLanguage) {
    console.log(`⚠️ Language mismatch detected (expected ${languageNames[expectedLang]}, got ${languageNames[actualLang]}) — retrying once.`);
    notes.push(`CRITICAL CORRECTION: your previous reply was in the wrong language. The person's most recent message was in ${languageNames[expectedLang]}. Rewrite your ENTIRE reply in ${languageNames[expectedLang]} only, keeping the same meaning and keeping any [[MARKER]] you used exactly as it was. Do not mix languages.`);
  }
  if (callPromised) {
    console.log('⚠️ The reply promised a phone call or contacting a phone number — retrying once.');
    notes.push("CRITICAL CORRECTION: your previous reply promised that tabanni's team would call the person, or contact the phone number they gave. tabanni's team never calls anyone. Rewrite your ENTIRE reply in the same language, keeping the same meaning and keeping any [[MARKER]] you used exactly as it was, but remove any promise of a call or of contacting a phone number. If a follow-up is needed, only say that the team will get back to them as soon as possible, without saying how.");
  }
  const combinedNote = [baseNote, ...notes].filter(Boolean).join('\n\n');
  const retryReply = await getClaudeReply(history, combinedNote);
  const retryOutgoing = extractOutgoingText(retryReply);

  if (wrongLanguage) {
    if (detectLanguage(retryOutgoing) === expectedLang) {
      console.log(`✅ Language corrected on retry.`);
    } else {
      console.log(`⚠️ Retry still did not match the expected language — sending it anyway (best effort, no further retries).`);
    }
  }
  if (callPromised) {
    if (promisesACall(retryOutgoing)) {
      console.log('⚠️ The retry still promised a call — sending it anyway (best effort, no further retries).');
    } else {
      console.log('✅ The promise of a call was removed on retry.');
    }
  }
  return retryReply;
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
    const reply = stripCollectingMarker(await getVerifiedClaudeReply(history));
    const HANDOFF_MARKER = '[[HANDOFF]]';
    const FLAG_MARKER = '[[FLAG]]';
    let outgoingText = reply;
    let handoff = false;
    let intake = false;
    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');

    const intakeParsed = parseAllIntakeMarkers(reply);
    if (intakeParsed) {
      const ageQuestion = buildAgeClarification(languageOfConversation(history), intakeParsed.summaries.map(parseIntakeFields));
      if (ageQuestion) {
        return res.json({ reply: ageQuestion, handoff: false, intake: false });
      }
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
    res.json({ reply: fixArabicWording(outgoingText), handoff, intake });
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

  // A phone number can arrive twice (once as typed text and once from its
  // preview card). The same number twice in a row is only counted once.
  const digitsOnly = (x) => String(x).replace(/\D/g, '');
  const isPhoneLike = (x) => /^[\d\s+\-().]+$/.test(x) && digitsOnly(x).length >= 7;
  const lastText = pending.texts[pending.texts.length - 1];
  const duplicateNumber = hasText && lastText && isPhoneLike(text.trim()) && isPhoneLike(lastText) && digitsOnly(text) === digitsOnly(lastText);

  if (hasText && !duplicateNumber) {
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

// A phone number sent from Instagram can arrive as a small "link preview"
// card (a "fallback" attachment) instead of, or as well as, plain text. When
// the person typed no text, this reads the number out of that card so a
// phone number is never lost. It does not use anything else from the card
// (web page titles, links and so on): attachments are otherwise ignored.
// Returns the number, or null.
function recoverPhoneFromLinkPreview(previews) {
  for (const p of previews) {
    const url = p?.payload?.url || p?.url || '';
    const title = p?.payload?.title || p?.title || '';
    let decodedUrl = url;
    try { decodedUrl = decodeURIComponent(url); } catch (e) { /* keep raw */ }
    for (const candidate of [decodedUrl.replace(/^tel:/i, ''), title]) {
      const m = String(candidate).match(/\+?\d[\d\s\-().]{5,}\d/);
      if (m) {
        const digits = m[0].replace(/\D/g, '');
        if (digits.length >= 7 && digits.length <= 15) return m[0].trim();
      }
    }
  }
  return null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const echoGraceMs = () => secondsFromEnv('ECHO_GRACE_SECONDS', 2);

async function handleMessagingEvent(event) {
  const message = event.message;
  if (!message) return;

  // WHO IS THE CONVERSATION WITH? Normally the sender. But when the message
  // is an "echo" (a message sent FROM your account, by the bot or by a team
  // member in the Instagram app), Instagram reports YOUR account as the
  // sender and the customer as the recipient. Using the sender here made the
  // bot "pause" its own account instead of the customer's conversation, so
  // a team member joining a chat never stopped the bot.
  const isEcho = !!message.is_echo;
  const senderId = isEcho ? event.recipient?.id : event.sender?.id;
  if (!senderId) return;

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
  if (isEcho) {
    // 1) The bot's own messages are recognized by their message ID.
    if (await wasSentByBot(message.mid)) return;
    // 2) The bot notes "I am sending to this person" BEFORE it sends, so an
    //    echo that arrives within about 3 seconds of the bot's own message
    //    is the bot's own message, even if its ID is not recorded yet.
    if (await recentlySentByBot(senderId)) {
      console.log(`Echo ${message.mid} to ${senderId} came right after the bot's own message, treating it as the bot's own.`);
      return;
    }
    // 3) Last check: if Instagram was slow to confirm a send, its ID may be
    //    recorded a moment later. Wait briefly and look once more.
    await sleep(echoGraceMs());
    if (await wasSentByBot(message.mid)) return;
    // Otherwise a person sent it from the Instagram app.
    await pauseAfterHumanReply(senderId);
    console.log(`👤 A team member replied to ${senderId} — bot paused for 24 hours on this conversation.`);
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

  // A real message from a person: welcome them first, if this is their first
  // message (or their first after 7 days of silence). This goes out at once,
  // before the short wait the bot takes to gather and answer their message.
  await sendWelcomeIfFirstContact(senderId, message.text);

  let userText = message.text;
  const hasTypedText = () => !!(userText && userText.trim());
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  const mediaAttachments = attachments.filter((a) => a.type === 'image' || a.type === 'video');
  const voiceNoteAttachments = attachments.filter((a) => a.type === 'audio');
  // Everything else: phone-number cards, shared posts and reels, story
  // mentions, and any other kind of attachment.
  const otherAttachments = attachments.filter((a) => a.type !== 'image' && a.type !== 'video' && a.type !== 'audio');

  // ATTACHMENTS ARE IGNORED, QUIETLY. The bot does not reply to them, does
  // not pause, and does not alert the team. If the person typed anything
  // together with the attachment, that text is answered as normal.
  //   - Photos and videos are only used while the bot is collecting an
  //     animal's details (see isCollecting below); otherwise ignored.
  //   - Phone-number cards, shared posts, reels, story mentions: always ignored.
  // (The type is logged, never the contents, to make any new kind easy to spot.)
  if (otherAttachments.length > 0) {
    console.log(`📎 Ignoring attachment(s) from ${senderId}: ${JSON.stringify(otherAttachments.map((a) => a.type))}${hasTypedText() ? ' (answering the typed text only)' : ''}`);
  }

  // The one exception: a phone number that arrives ONLY inside its card, with
  // no typed text, is read out of the card so the number is not lost.
  if (mediaAttachments.length === 0 && !hasTypedText()) {
    const phone = recoverPhoneFromLinkPreview(otherAttachments.filter((a) => a.type === 'fallback'));
    if (phone) userText = phone;
  }

  // Voice notes cannot be understood, so the person is asked to type, as
  // before. (Not while a team member has taken over the conversation.)
  if (mediaAttachments.length === 0 && voiceNoteAttachments.length > 0 && !hasTypedText()) {
    if (await isPaused(senderId)) return;
    await flushPendingTurnNow(senderId);
    const askToTypeText = 'عذراً، ما نقدر نستمع للرسائل الصوتية لأن هذا بوت ذكاء اصطناعي. ممكن تكتبولنا اللي حابين تحكوه بالنص لو سمحتوا؟\n\nSorry, we are not able to listen to voice notes as this is an AI chatbot. Could you please write down what you would like to say instead?';
    await sendInstagramReply(senderId, askToTypeText);
    console.log(`🎙️ Voice note from ${senderId} — asked them to type instead, bot stays active.`);
    return;
  }

  if (mediaAttachments.length > 0) {
    if (await isCollecting(senderId)) {
      // The bot is collecting this animal's details: keep the photos/videos.
      const mediaItems = [];
      for (const att of mediaAttachments) {
        const attUrl = att?.payload?.url;
        if (!attUrl) continue;
        mediaItems.push({ url: attUrl, type: att.type });
      }
      await addToPendingTurn(senderId, { text: userText, mediaItems });
      return;
    }
    // No intake in progress: photos and videos are ignored (answer any caption).
    console.log(`🖼️ Ignoring ${mediaAttachments.length} photo/video(s) from ${senderId}: no intake in progress.`);
    if (!hasTypedText()) return;
    await addToPendingTurn(senderId, { text: userText });
    return;
  }

  if (!hasTypedText()) return; // nothing to respond to

  // A text message: collect it and wait for more before replying.
  await addToPendingTurn(senderId, { text: userText });
}

// Shared logic for handling one "turn": ask Claude for a reply (with a
// language check + retry), act on any [[HANDOFF]] / [[FLAG]] / [[INTAKE]] /
// [[NURSING]] marker, send the reply, and fire the right Telegram
// notification. Used by both a normal text message and a flushed media
// batch, so behavior is identical either way.
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

  // The opening message (greeting, AI-agent note, clinic numbers, trial note)
  // is no longer written by Claude: the system sends it at once when someone
  // first writes (see sendWelcomeIfFirstContact), so Claude goes straight to
  // answering.
  const rawReply = await getVerifiedClaudeReply(history);
  const wantsCollecting = rawReply.includes(COLLECTING_MARKER);
  const reply = stripCollectingMarker(rawReply);

  // Safeguard: never complete an intake while an age is only a number. Ask
  // for the unit instead, and remember the question (not the held-back
  // intake) as the bot's reply. Nothing is paused or sent to the team yet.
  const earlyIntake = parseAllIntakeMarkers(reply);
  if (earlyIntake) {
    const ageQuestion = buildAgeClarification(languageOfConversation(history), earlyIntake.summaries.map(parseIntakeFields));
    if (ageQuestion) {
      await addAssistantMessage(senderId, ageQuestion);
      await sendInstagramReply(senderId, ageQuestion);
      await setCollecting(senderId, true); // the intake is still going
      console.log(`❓ Intake for ${senderId} held back: an age had no unit (years or months), asked the person.`);
      return;
    }
  }

  // The stored copy keeps the silent marker, so Claude keeps using it on later turns.
  await addAssistantMessage(senderId, rawReply);

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

  outgoingText = fixArabicWording(outgoingText);
  await sendInstagramReply(senderId, outgoingText);

  // Photos and videos are wanted only while an animal's details are being
  // collected. Switch that on when the bot says so (or asks for photos), and
  // off once the intake or nursing alert is complete.
  if (intakeSummaries || nursingInfo) {
    await setCollecting(senderId, false);
  } else if (!needsHandoff && !needsFlag && (wantsCollecting || asksForMedia(outgoingText))) {
    await setCollecting(senderId, true);
  }

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
          `🍼 Nursing Mom Alert\n\nFrom: ${displayName}\nPhone: ${nursingInfo.phone || 'not provided'}\nFound in: ${nursingInfo.foundIn || 'not said'}`,
          latestPhoto,
          'toggle_nursing',
          '☐ Not handled yet'
        );
      } else {
        await sendTelegramNotificationWithButton(
          `🍼 Nursing Mom Alert (no photo received)\n\nFrom: ${displayName}\nPhone: ${nursingInfo.phone || 'not provided'}\nFound in: ${nursingInfo.foundIn || 'not said'}`,
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

// Tracks, per Instagram conversation (by the user's IGSID), whether the bot
// should currently reply or stay quiet, plus recent message history so
// Claude has context — and photo URLs collected for story image generation.
//
// This now stores everything in Upstash Redis (a small, free, HTTP-based
// database) instead of in-memory, specifically because Render's free tier
// restarts the server constantly (every redeploy, and after ~15 minutes of
// inactivity) — in-memory storage was getting wiped mid-conversation,
// causing the bot to "forget" everything someone had already told it.
//
// Requires UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN in your
// environment — see README for how to get these from upstash.com (free).

const { Redis } = require('@upstash/redis');

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const MAX_HISTORY_MESSAGES = 12; // keep the last N turns so replies stay short & cheap
const MAX_TRACKED_PHOTOS = 10;

// Every pause case (a team member replying, a handoff, a flag, a finished
// intake) keeps the bot quiet on that one conversation for this long, and
// then the bot resumes by itself.
const PAUSE_SECONDS = 24 * 60 * 60;
const HANDOFF_PAUSE_EXPIRY_MS = PAUSE_SECONDS * 1000; // used only for older pause records, see isPaused

// How long a conversation's state is kept in Redis after its last activity.
// Just housekeeping so old, long-finished conversations don't sit forever —
// 7 days is far longer than any real back-and-forth should take.
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

// How long a person can stay silent before their next message gets the
// welcome message again (see claimWelcome below).
const WELCOME_REFRESH_SECONDS = 7 * 24 * 60 * 60;
const WELCOME_REFRESH_MS = WELCOME_REFRESH_SECONDS * 1000;

// How long we remember a bot-sent message ID, to recognize its own echo
// (see wasSentByBot below). Only needs to cover the few seconds it takes
// Instagram to echo a message back.
const BOT_ECHO_WINDOW_SECONDS = 120;

// How long "the bot just sent something to this person" is remembered. Used
// as a second way to recognize the bot's own echo (see recentlySentByBot).
// Deliberately short: the bot's own echo arrives within about a second, while
// a person needs several seconds to read and type, so a team member's reply
// is never mistaken for the bot.
const BOT_RECENT_SEND_SECONDS = 3;

// While the bot is collecting an animal's details (a surrender/rehoming
// intake, or the nursing-mother flow), photos and videos are wanted. This is
// how long that stays switched on after the last sign the flow is going.
const COLLECTING_SECONDS = 24 * 60 * 60;

function convoKey(userId) {
  return `tabanni:convo:${userId}`;
}
function echoKey(messageId) {
  return `tabanni:echo:${messageId}`;
}
// The pause lives under its OWN key, not inside the conversation record.
// The conversation record is read, changed and saved back on almost every
// message, so a pause stored inside it could be wiped out by a save that
// started a moment before a team member replied. A key of its own cannot be
// overwritten by those saves, and it expires by itself after 24 hours.
function pauseKey(userId) {
  return `tabanni:pause:${userId}`;
}
function collectingKey(userId) {
  return `tabanni:collecting:${userId}`;
}
function botSendKey(userId) {
  return `tabanni:botsend:${userId}`;
}
function welcomeKey(userId) {
  return `tabanni:welcome:${userId}`;
}

async function getConvo(userId) {
  const stored = await redis.get(convoKey(userId));
  if (stored && typeof stored === 'object') return stored;
  return { pausedUntil: null, manualPauseAt: null, history: [], photoUrls: [], lastMessageAt: null };
}

async function saveConvo(userId, convo) {
  await redis.set(convoKey(userId), convo, { ex: STATE_TTL_SECONDS });
}

async function isPaused(userId) {
  if (await redis.get(pauseKey(userId))) return true;

  // Older pause records (made by earlier versions, stored inside the
  // conversation record) are still honored, so a conversation that was
  // already paused when this version went live stays paused.
  const convo = await getConvo(userId);
  if (convo.manualPauseAt) {
    if (Date.now() - convo.manualPauseAt < HANDOFF_PAUSE_EXPIRY_MS) return true;
    convo.manualPauseAt = null;
    await saveConvo(userId, convo);
  }
  if (convo.pausedUntil && Date.now() < convo.pausedUntil) return true;
  return false;
}

// A team member sent a message in this conversation: the bot steps out for
// 24 hours, for this one conversation only.
async function pauseAfterHumanReply(userId) {
  await redis.set(pauseKey(userId), Date.now(), { ex: PAUSE_SECONDS });
}

// Handoffs, flags, intakes and the /admin endpoints: pause (true) or resume (false).
async function setManualPause(userId, paused) {
  if (paused) {
    await redis.set(pauseKey(userId), Date.now(), { ex: PAUSE_SECONDS });
    return;
  }
  await redis.del(pauseKey(userId));
  const convo = await getConvo(userId);
  convo.manualPauseAt = null;
  convo.pausedUntil = null;
  await saveConvo(userId, convo);
}

async function addUserMessage(userId, text) {
  const convo = await getConvo(userId);
  convo.history.push({ role: 'user', content: text });
  trim(convo);
  await saveConvo(userId, convo);
}

async function addAssistantMessage(userId, text) {
  const convo = await getConvo(userId);
  convo.history.push({ role: 'assistant', content: text });
  trim(convo);
  await saveConvo(userId, convo);
}

async function getHistory(userId) {
  const convo = await getConvo(userId);
  return convo.history;
}

function trim(convo) {
  if (convo.history.length > MAX_HISTORY_MESSAGES) {
    convo.history = convo.history.slice(-MAX_HISTORY_MESSAGES);
  }
}

async function addPhotoUrl(userId, url) {
  if (!url) return;
  const convo = await getConvo(userId);
  convo.photoUrls.push(url);
  if (convo.photoUrls.length > MAX_TRACKED_PHOTOS) {
    convo.photoUrls = convo.photoUrls.slice(-MAX_TRACKED_PHOTOS);
  }
  await saveConvo(userId, convo);
}

async function getPhotoUrls(userId) {
  const convo = await getConvo(userId);
  return convo.photoUrls;
}

async function markBotMessageId(messageId) {
  if (!messageId) return;
  await redis.set(echoKey(messageId), '1', { ex: BOT_ECHO_WINDOW_SECONDS });
}

async function wasSentByBot(messageId) {
  if (!messageId) return false;
  const val = await redis.get(echoKey(messageId));
  return !!val;
}

// Remembers, for a few seconds, that the bot itself just sent a message to
// this person. Together with the message-ID check above, this stops the
// bot's own message echo from ever being mistaken for a team member.
async function markBotSend(userId) {
  await redis.set(botSendKey(userId), 1, { ex: BOT_RECENT_SEND_SECONDS });
}

async function recentlySentByBot(userId) {
  return !!(await redis.get(botSendKey(userId)));
}

// --- Collecting an animal's details ---------------------------------------
// Photos, videos and other attachments are ignored in normal conversations.
// They are only wanted while the bot is collecting an animal's details.
async function setCollecting(userId, on) {
  if (on) await redis.set(collectingKey(userId), 1, { ex: COLLECTING_SECONDS });
  else await redis.del(collectingKey(userId));
}

async function isCollecting(userId) {
  return !!(await redis.get(collectingKey(userId)));
}

// --- Incoming message deduplication -------------------------------------
// Instagram (via Meta) can redeliver the same webhook event if it doesn't
// get a fast enough response — most commonly right when Render's free tier
// is waking up from sleep. Without this, a redelivered message gets
// processed twice: two Claude API calls, two identical replies sent to the
// person, and double the cost for one real message. This claims a message
// ID atomically (via Redis SETNX) the first time it's seen, so a duplicate
// delivery is recognized and skipped entirely, no matter how close together
// the two deliveries arrive.
const INCOMING_DEDUPE_WINDOW_SECONDS = 10 * 60; // covers any realistic retry window
function incomingKey(messageId) {
  return `tabanni:incoming:${messageId}`;
}
async function claimIncomingMessage(messageId) {
  if (!messageId) return true; // no ID to dedupe on — let it through
  // set with nx: true only succeeds if the key didn't already exist.
  const result = await redis.set(incomingKey(messageId), '1', { ex: INCOMING_DEDUPE_WINDOW_SECONDS, nx: true });
  return result !== null; // non-null means we successfully claimed it (first time seeing it)
}

// --- Welcome message -------------------------------------------------------
// The bot sends its welcome message the moment a person first writes, and
// again only if they have been silent for 7 days. This answers "should this
// message get the welcome?" and is done in ONE atomic step (Redis SETNX), so
// two messages arriving at the same instant can never both get one.
//
// Every message from a person pushes their 7 days forward, so someone who
// keeps chatting is never welcomed twice.
async function claimWelcome(userId) {
  const claimed = await redis.set(welcomeKey(userId), Date.now(), { ex: WELCOME_REFRESH_SECONDS, nx: true });
  if (claimed === null) {
    await redis.expire(welcomeKey(userId), WELCOME_REFRESH_SECONDS); // active person: restart their 7 days
    return false;
  }
  // The first time this person is seen by this version. Conversations that
  // were already going before the welcome message existed were greeted by
  // the old system, so someone who wrote within the last 7 days is not
  // welcomed again.
  const convo = await getConvo(userId);
  if (convo.lastMessageAt && Date.now() - convo.lastMessageAt < WELCOME_REFRESH_MS) return false;
  return true;
}

module.exports = {
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
};

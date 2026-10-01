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

// (AUTO_PAUSE_MINUTES removed: pauseAfterHumanReply now uses the same
// 24-hour window as every other pause case, see HANDOFF_PAUSE_EXPIRY_MS.)
const MAX_HISTORY_MESSAGES = 12; // keep the last N turns so replies stay short & cheap
const MAX_TRACKED_PHOTOS = 10;

// After a handoff (someone asked for Sereen/marketing/a human, or the bot
// could not answer), the bot stays quiet on that conversation indefinitely,
// UNLESS the same person messages again after this many hours have passed —
// at which point it is treated as a fresh conversation and the bot resumes
// answering normally.
const HANDOFF_PAUSE_EXPIRY_MS = 24 * 60 * 60 * 1000;

// How long a conversation's state is kept in Redis after its last activity.
// Just housekeeping so old, long-finished conversations don't sit forever —
// 7 days is far longer than any real back-and-forth should take.
const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

// How long a conversation can go quiet before the next message should get
// the full opening/disclosure message again (the "you are talking to
// tabanni's AI agent" note). Deliberately its own explicit value, separate
// from STATE_TTL_SECONDS above, so the two can be tuned independently —
// one controls how long we remember the conversation at all, this one
// controls when a returning person is treated as "starting fresh" again.
const GREETING_REFRESH_MS = 7 * 24 * 60 * 60 * 1000;

// How long we remember a bot-sent message ID, to recognize its own echo
// (see wasSentByBot below). Only needs to cover the few seconds it takes
// Instagram to echo a message back.
const BOT_ECHO_WINDOW_SECONDS = 120;

function convoKey(userId) {
  return `tabanni:convo:${userId}`;
}
function echoKey(messageId) {
  return `tabanni:echo:${messageId}`;
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
  const convo = await getConvo(userId);
  if (convo.manualPauseAt) {
    if (Date.now() - convo.manualPauseAt < HANDOFF_PAUSE_EXPIRY_MS) {
      return true;
    }
    convo.manualPauseAt = null;
    await saveConvo(userId, convo);
  }
  if (convo.pausedUntil && Date.now() < convo.pausedUntil) return true;
  return false;
}

async function pauseAfterHumanReply(userId) {
  const convo = await getConvo(userId);
  // 24 hours, same as every other pause case (handoff, flag, intake,
  // unsupported attachment) — any team member replying manually inside a
  // conversation steps the bot out for a full day, not just an hour.
  convo.pausedUntil = Date.now() + HANDOFF_PAUSE_EXPIRY_MS;
  await saveConvo(userId, convo);
}

async function setManualPause(userId, paused) {
  const convo = await getConvo(userId);
  convo.manualPauseAt = paused ? Date.now() : null;
  if (!paused) convo.pausedUntil = null;
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

// --- Greeting refresh -----------------------------------------------------
// Call once per incoming turn, before generating a reply. Returns true if
// this is either a brand new conversation, or the person has been silent
// for 7+ days since their last message — in both cases the reply should
// include the full opening/disclosure message again, since Claude only
// sees the conversation TEXT, not real timestamps, and has no way to know
// time has passed otherwise. Also updates the stored last-message time to
// now, regardless of the result.
async function checkNeedsGreetingRefresh(userId) {
  const convo = await getConvo(userId);
  const previous = convo.lastMessageAt;
  const needsRefresh = !previous || (Date.now() - previous >= GREETING_REFRESH_MS);
  convo.lastMessageAt = Date.now();
  await saveConvo(userId, convo);
  return needsRefresh;
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
  addPhotoUrl,
  getPhotoUrls,
  claimIncomingMessage,
  checkNeedsGreetingRefresh,
};

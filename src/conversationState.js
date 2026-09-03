// Tracks, per Instagram conversation (by the user's IGSID), whether the bot
// should currently reply or stay quiet, plus recent message history so
// Claude has context.
//
// NOTE: this is in-memory, which means it resets if the server restarts.
// That's fine to start with. If you outgrow it, swap this file's internals
// for a real database (e.g. a small SQLite file or Redis) — the functions
// below are the only thing the rest of the app touches, so nothing else
// needs to change.

const conversations = new Map();
// Each entry: { pausedUntil: timestamp|null, manuallyPaused: bool, history: [{role, content}] }

// Tracks message IDs the BOT itself just sent, so that when Instagram echoes
// that same message back on the webhook (which it does for every message
// sent from your account, bot or human), we can recognize it's our own and
// ignore it — instead of mistaking it for a human manually replying and
// pausing the bot on itself. Entries expire after a couple minutes since we
// only need this for a brief window right after sending.
const recentBotMessageIds = new Map(); // messageId -> expiry timestamp
const BOT_ECHO_WINDOW_MS = 2 * 60 * 1000;

function markBotMessageId(messageId) {
  if (!messageId) return;
  recentBotMessageIds.set(messageId, Date.now() + BOT_ECHO_WINDOW_MS);
}

function wasSentByBot(messageId) {
  if (!messageId) return false;
  const expiry = recentBotMessageIds.get(messageId);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    recentBotMessageIds.delete(messageId);
    return false;
  }
  return true;
}

const AUTO_PAUSE_MINUTES = parseInt(process.env.AUTO_PAUSE_MINUTES || '60', 10);
const MAX_HISTORY_MESSAGES = 12; // keep the last N turns so replies stay short & cheap

// After a handoff (someone asked for Sereen/marketing/a human, or the bot
// could not answer), the bot stays quiet on that conversation indefinitely,
// UNLESS the same person messages again after this many hours have passed —
// at which point it is treated as a fresh conversation and the bot resumes
// answering normally.
const HANDOFF_PAUSE_EXPIRY_MS = 24 * 60 * 60 * 1000;

function getOrCreate(userId) {
  if (!conversations.has(userId)) {
    conversations.set(userId, { pausedUntil: null, manualPauseAt: null, history: [] });
  }
  return conversations.get(userId);
}

function isPaused(userId) {
  const convo = getOrCreate(userId);
  if (convo.manualPauseAt) {
    if (Date.now() - convo.manualPauseAt < HANDOFF_PAUSE_EXPIRY_MS) {
      return true;
    }
    // More than 24 hours have passed since the handoff — automatically
    // resume the bot for this conversation.
    convo.manualPauseAt = null;
  }
  if (convo.pausedUntil && Date.now() < convo.pausedUntil) return true;
  return false;
}

// Called when we detect YOU (the page/IG account) sent a message manually.
function pauseAfterHumanReply(userId) {
  const convo = getOrCreate(userId);
  convo.pausedUntil = Date.now() + AUTO_PAUSE_MINUTES * 60 * 1000;
}

// Manual override — also used by the [[HANDOFF]] mechanism. Setting paused
// to true records the current time, so the 24-hour auto-expiry above kicks
// in from this moment. Setting it to false clears the pause immediately
// (e.g. the /admin/resume endpoint, or the 24-hour auto-expiry).
function setManualPause(userId, paused) {
  const convo = getOrCreate(userId);
  convo.manualPauseAt = paused ? Date.now() : null;
  if (!paused) convo.pausedUntil = null;
}

function addUserMessage(userId, text) {
  const convo = getOrCreate(userId);
  convo.history.push({ role: 'user', content: text });
  trim(convo);
}

function addAssistantMessage(userId, text) {
  const convo = getOrCreate(userId);
  convo.history.push({ role: 'assistant', content: text });
  trim(convo);
}

function getHistory(userId) {
  return getOrCreate(userId).history;
}

function trim(convo) {
  if (convo.history.length > MAX_HISTORY_MESSAGES) {
    convo.history = convo.history.slice(-MAX_HISTORY_MESSAGES);
  }
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
};

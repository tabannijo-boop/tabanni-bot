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

const AUTO_PAUSE_MINUTES = parseInt(process.env.AUTO_PAUSE_MINUTES || '60', 10);
const MAX_HISTORY_MESSAGES = 12; // keep the last N turns so replies stay short & cheap

function getOrCreate(userId) {
  if (!conversations.has(userId)) {
    conversations.set(userId, { pausedUntil: null, manuallyPaused: false, history: [] });
  }
  return conversations.get(userId);
}

function isPaused(userId) {
  const convo = getOrCreate(userId);
  if (convo.manuallyPaused) return true;
  if (convo.pausedUntil && Date.now() < convo.pausedUntil) return true;
  return false;
}

// Called when we detect YOU (the page/IG account) sent a message manually.
function pauseAfterHumanReply(userId) {
  const convo = getOrCreate(userId);
  convo.pausedUntil = Date.now() + AUTO_PAUSE_MINUTES * 60 * 1000;
}

// Manual override, for an admin endpoint / future dashboard button.
function setManualPause(userId, paused) {
  const convo = getOrCreate(userId);
  convo.manuallyPaused = paused;
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
};

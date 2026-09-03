const { SYSTEM_PROMPT } = require('./knowledge');

// --- Telegram send queue -----------------------------------------------
// Multiple Instagram conversations can trigger Telegram sends around the
// same moment (e.g. two intakes finishing seconds apart). server.js wraps
// each conversation's whole block of related messages (summary, image,
// spacer) in one queueTelegramCall() so the block runs as a single atomic
// unit — never split apart by another conversation's messages landing in
// between. Individual send functions below use plain fetch(), NOT this
// queue directly — nesting the queue inside itself (a block calling a
// queued function that queues itself again) would deadlock, since the
// inner call would wait for the outer block to finish, which is itself
// waiting on that inner call.
let telegramQueue = Promise.resolve();
function queueTelegramCall(fn) {
  const run = telegramQueue.then(fn, fn); // run fn regardless of the previous call's outcome
  telegramQueue = run.catch(() => {}); // keep the chain alive even if one call fails
  return run;
}

// Sends a text reply to a user on Instagram via the Graph API.
// Returns the sent message's ID (used to tell the bot's own echoed messages
// apart from genuine human-sent messages — see conversationState.js).
async function sendInstagramMessage(recipientId, text) {
  const url = `https://graph.instagram.com/v21.0/${process.env.IG_ACCOUNT_ID}/messages`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.PAGE_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      recipient: { id: recipientId },
      message: { text },
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('Instagram send failed:', res.status, errBody);
    return { ok: false, messageId: null };
  }
  const data = await res.json();
  return { ok: true, messageId: data.message_id || null };
}

// Asks Claude for a reply, given the conversation history so far.
async function getClaudeReply(history) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: history,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('Claude API failed:', res.status, errBody);
    return "Hello! Thank you for reaching out — a team member will follow up with you shortly. 🐾";
  }

  const data = await res.json();
  const textBlocks = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text);
  return textBlocks.join('\n').trim() ||
    "Hello! Thank you for reaching out — a team member will follow up with you shortly. 🐾";
}

// Pings your team on Telegram when a conversation gets flagged for a human
// (someone asked for Sereen/a human, or the bot hit something it can't
// answer). Silently does nothing if the env vars aren't set, so this is
// safe to leave in even before you've set up the Telegram bot.
async function sendTelegramNotification(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('(Telegram not configured — skipping notification. See README to set it up.)');
    return false;
  }

  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Telegram notification failed:', res.status, errBody);
    }
    return res.ok;
  } catch (err) {
    console.error('Telegram notification error:', err);
    return false;
  }
}

// Looks up the sender's Instagram username/name from their IGSID, so
// notifications are readable instead of just showing a numeric ID.
// Returns null if the lookup fails — callers should fall back gracefully.
async function getInstagramUserProfile(psid) {
  const url = `https://graph.instagram.com/v21.0/${psid}?fields=name,username&access_token=${process.env.PAGE_ACCESS_TOKEN}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Instagram profile lookup failed:', res.status, errBody);
      return null;
    }
    const data = await res.json();
    return { username: data.username || null, name: data.name || null };
  } catch (err) {
    console.error('Instagram profile lookup error:', err);
    return null;
  }
}

// Forwards a photo the person sent on Instagram straight to your Telegram
// group, so your team has adoption-story photos, injured-animal photos,
// lost/found photos, etc. all in one place — ready to grab and edit/post,
// without digging through Instagram DMs. Does not edit or post anything
// itself; that's still a human's call.
async function sendTelegramPhoto(caption, photoUrl) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('(Telegram not configured — skipping photo forward.)');
    return false;
  }
  const url = `https://api.telegram.org/bot${token}/sendPhoto`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, photo: photoUrl, caption }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Telegram photo forward failed:', res.status, errBody);
    }
    return res.ok;
  } catch (err) {
    console.error('Telegram photo forward error:', err);
    return false;
  }
}

// Same idea, for videos.
async function sendTelegramVideo(caption, videoUrl) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('(Telegram not configured — skipping video forward.)');
    return false;
  }
  const url = `https://api.telegram.org/bot${token}/sendVideo`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, video: videoUrl, caption }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Telegram video forward failed:', res.status, errBody);
    }
    return res.ok;
  } catch (err) {
    console.error('Telegram video forward error:', err);
    return false;
  }
}

// Sends a short visual divider message to Telegram, so consecutive alerts
// (handoffs, flags, intakes) are easy to tell apart at a glance in a busy
// group chat instead of blurring together.
async function sendTelegramSpacer() {
  await sendTelegramNotification('⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯');
}

// Sends the finished, generated story image to Telegram as a document (not
// a compressed photo) so your team gets the full-quality PNG, ready to save
// and post directly to Instagram Stories. Includes a tappable checkbox
// button so the team can mark it "posted" once it's actually on the story —
// tapping it edits this same message, no separate tracking needed.
// Returns { chatId, messageId } on success (needed to edit it later), or
// null on failure.
async function sendTelegramStoryImage(caption, imageBuffer, filename = 'tabanni_story.png') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('(Telegram not configured — skipping story image send.)');
    return null;
  }
  const url = `https://api.telegram.org/bot${token}/sendDocument`;
  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', caption);
    form.append('document', new Blob([imageBuffer], { type: 'image/png' }), filename);
    form.append('reply_markup', JSON.stringify({
      inline_keyboard: [[{ text: '☐ Not posted yet', callback_data: 'toggle_posted' }]],
    }));

    const res = await fetch(url, { method: 'POST', body: form });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Telegram story image send failed:', res.status, errBody);
      return null;
    }
    const data = await res.json();
    return { chatId: data.result?.chat?.id, messageId: data.result?.message_id };
  } catch (err) {
    console.error('Telegram story image send error:', err);
    return null;
  }
}

// Sends multiple photos/videos to Telegram as one grouped album (instead of
// separate messages), so a batch of adoption-story media arrives together
// with one caption instead of flooding the chat. Telegram requires at least
// 2 items per group and caps each group at 10, so this chunks larger
// batches and falls back to a single photo/video send for a lone item.
async function sendTelegramMediaGroup(caption, items) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('(Telegram not configured — skipping media group send.)');
    return false;
  }
  if (!items || items.length === 0) return false;

  if (items.length === 1) {
    const item = items[0];
    return item.type === 'video' ? sendTelegramVideo(caption, item.url) : sendTelegramPhoto(caption, item.url);
  }

  const chunks = [];
  for (let i = 0; i < items.length; i += 10) chunks.push(items.slice(i, i + 10));

  let allOk = true;
  for (let c = 0; c < chunks.length; c++) {
    const chunkItems = chunks[c];
    if (chunkItems.length === 1) {
      const item = chunkItems[0];
      const ok = item.type === 'video' ? await sendTelegramVideo(c === 0 ? caption : '', item.url) : await sendTelegramPhoto(c === 0 ? caption : '', item.url);
      allOk = allOk && ok;
      continue;
    }
    const media = chunkItems.map((item, i) => ({
      type: item.type === 'video' ? 'video' : 'photo',
      media: item.url,
      ...(c === 0 && i === 0 ? { caption } : {}),
    }));
    const url = `https://api.telegram.org/bot${token}/sendMediaGroup`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, media }),
      });
      if (!res.ok) {
        const errBody = await res.text();
        console.error('Telegram media group send failed:', res.status, errBody);
      }
      allOk = allOk && res.ok;
    } catch (err) {
      console.error('Telegram media group error:', err);
      allOk = false;
    }
  }
  return allOk;
}

// Called when someone taps the "posted / not posted" checkbox button on a
// story image message — edits that exact message's button to reflect the
// new state.
async function editTelegramMessageReplyMarkup(chatId, messageId, replyMarkup) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const url = `https://api.telegram.org/bot${token}/editMessageReplyMarkup`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: replyMarkup }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Edit reply markup failed:', res.status, errBody);
    }
    return res.ok;
  } catch (err) {
    console.error('Edit reply markup error:', err);
    return false;
  }
}

// Required by Telegram whenever a button is tapped — clears the little
// loading spinner on the button, optionally shows a brief toast.
async function answerTelegramCallbackQuery(callbackQueryId, text = '') {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const url = `https://api.telegram.org/bot${token}/answerCallbackQuery`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
    });
    return res.ok;
  } catch (err) {
    console.error('Answer callback query error:', err);
    return false;
  }
}

// One-time setup call — tells Telegram where to send button-tap events.
// See README for how/when to run this.
async function setTelegramWebhook(webhookUrl) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return false;
  const url = `https://api.telegram.org/bot${token}/setWebhook`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl }),
    });
    const data = await res.json();
    console.log('Telegram setWebhook result:', JSON.stringify(data));
    return res.ok;
  } catch (err) {
    console.error('setWebhook error:', err);
    return false;
  }
}

module.exports = { sendInstagramMessage, getClaudeReply, sendTelegramNotification, getInstagramUserProfile, sendTelegramPhoto, sendTelegramVideo, sendTelegramSpacer, sendTelegramStoryImage, sendTelegramMediaGroup, editTelegramMessageReplyMarkup, answerTelegramCallbackQuery, setTelegramWebhook, queueTelegramCall };

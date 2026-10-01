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
// extraSystemNote (optional): appended to the system prompt for this one
// call only — used for the language-correction retry below, so a rare
// retry doesn't affect the normal cached prompt.
async function getClaudeReply(history, extraSystemNote = '') {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      // Raised from 500: a reply can now combine the opening/disclosure
      // message with a full substantive answer in the same turn (e.g. a
      // first-ever message that already contains a real question, or the
      // 7-day greeting refresh), and Arabic text consumes meaningfully
      // more tokens per character than English, so 500 was genuinely at
      // risk of cutting a combined reply off mid-sentence before it
      // finished. 1000 gives real headroom for that case.
      max_tokens: 1000,
      // The system prompt (tabanni's whole knowledge base) is identical on
      // every single call and is by far the largest part of each request.
      // Marking it with cache_control lets Anthropic reuse it from cache
      // instead of reprocessing it from scratch every time — cached reads
      // cost 90% less than fresh input.
      system: extraSystemNote
        ? [{ type: 'text', text: SYSTEM_PROMPT + '\n\n' + extraSystemNote }]
        : [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: history,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    console.error('Claude API failed:', res.status, errBody);
    return "Hello! Thank you for reaching out — a team member will follow up with you shortly. 🐾";
  }

  const data = await res.json();

  const usage = data.usage;
  if (usage) {
    const cacheRead = usage.cache_read_input_tokens || 0;
    const cacheWrite = usage.cache_creation_input_tokens || 0;
    if (cacheRead > 0) {
      console.log(`💰 Prompt cache HIT — reused ${cacheRead} cached tokens (cheap).`);
    } else if (cacheWrite > 0) {
      console.log(`📝 Prompt cache MISS — wrote ${cacheWrite} tokens to cache for next time.`);
    }
  }

  const textBlocks = (data.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text);
  return textBlocks.join('\n').trim() ||
    "Hello! Thank you for reaching out — a team member will follow up with you shortly. 🐾";
}

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

async function sendTelegramSpacer() {
  await sendTelegramNotification('⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯');
}

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

async function sendTelegramAlertPhoto(caption, photoUrl, callbackData, offLabel) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.log('(Telegram not configured — skipping alert photo send.)');
    return null;
  }
  const url = `https://api.telegram.org/bot${token}/sendPhoto`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: photoUrl,
        caption,
        reply_markup: { inline_keyboard: [[{ text: offLabel, callback_data: callbackData }]] },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Telegram alert photo send failed:', res.status, errBody);
      return null;
    }
    const data = await res.json();
    return { chatId: data.result?.chat?.id, messageId: data.result?.message_id };
  } catch (err) {
    console.error('Telegram alert photo send error:', err);
    return null;
  }
}

async function sendTelegramNotificationWithButton(text, callbackData, offLabel) {
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
      body: JSON.stringify({
        chat_id: chatId,
        text,
        reply_markup: { inline_keyboard: [[{ text: offLabel, callback_data: callbackData }]] },
      }),
    });
    if (!res.ok) {
      const errBody = await res.text();
      console.error('Telegram notification (with button) failed:', res.status, errBody);
    }
    return res.ok;
  } catch (err) {
    console.error('Telegram notification (with button) error:', err);
    return false;
  }
}

module.exports = { sendInstagramMessage, getClaudeReply, sendTelegramNotification, getInstagramUserProfile, sendTelegramPhoto, sendTelegramVideo, sendTelegramSpacer, sendTelegramStoryImage, sendTelegramMediaGroup, editTelegramMessageReplyMarkup, answerTelegramCallbackQuery, setTelegramWebhook, queueTelegramCall, sendTelegramAlertPhoto, sendTelegramNotificationWithButton };

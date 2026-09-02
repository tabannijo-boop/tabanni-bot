const { SYSTEM_PROMPT } = require('./knowledge');

// Sends a text reply to a user on Instagram via the Graph API.
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
  }
  return res.ok;
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

module.exports = { sendInstagramMessage, getClaudeReply, sendTelegramNotification, getInstagramUserProfile };

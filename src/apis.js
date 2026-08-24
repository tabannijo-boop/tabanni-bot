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

module.exports = { sendInstagramMessage, getClaudeReply };

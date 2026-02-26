// src/telegram/templates.js
const TG_API = (token) => `https://api.telegram.org/bot${token}`;

async function tgApiCall(cfg, method, payload) {
  if (!cfg.TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");

  const url = `${TG_API(cfg.TELEGRAM_BOT_TOKEN)}/${method}`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) {
    const desc = j?.description || `${r.status} ${r.statusText}`;
    throw new Error(`Telegram API error: ${desc}`);
  }
  return j;
}

export async function tgSend(cfg, chatId, text, opts = {}) {
  // Telegram max message length ~4096. Facciamo chunking pulito.
  const chunks = splitTelegram(text, 3800);

  for (const chunk of chunks) {
    await tgApiCall(cfg, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      disable_web_page_preview: true,
      // parse_mode: "HTML" // se vuoi usare HTML escaping, abilitalo e fai escape.
      ...opts,
    });
  }
}

export async function tgSetWebhook(cfg) {
  if (!cfg.BASE_URL) throw new Error("Missing BASE_URL (needed for webhook)");
  if (!cfg.WEBHOOK_PATH) throw new Error("Missing WEBHOOK_PATH");

  const webhookUrl = `${cfg.BASE_URL.replace(/\/+$/, "")}${cfg.WEBHOOK_PATH}`;
  const payload = {
    url: webhookUrl,
  };

  // se usi secret token lato Telegram (consigliato):
  if (cfg.TG_SECRET) payload.secret_token = cfg.TG_SECRET;

  return tgApiCall(cfg, "setWebhook", payload);
}

export async function tgGetWebhookInfo(cfg) {
  return tgApiCall(cfg, "getWebhookInfo", {});
}

function splitTelegram(s, maxLen) {
  const text = String(s || "");
  if (text.length <= maxLen) return [text];

  const out = [];
  let buf = "";

  for (const line of text.split("\n")) {
    // +1 per il newline
    if ((buf.length + line.length + 1) > maxLen) {
      if (buf) out.push(buf);
      buf = line;
    } else {
      buf = buf ? (buf + "\n" + line) : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

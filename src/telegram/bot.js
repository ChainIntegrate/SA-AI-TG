import { parseCommand } from "./commands.js";
import { handleCommand } from "./commands.js";

function isAllowedChat(cfg, chatId) {
  if (!cfg.TELEGRAM_ALLOWED_CHAT_IDS?.length) return true; // se non setti allowlist
  return cfg.TELEGRAM_ALLOWED_CHAT_IDS.includes(String(chatId));
}

export async function handleTelegramWebhook({ req, res, cfg, db }) {
  try {
    if (cfg.TG_SECRET) {
      const got = String(req.headers["x-telegram-bot-api-secret-token"] || req.headers["x-tg-secret"] || "");
      if (got !== cfg.TG_SECRET) return res.status(401).json({ ok: false, error: "unauthorized" });
    }

    const update = req.body || {};
    const msg = update.message || update.edited_message;
    if (!msg?.text) return res.json({ ok: true });

    const chatId = msg.chat?.id;
    if (!isAllowedChat(cfg, chatId)) return res.json({ ok: true });

    const parsed = parseCommand(msg.text);
    await handleCommand({ cfg, db, chatId, user: msg.from, parsed });

    res.json({ ok: true });
  } catch (e) {
    console.error("[tg] webhook error:", e?.message || e);
    res.json({ ok: true });
  }
}

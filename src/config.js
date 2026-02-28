import dotenv from "dotenv";
dotenv.config();

export function loadConfig() {
  const PORT = Number(process.env.PORT || "3000");
  const BASE_URL = String(process.env.BASE_URL || "");
  const WEBHOOK_PATH = String(process.env.WEBHOOK_PATH || "/tg/webhook");
  const TG_SECRET = String(process.env.TG_SECRET || "");

  const TELEGRAM_BOT_TOKEN = String(process.env.TELEGRAM_BOT_TOKEN || "");
  const TELEGRAM_ALLOWED_CHAT_IDS = String(process.env.TELEGRAM_ALLOWED_CHAT_IDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  const DB_PATH = String(process.env.DB_PATH || "./data/ci_sales.sqlite");

  const FOLLOWUP_DAYS_DEFAULT = Number(process.env.FOLLOWUP_DAYS_DEFAULT || "5");
  const FOLLOWUP_CHECK_CRON = String(process.env.FOLLOWUP_CHECK_CRON || "0 9 * * *");

  const LLM_PROVIDER = String(process.env.LLM_PROVIDER || "none");
  const LLM_API_KEY = String(process.env.LLM_API_KEY || "");
  const LLM_MODEL = String(process.env.LLM_MODEL || "");

  const SEARCH_PROVIDER = String(process.env.SEARCH_PROVIDER || "none");
  // supporto esplicito Brave
  const BRAVE_API_KEY = String(process.env.BRAVE_API_KEY || "");
  // opzionale se in futuro avrai altri provider
  const SEARCH_API_KEY = String(process.env.SEARCH_API_KEY || "");

  return {
    PORT, BASE_URL, WEBHOOK_PATH, TG_SECRET,
    TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_IDS,
    DB_PATH,

    FOLLOWUP_DAYS_DEFAULT, FOLLOWUP_CHECK_CRON,

    LLM_PROVIDER, LLM_API_KEY, LLM_MODEL,

    SEARCH_PROVIDER,
    BRAVE_API_KEY,
    SEARCH_API_KEY
  };
}
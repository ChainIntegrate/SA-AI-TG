import express from "express";
import helmet from "helmet";
import cron from "node-cron";
import { loadConfig } from "./config.js";
import { initDb } from "./services/db.js";
import { handleTelegramWebhook } from "./telegram/bot.js";
import { runFollowupSweep } from "./core/followup.js";

const cfg = loadConfig();
const app = express();

app.use(helmet());
app.use(express.json({ limit: "1mb" }));

// init db (creates tables if missing)
const db = initDb(cfg.DB_PATH);

// health
app.get("/health", (req, res) => res.json({ ok: true, name: "ci-sales-agent" }));

// telegram webhook
app.post(cfg.WEBHOOK_PATH, (req, res) =>
  handleTelegramWebhook({ req, res, cfg, db })
);

// follow-up scheduler
cron.schedule(cfg.FOLLOWUP_CHECK_CRON, async () => {
  try {
    await runFollowupSweep({ cfg, db });
  } catch (e) {
    console.error("[followup] error:", e?.message || e);
  }
});

app.listen(cfg.PORT, () => {
  console.log(`ci-sales-agent listening on :${cfg.PORT}`);
  console.log(`telegram webhook: ${cfg.WEBHOOK_PATH}`);
});

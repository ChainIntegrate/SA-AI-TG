# CI Sales Agent (Telegram-only)

Bot Telegram per prospecting e posizionamento commerciale (Italia), con CRM leggero:
- /analizza <url> → crea scheda azienda + ruolo target + bozza LinkedIn
- memoria su SQLite
- follow-up automatici
- pipeline stati

## Setup
1) Node 18+
2) cp .env.example .env e compila TELEGRAM_BOT_TOKEN, DB_PATH
3) npm i
4) npm run start

## Webhook Telegram
Configura il webhook verso:
  https://TUODOMINIO/tg/webhook

Consigliato: Nginx reverse proxy e allowlist chatId.

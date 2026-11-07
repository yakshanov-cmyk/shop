#!/usr/bin/env bash
# Обновить только КОД бота в Cloudflare (секреты BOT_TOKEN, PAY_TEXT, WEBHOOK_SECRET, API_KEY и webhook не трогаются).
# Нужны: CF_TOKEN (API-токен «ItalBridge bot deploy»), CF_ACCOUNT (a7680d79328fd3c5884d181edac368cd).
set -euo pipefail
cd "$(dirname "$0")"
API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT"
H=(-H "Authorization: Bearer $CF_TOKEN")
META='{"main_module":"worker.js","compatibility_date":"2026-11-01","keep_bindings":["secret_text","kv_namespace","plain_text"]}'
curl -sS "${H[@]}" -X PUT "$API/workers/scripts/italbridge" \
  -F "metadata=$META;type=application/json" \
  -F "worker.js=@worker.js;type=application/javascript+module" | python3 -c "import sys,json;d=json.load(sys.stdin);print('upload ok' if d['success'] else d['errors'])"

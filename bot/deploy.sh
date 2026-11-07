#!/usr/bin/env bash
# Выкладка бота ItalBridge в Cloudflare Workers через API.
# Нужны переменные окружения: CF_TOKEN, CF_ACCOUNT, BOT_TOKEN, PAY_TEXT. Секреты WEBHOOK_SECRET и API_KEY берутся из .secrets (создаются при первом запуске).
set -euo pipefail
cd "$(dirname "$0")"
API="https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT"
H=(-H "Authorization: Bearer $CF_TOKEN")
NAME=italbridge

[ -f .secrets ] || python3 -c "import secrets;print('WEBHOOK_SECRET='+secrets.token_hex(24));print('API_KEY='+secrets.token_hex(24))" > .secrets
source .secrets; export WEBHOOK_SECRET API_KEY

# 1. KV
NS=$(curl -sS "${H[@]}" "$API/storage/kv/namespaces?per_page=100" | python3 -c "import sys,json;print(next((n['id'] for n in json.load(sys.stdin)['result'] if n['title']=='$NAME'),''))")
if [ -z "$NS" ]; then
  NS=$(curl -sS "${H[@]}" -H "Content-Type: application/json" -X POST "$API/storage/kv/namespaces" -d "{\"title\":\"$NAME\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['result']['id'])")
fi
echo "KV: $NS"

# 2. Скрипт + привязки
META=$(NS="$NS" python3 - <<'PY'
import json, os
print(json.dumps({
 "main_module": "worker.js", "compatibility_date": "2026-11-01",
 "bindings": [
  {"type":"kv_namespace","name":"DB","namespace_id":os.environ["NS"]},
  {"type":"plain_text","name":"OWNER_ID","text":"568002310"},
  {"type":"plain_text","name":"MANAGER","text":"LanaY777"},
  {"type":"plain_text","name":"LANA_USERNAME","text":"LanaY777"},
  {"type":"secret_text","name":"BOT_TOKEN","text":os.environ["BOT_TOKEN"]},
  {"type":"secret_text","name":"WEBHOOK_SECRET","text":os.environ["WEBHOOK_SECRET"]},
  {"type":"secret_text","name":"API_KEY","text":os.environ["API_KEY"]},
  {"type":"secret_text","name":"PAY_TEXT","text":os.environ["PAY_TEXT"]},
 ]}))
PY
)
export WEBHOOK_SECRET API_KEY
curl -sS "${H[@]}" -X PUT "$API/workers/scripts/$NAME" \
  -F "metadata=$META;type=application/json" \
  -F "worker.js=@worker.js;type=application/javascript+module" | python3 -c "import sys,json;d=json.load(sys.stdin);print('upload ok' if d['success'] else d['errors'])"

# 3. Расписание: 10:00 и 18:00 МСК (сводка утром, напоминания о просрочках)
curl -sS "${H[@]}" -H "Content-Type: application/json" -X PUT "$API/workers/scripts/$NAME/schedules" \
  -d '[{"cron":"0 7 * * *"},{"cron":"0 15 * * *"}]' | python3 -c "import sys,json;d=json.load(sys.stdin);print('cron ok' if d['success'] else d['errors'])"

# 4. Поддомен workers.dev
SUB=$(curl -sS "${H[@]}" "$API/workers/subdomain" | python3 -c "import sys,json;d=json.load(sys.stdin);print((d.get('result') or {}).get('subdomain') or '')")
if [ -z "$SUB" ]; then
  SUB="italbridge-$(python3 -c 'import secrets;print(secrets.token_hex(3))')"
  curl -sS "${H[@]}" -H "Content-Type: application/json" -X PUT "$API/workers/subdomain" -d "{\"subdomain\":\"$SUB\"}" | python3 -c "import sys,json;d=json.load(sys.stdin);print('subdomain ok' if d['success'] else d['errors'])"
fi
curl -sS "${H[@]}" -H "Content-Type: application/json" -X POST "$API/workers/scripts/$NAME/subdomain" -d '{"enabled":true}' >/dev/null
URL="https://$NAME.$SUB.workers.dev"
echo "URL: $URL"
echo "URL=$URL" > .url

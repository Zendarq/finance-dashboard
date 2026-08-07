#!/usr/bin/env bash
# Deploy finance-dashboard to the VPS: pull latest from GitHub, restart service.
set -euo pipefail

echo "→ pulling latest on VPS…"
ssh vps 'cd /opt/finance-dashboard && git pull -q origin main && venv/bin/pip install -q -r requirements.txt && systemctl restart finance-dashboard && sleep 4 && systemctl is-active finance-dashboard'

echo "→ verifying from outside…"
curl -sf -o /dev/null -w "https://finance.zendarq.online → HTTP %{http_code} (%{time_total}s)\n" https://finance.zendarq.online/
echo "Deployed ✓"

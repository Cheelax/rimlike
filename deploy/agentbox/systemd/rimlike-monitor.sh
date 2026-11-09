#!/bin/sh
# Surveillance minimale de l'hébergement rimlike (timer système, 5 min) :
# /health local du pod et /ready du tunnel. Alerte seulement aux CHANGEMENTS
# d'état (panne, puis rétablissement), via la file agent-notify existante de
# l'utilisateur agent (Telegram + Discord) : aucun secret recopié ici.
set -u
STATE_DIR=${STATE_DIRECTORY:-/var/lib/rimlike-monitor}
problems=""
if ! health=$(curl -fsS -m 10 http://127.0.0.1:8790/health 2>/dev/null); then
  problems="serveur injoignable (127.0.0.1:8790/health)"
elif [ "$(printf '%s' "$health" | jq -r .ok 2>/dev/null)" != true ]; then
  problems="/health ne répond pas ok"
fi
if systemctl is-enabled --quiet cloudflared-rimlike.service 2>/dev/null; then
  if ! curl -fsS -m 10 -o /dev/null http://127.0.0.1:20242/ready 2>/dev/null; then
    problems="${problems:+$problems ; }tunnel cloudflared-rimlike non connecté"
  fi
fi
now=${problems:-ok}
before=$(cat "$STATE_DIR/last" 2>/dev/null || echo ok)
printf '%s\n' "$now" > "$STATE_DIR/last"
[ "$now" = "$before" ] && exit 0
if [ "$now" = ok ]; then
  text="✅ rimlike (agentbox) rétabli"
else
  text="🔴 rimlike (agentbox) : $now — sudo rimlike-ctl status"
fi
logger -t rimlike-monitor "$text"
runuser -u agent -- env HOME=/home/agent AGENTBOX_NOTIFY_FROM_HOOK=1 /home/agent/.local/bin/agent-notify "$text" || true

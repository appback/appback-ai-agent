#!/bin/sh
set -eu

profile="${APPBACK_AGENT_PROFILE:-balanced}"
variation="${APPBACK_AGENT_VARIATION:-0}"

mkdir -p /app/config /app/data /app/models /app/training

if [ ! -f /app/config/personality.json ]; then
  appback-ai-agent personality set "$profile" --variation "$variation"
fi

exec appback-ai-agent start


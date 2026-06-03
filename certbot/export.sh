#!/bin/sh
set -eu

SRC="/etc/letsencrypt/live/${SMTP_HOSTNAME}"
DST="/certs"
CHAIN_TMP="$DST/smtp.pem.tmp"
CHAIN_DST="$DST/smtp.pem"
TRIGGER_TMP="$DST/postfix.reload.tmp"
TRIGGER_DST="$DST/postfix.reload"

if [ -z "${SMTP_HOSTNAME:-}" ]; then
  echo "SMTP_HOSTNAME not set"
  exit 1
fi

mkdir -p "$DST"

while true; do
  if [ -f "$SRC/fullchain.pem" ] && [ -f "$SRC/privkey.pem" ]; then
    cat "$SRC/privkey.pem" "$SRC/fullchain.pem" > "$CHAIN_TMP"

    chmod 600 "$CHAIN_TMP" || true

    if ! cmp -s "$CHAIN_TMP" "$CHAIN_DST" 2>/dev/null; then
      mv "$CHAIN_TMP" "$CHAIN_DST"
      date -Iseconds > "$TRIGGER_TMP"
      mv "$TRIGGER_TMP" "$TRIGGER_DST"
    else
      rm -f "$CHAIN_TMP"
    fi
  fi

  sleep 60
done

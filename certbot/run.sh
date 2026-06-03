#!/bin/sh
set -eu

TOKEN="$(cat /run/secrets/cloudflare_api_token)"

if [ -z "${SMTP_HOSTNAME:-}" ] || [ -z "${CERT_EMAIL:-}" ]; then
  echo "SMTP_HOSTNAME and CERT_EMAIL must be set"
  exit 1
fi

mkdir -p /run/cf
printf "dns_cloudflare_api_token = %s\n" "$TOKEN" > /run/cf/cloudflare.ini
chmod 600 /run/cf/cloudflare.ini

issue_cert() {
  certbot certonly \
    --non-interactive \
    --agree-tos \
    --email "$CERT_EMAIL" \
    --dns-cloudflare \
    --dns-cloudflare-credentials /run/cf/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30 \
    -d "$SMTP_HOSTNAME"
}

if [ ! -f "/etc/letsencrypt/live/$SMTP_HOSTNAME/fullchain.pem" ]; then
  echo "[certbot] [$(date '+%Y-%m-%d %H:%M:%S')] issuing new cert for $SMTP_HOSTNAME"
  issue_cert
fi

while true; do
  echo "[certbot] [$(date '+%Y-%m-%d %H:%M:%S')] checking renewal"
  certbot renew \
    --dns-cloudflare \
    --dns-cloudflare-credentials /run/cf/cloudflare.ini \
    --dns-cloudflare-propagation-seconds 30
  sleep 12h
done

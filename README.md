# dmarcoapp/mail-inbound

Self-hostable inbound mail gateway for DMARC aggregate reports.

It accepts mail for one domain, keeps Postfix inbound-only, stores accepted report files in S3-compatible storage, and sends a signed webhook to your application.

## Overview

```text
Internet -> Postfix -> maildrop -> Node processor -> ClamAV -> S3 -> webhook
```

Services:

- `postfix`: SMTP listener on port `25`
- `processor`: Node.js worker that reads queued `.eml` files
- `clamav`: antivirus scanner
- `certbot` and `cert_exporter`: Let's Encrypt automation for Postfix TLS
- `webhook-dev` and `minio`: optional local development services

Only likely DMARC aggregate reports are forwarded.

## Get Started

Create a deployment directory and download the example environment file:

```bash
mkdir mail-inbound
cd mail-inbound
curl -fsSL https://raw.githubusercontent.com/dmarcoapp/mail-inbound/main/.env.example -o .env
mkdir -p clamav
curl -fsSL https://raw.githubusercontent.com/dmarcoapp/mail-inbound/main/clamav/clamd.conf -o clamav/clamd.conf
curl -fsSL https://raw.githubusercontent.com/dmarcoapp/mail-inbound/main/clamav/freshclam.conf -o clamav/freshclam.conf
nano .env
```

Copy this `docker-compose.yml` into the same directory:

```yaml
name: dmarco-mail-inbound

services:
  postfix:
    image: ghcr.io/dmarcoapp/mail-inbound/postfix:latest
    container_name: mail-postfix
    env_file:
      - .env
    volumes:
      - certs_shared:/certs:ro
      - maildrop:/maildrop
    ports:
      - "25:25"
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "/usr/local/bin/healthcheck-mail-stack"]
      interval: 30s
      timeout: 10s
      retries: 3

  processor:
    image: ghcr.io/dmarcoapp/mail-inbound/processor:latest
    container_name: mail-processor
    env_file:
      - .env
    secrets:
      - webhook_secret
      - s3_access_key
      - s3_secret_key
    depends_on:
      clamav:
        condition: service_started
    volumes:
      - maildrop:/maildrop
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "node", "src/processorHealthcheck.js"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 75s

  certbot:
    image: ghcr.io/dmarcoapp/mail-inbound/certbot:latest
    container_name: certbot-cloudflare
    env_file:
      - .env
    secrets:
      - cloudflare_api_token
    volumes:
      - letsencrypt:/etc/letsencrypt
      - letsencrypt_lib:/var/lib/letsencrypt
    restart: unless-stopped

  cert_exporter:
    image: ghcr.io/dmarcoapp/mail-inbound/cert-exporter:latest
    container_name: cert-exporter
    env_file:
      - .env
    depends_on:
      certbot:
        condition: service_started
    volumes:
      - letsencrypt:/etc/letsencrypt:ro
      - certs_shared:/certs
    restart: unless-stopped

  clamav:
    image: clamav/clamav-debian:1.4
    container_name: clamav
    restart: unless-stopped
    volumes:
      - ./clamav/clamd.conf:/etc/clamav/clamd.conf:ro
      - ./clamav/freshclam.conf:/etc/clamav/freshclam.conf:ro
      - clamav_data:/var/lib/clamav
    healthcheck:
      test: ["CMD", "clamdscan", "--version"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  letsencrypt:
  letsencrypt_lib:
  certs_shared:
  maildrop:
  clamav_data:

secrets:
  webhook_secret:
    file: ./secrets/webhook_secret.txt

  s3_access_key:
    file: ./secrets/s3_access_key.txt

  s3_secret_key:
    file: ./secrets/s3_secret_key.txt

  cloudflare_api_token:
    file: ./secrets/cloudflare_token.txt
```

Review these values in `.env`:

- `SMTP_HOSTNAME`: public MX hostname, for example `mx.example.com`
- `ACCEPTED_RCPT_DOMAIN`: domain this server accepts mail for
- `WEBHOOK_URL`: downstream webhook endpoint
- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`: object storage target
- `CERT_EMAIL`: Let's Encrypt registration email

The example uses `SMTP_TLS_MODE=real` for the built-in Let's Encrypt flow. It uses Cloudflare DNS validation and expects `secrets/cloudflare_token.txt`.

Other Postfix TLS modes:

- `SMTP_TLS_MODE=external`: use a mounted chain file from `SMTP_TLS_CHAIN_FILE`
- `SMTP_TLS_MODE=self-signed`: generate a short-lived local certificate
- `SMTP_TLS_MODE=disabled`: start SMTP without STARTTLS

Create the Docker secret files and start the stack:

```bash
mkdir -p secrets
printf '<strong webhook secret>\n' > secrets/webhook_secret.txt
printf '<s3 access key>\n' > secrets/s3_access_key.txt
printf '<s3 secret key>\n' > secrets/s3_secret_key.txt
printf '<cloudflare dns token>\n' > secrets/cloudflare_token.txt
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f postfix processor
```

Create DNS records for inbound mail routing. For example, with `ACCEPTED_RCPT_DOMAIN=example.com` and `SMTP_HOSTNAME=mx.example.com`:

- `A` record: `mx.example.com` -> your server's public IPv4 address
- `AAAA` record: `mx.example.com` -> your server's public IPv6 address, if the server accepts IPv6 SMTP
- `MX` record: `example.com` -> `mx.example.com` with priority `10`

Make sure TCP port `25` reaches the host. If `SMTP_TLS_MODE=real`, the Cloudflare DNS token must be able to create DNS validation records for `SMTP_HOSTNAME`.

`WEBHOOK_URL` and `S3_ENDPOINT` may use plain HTTP on a trusted internal network. This app does not enforce TLS for those endpoints.

Before exposing the service:

- Use strong Docker secret values.
- Create the S3 bucket.
- Confirm your webhook validates `X-Signature`.
- Confirm DNS, MX, firewall, and port `25` routing.

## Development

Install dependencies and run tests:

```bash
npm install
npm test
```

For local Docker development without ACME credentials:

```bash
cp .env.example .env
mkdir -p secrets
printf 'dev-webhook-secret\n' > secrets/webhook_secret.txt
printf 'dev-access-key\n' > secrets/s3_access_key.txt
printf 'dev-secret-key\n' > secrets/s3_secret_key.txt
printf 'unused\n' > secrets/cloudflare_token.txt
```

Set local-friendly values in `.env`:

```env
SMTP_TLS_MODE=self-signed
```

Then start the local development stack with MinIO and a mock webhook receiver:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build postfix processor clamav minio minio-init webhook-dev
```

MinIO is available at `http://localhost:9001` with `dev-access-key` / `dev-secret-key`. The dev webhook receiver listens on `http://localhost:3000/inbound-email`.

Useful commands:

```bash
npm run lint
npm run coverage
npm run replay-dead-letter
```

## Configuration

Copy `.env.example` to `.env`. Optional overrides can go in `.env.local`; both Docker Compose and direct Node runs load it.

Common settings:

- `MAX_MESSAGE_BYTES`: SMTP message size limit
- `REQUIRE_ATTACHMENTS`: require at least one attachment
- `MAX_ATTACHMENTS`: accepted attachment count
- `ALLOWED_ATTACHMENT_EXTENSIONS`: default `.xml,.zip,.gz,.gzip`
- `MAX_XML_BYTES`: extracted XML size limit
- `MAX_COMPRESSION_RATIO`: archive expansion limit
- `CLAMAV_SCAN_ENABLED`: enable ClamAV scanning
- `PROCESSOR_MAX_RETRIES`: retry limit before dead-lettering
- `PROCESSOR_METRICS_LOG_MS`: interval for processor summary metric logs, or `0` to disable

Docker secrets are mounted as:

- `/run/secrets/webhook_secret`
- `/run/secrets/s3_access_key`
- `/run/secrets/s3_secret_key`
- `/run/secrets/cloudflare_api_token`

## Webhook

Accepted reports create a signed `POST` request to `WEBHOOK_URL`.

Headers:

- `X-Timestamp`: Unix epoch seconds
- `X-Request-Id`: same value as `email_id`
- `X-Signature`: `sha256=<hex>`

Signature:

```text
HMAC_SHA256(timestamp + "." + raw_body, WEBHOOK_SECRET)
```

Payload includes `email_id`, `created_at`, `from`, `to`, `message_id`, `report_type`, and uploaded `attachments`.

Example payload:

```json
{
  "email_id": "f00dad2064a5c04ad0ef367abe88f46d778d361069036fc59e10bba10b0a8fb1",
  "created_at": "2026-06-03T18:45:00.000Z",
  "from": "Example Reports <reports@example.net>",
  "to": ["dmarc@example.com"],
  "message_id": "<report-20260603@example.net>",
  "report_type": "dmarc_aggregate",
  "attachments": [
    {
      "id": "4f7c3ef4-5f9c-41fb-a61a-1d6c75f8f0b7",
      "bucket": "mail",
      "key": "attachments/4f7c3ef4-5f9c-41fb-a61a-1d6c75f8f0b7",
      "filename": "example.net!example.com!1717372800!1717459199.xml",
      "content_type": "application/xml"
    }
  ]
}
```

## Message Handling

- Postfix accepts mail only for `ACCEPTED_RCPT_DOMAIN`; outbound relay is disabled.
- Each message is scanned with ClamAV before any attachment is uploaded or delivered.
- Attachments must match the configured allowlist and are limited by count and size.
- ZIP and gzip reports are extracted and normalized to XML before upload.
- Oversized attachments, unsafe archive expansion, malformed archives, and non-DMARC XML are rejected.
- Temporary S3, webhook, scanner, and DNS failures are retried; exhausted messages move to the dead-letter directory.
- The webhook is a delivery signal, not a trust boundary. Your downstream app should still validate and parse the DMARC report before using it.

## License

Licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

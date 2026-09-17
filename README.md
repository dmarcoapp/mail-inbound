<p align="center">
  <img src=".github/logo.svg" alt="" width="80" height="80">
</p>

<h1 align="center">DMARCo Mail Inbound</h1>

<p align="center">
  Self-hosted inbound mail gateway for DMARC aggregate reports.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue.svg"></a>
  <a href="https://github.com/dmarcoapp/mail-inbound/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/dmarcoapp/mail-inbound/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/dmarcoapp/mail-inbound/pkgs/container/mail-inbound%2Fprocessor"><img alt="Container images" src="https://img.shields.io/badge/ghcr.io-dmarcoapp%2Fmail--inbound-1f6feb"></a>
</p>

> [!IMPORTANT]
> **Start at [dmarcoapp/dmarcoapp](https://github.com/dmarcoapp/dmarcoapp).**
> That repository installs all of DMARCo with one command: this mail gateway,
> the backend, and the dashboard. It is also the issue tracker for the whole
> project, so
> [report anything that goes wrong there](https://github.com/dmarcoapp/dmarcoapp/issues/new/choose),
> including problems in this component. What follows is one component's source,
> for people working on it.

This gateway accepts mail for one domain, scans every message, keeps what looks
like a DMARC aggregate report and rejects the rest, then uploads what it kept to
S3-compatible storage and announces it with a signed webhook. Postfix is
inbound-only and never relays.

It runs as part of DMARCo, or in front of any application that would rather
receive DMARC reports as a webhook than as email.

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

## Features

- Inbound-only Postfix: mail is accepted for one domain, outbound relay is
  disabled
- ClamAV scanning of every message before anything is uploaded or delivered
- Attachment allowlist with count, size, and archive expansion limits
- ZIP and gzip reports extracted and normalized to XML
- Non-DMARC XML, malformed archives, and oversized attachments rejected
- S3-compatible upload of accepted report files
- Signed webhook delivery with an HMAC signature and a replay timestamp
- Retries with a dead-letter directory, and a replay command for it
- Let's Encrypt automation for SMTP TLS, plus external, self-signed, and
  disabled modes
- Container health checks and periodic processor metrics

## Requirements

- A Linux server with Docker and Docker Compose v2
- A public IPv4 address with inbound TCP port `25` reaching the host. Many
  providers block port `25` until you ask them to open it
- A domain you can add `A` and `MX` records to, receiving no other mail
- Roughly 2 GB of memory, most of it for the ClamAV signature database
- S3-compatible object storage, and an endpoint that accepts the webhook
- A Cloudflare DNS API token, only for `SMTP_TLS_MODE=real`

## Get started

> [!TIP]
> Installing DMARCo itself? Use
> [`dmarcoapp/dmarcoapp`](https://github.com/dmarcoapp/dmarcoapp) instead. It
> runs this gateway together with the backend and the dashboard, and generates
> the secrets for you. Follow the steps below only when you want the gateway on
> its own, in front of your own application.

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

Review these values in `.env`:

- `SMTP_HOSTNAME`: public MX hostname, for example `mx.example.com`
- `ACCEPTED_RCPT_DOMAIN`: domain this server accepts mail for
- `WEBHOOK_URL`: downstream webhook endpoint
- `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`: object storage target
- `CERT_EMAIL`: Let's Encrypt registration email

Put this `docker-compose.yml` in the same directory. It runs the published
images, so nothing has to be built on the server.

<details>
<summary><code>docker-compose.yml</code> for the published images</summary>

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
</details>

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

Create DNS records for inbound mail routing. For example, with
`ACCEPTED_RCPT_DOMAIN=example.com` and `SMTP_HOSTNAME=mx.example.com`:

| Type | Name | Value |
| --- | --- | --- |
| `A` | `mx.example.com` | your server's public IPv4 address |
| `AAAA` | `mx.example.com` | your public IPv6 address, if the server accepts IPv6 SMTP |
| `MX` | `example.com` | `mx.example.com` with priority `10` |

Make sure TCP port `25` reaches the host. If `SMTP_TLS_MODE=real`, the
Cloudflare DNS token must be able to create DNS validation records for
`SMTP_HOSTNAME`.

## Configuration

Copy `.env.example` to `.env`. Optional overrides can go in `.env.local`; both
Docker Compose and direct Node runs load it.

Common settings:

- `MAX_MESSAGE_BYTES`: SMTP message size limit
- `REQUIRE_ATTACHMENTS`: require at least one attachment
- `MAX_ATTACHMENTS`: accepted attachment count
- `ALLOWED_ATTACHMENT_EXTENSIONS`: default `.xml,.zip,.gz,.gzip`
- `MAX_XML_BYTES`: extracted XML size limit
- `MAX_COMPRESSION_RATIO`: archive expansion limit
- `CLAMAV_SCAN_ENABLED`: enable ClamAV scanning
- `PROCESSOR_MAX_RETRIES`: retry limit before dead-lettering
- `PROCESSOR_METRICS_LOG_MS`: interval for processor summary metric logs, or `0`
  to disable

Postfix TLS modes:

- `SMTP_TLS_MODE=real`: built-in Let's Encrypt flow, which uses Cloudflare DNS
  validation and expects `secrets/cloudflare_token.txt`
- `SMTP_TLS_MODE=external`: use a mounted chain file from `SMTP_TLS_CHAIN_FILE`
- `SMTP_TLS_MODE=self-signed`: generate a short-lived local certificate
- `SMTP_TLS_MODE=disabled`: start SMTP without STARTTLS

Docker secrets are mounted as:

- `/run/secrets/webhook_secret`
- `/run/secrets/s3_access_key`
- `/run/secrets/s3_secret_key`
- `/run/secrets/cloudflare_api_token`

`WEBHOOK_URL` and `S3_ENDPOINT` may use plain HTTP on a trusted internal
network. This app does not enforce TLS for those endpoints.

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

Payload includes `email_id`, `created_at`, `from`, `to`, `message_id`,
`report_type`, and uploaded `attachments`.

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

If you use [`dmarcoapp/backend`](https://github.com/dmarcoapp/backend), point
`WEBHOOK_URL` at its `/v1/webhook/inbound_report_email` endpoint and use the
same secret on both sides.

## Message handling

- Postfix accepts mail only for `ACCEPTED_RCPT_DOMAIN`; outbound relay is
  disabled.
- Each message is scanned with ClamAV before any attachment is uploaded or
  delivered.
- Attachments must match the configured allowlist and are limited by count and
  size.
- ZIP and gzip reports are extracted and normalized to XML before upload.
- Oversized attachments, unsafe archive expansion, malformed archives, and
  non-DMARC XML are rejected, so only messages that look like DMARC aggregate
  reports are forwarded.
- Temporary S3, webhook, scanner, and DNS failures are retried; exhausted
  messages move to the dead-letter directory.
- The webhook is a delivery signal, not a trust boundary. Your downstream app
  should still validate and parse the DMARC report before using it.

## Production

Images are published to `ghcr.io/dmarcoapp/mail-inbound/postfix`, `/processor`,
`/certbot`, and `/cert-exporter` on every GitHub release, tagged with the
release version and `latest`. Pin the tags in `docker-compose.yml` if you would
rather decide when new versions land.

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

MinIO is available at `http://localhost:9001` with `dev-access-key` /
`dev-secret-key`. The dev webhook receiver listens on
`http://localhost:3000/inbound-email`.

Before opening a pull request, run what CI runs:

```bash
npm run lint
npm test
npm run coverage
```

Other useful commands:

```bash
npm run replay-dead-letter
```

Coding standards are in [`AGENTS.md`](AGENTS.md), and the contribution guide is
in [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Related projects

- [`dmarcoapp/dmarcoapp`](https://github.com/dmarcoapp/dmarcoapp): ready-made
  Docker Compose stack and installer for the full application
- [`dmarcoapp/backend`](https://github.com/dmarcoapp/backend): API, workers, and
  report processing pipeline
- [`dmarcoapp/dashboard`](https://github.com/dmarcoapp/dashboard): web UI for
  reviewing DMARC aggregate reports

## License

Licensed under the Apache License, Version 2.0. See [`LICENSE`](LICENSE) and
[`NOTICE`](NOTICE).

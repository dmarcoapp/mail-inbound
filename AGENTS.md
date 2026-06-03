# AI Contribution Guidelines / Agent Instructions

Guidelines for AI assistants contributing to DMARCo Mail Inbound.

## Project Structure & Design
- DMARCo Mail Inbound is an inbound only mail server written in Javascript (Node).
- Its purpose is to safely receive mail from external sources and forward it to a backend application.

## Deployment Constraints
- Do not enforce TLS by default for `WEBHOOK_URL` or `S3_ENDPOINT`.
- In this project, those endpoints may legitimately run over plain HTTP on an internal Docker network, where global TLS enforcement would break valid deployments.

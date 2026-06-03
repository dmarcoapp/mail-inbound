FROM node:24-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src

# Non-root user
RUN addgroup -S -g 10001 app && adduser -S -u 10001 app -G app \
  && mkdir -p /tmp/mail-inbound-webhook /maildrop/incoming /maildrop/dead-letter \
  && chown -R app:app /app /tmp/mail-inbound-webhook /maildrop

USER app

CMD ["node","src/bootstrap.js"]

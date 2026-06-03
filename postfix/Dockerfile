FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN echo "postfix postfix/mailname string localhost" | debconf-set-selections \
    && echo "postfix postfix/main_mailer_type select Internet Site" | debconf-set-selections \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        postfix \
        supervisor \
        ca-certificates \
        openssl \
        gettext-base \
    && cp /etc/postfix/master.cf /etc/postfix/master.cf.dist \
    && rm -rf /var/lib/apt/lists/*

COPY postfix/main.cf.template /etc/postfix/main.cf.template
COPY postfix/master.cf.append /etc/postfix/master.cf.append
COPY postfix/drop-message /usr/local/bin/drop-message
COPY postfix/run.sh /usr/local/bin/run-mail-stack
COPY postfix/healthcheck.sh /usr/local/bin/healthcheck-mail-stack
COPY postfix/supervisord.conf /etc/supervisor/conf.d/mail-stack.conf

RUN chmod 755 \
        /usr/local/bin/drop-message \
        /usr/local/bin/healthcheck-mail-stack \
        /usr/local/bin/run-mail-stack \
    && chmod 0644 \
        /etc/postfix/main.cf.template \
        /etc/postfix/master.cf.append \
    && mkdir -p \
        /maildrop/incoming

EXPOSE 25

CMD ["/usr/local/bin/run-mail-stack"]

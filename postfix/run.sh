#!/bin/sh
set -eu

: "${ACCEPTED_RCPT_DOMAIN:?ACCEPTED_RCPT_DOMAIN is required}"

SMTP_HOSTNAME="${SMTP_HOSTNAME:-mail.${ACCEPTED_RCPT_DOMAIN}}"
MAX_MESSAGE_BYTES="${MAX_MESSAGE_BYTES:-10485760}"
ANVIL_RATE_TIME_UNIT="${ANVIL_RATE_TIME_UNIT:-60s}"
SMTPD_CLIENT_CONNECTION_COUNT_LIMIT="${SMTPD_CLIENT_CONNECTION_COUNT_LIMIT:-20}"
SMTPD_CLIENT_CONNECTION_RATE_LIMIT="${SMTPD_CLIENT_CONNECTION_RATE_LIMIT:-60}"
SMTPD_TIMEOUT="${SMTPD_TIMEOUT:-60s}"
SMTP_TLS_MODE="${SMTP_TLS_MODE:-real}"
SMTPD_TLS_SECURITY_LEVEL="may"
SMTP_TLS_CHAIN_LINE=''
SMTP_TLS_CHAIN_FILE="${SMTP_TLS_CHAIN_FILE:-/certs/smtp.pem}"
CERT_RELOAD_ENABLED=0
SELF_SIGNED_CERT_DAYS="${SELF_SIGNED_CERT_DAYS:-7}"
DEV_CERT_DIR="/var/lib/postfix/dev-certs"
DEV_CERT_KEY="$DEV_CERT_DIR/privkey.pem"
DEV_CERT_CERT="$DEV_CERT_DIR/fullchain.pem"
DEV_CERT_CHAIN="$DEV_CERT_DIR/smtp.pem"

export SMTP_HOSTNAME
export ACCEPTED_RCPT_DOMAIN
export MAX_MESSAGE_BYTES
export ANVIL_RATE_TIME_UNIT
export SMTPD_CLIENT_CONNECTION_COUNT_LIMIT
export SMTPD_CLIENT_CONNECTION_RATE_LIMIT
export SMTPD_TIMEOUT
export SMTPD_TLS_SECURITY_LEVEL
export SMTP_TLS_CHAIN_LINE

CERT_WAIT_TIMEOUT="${CERT_WAIT_TIMEOUT:-300}"
CERT_WAIT_STEP=2
CERT_RELOAD_TRIGGER="/certs/postfix.reload"
CERT_RELOAD_POLL_SECONDS="${CERT_RELOAD_POLL_SECONDS:-5}"

wait_for_chain_file() {
    chain_file="$1"
    waited=0
    while [ ! -s "$chain_file" ] || [ ! -r "$chain_file" ]; do
        if [ "$waited" -ge "$CERT_WAIT_TIMEOUT" ]; then
            echo "[postfix] [$(date -Iseconds)] certificate chain file not available after ${CERT_WAIT_TIMEOUT}s: ${chain_file}" >&2
            exit 1
        fi

        echo "[postfix] [$(date -Iseconds)] waiting for certificate chain file: ${chain_file}" >&2
        sleep "$CERT_WAIT_STEP"
        waited=$((waited + CERT_WAIT_STEP))
    done
}

cp /etc/postfix/master.cf.dist /etc/postfix/master.cf
sed -i 's/^[[:space:]]*smtp[[:space:]]\+inet[[:space:]].*smtpd$/smtp      inet  n       -       y       -       1       postscreen/' /etc/postfix/master.cf
cat /etc/postfix/master.cf.append >> /etc/postfix/master.cf

mkdir -p /maildrop/incoming /maildrop/incoming/.tmp /maildrop/dead-letter
# The processor claims queued files via rename(). Sticky-bit protection on the
# shared inbox blocks that cross-user rename because Postfix writes as nobody.
chmod 0755 /maildrop
chmod 0777 /maildrop/incoming
chmod 1777 /maildrop/incoming/.tmp
# The processor image runs as uid/gid 10001 and is the only writer here.
chown 10001:10001 /maildrop/dead-letter
chmod 0755 /maildrop/dead-letter

mkdir -p /var/spool/postfix/etc
for f in resolv.conf hosts services nsswitch.conf; do
    if [ -f "/etc/$f" ]; then
        cp "/etc/$f" "/var/spool/postfix/etc/$f"
    fi
done

case "$SMTP_TLS_MODE" in
    real)
        wait_for_chain_file /certs/smtp.pem
        SMTP_TLS_CHAIN_LINE='smtpd_tls_chain_files = /certs/smtp.pem'
        CERT_RELOAD_ENABLED=1
        ;;
    external)
        wait_for_chain_file "$SMTP_TLS_CHAIN_FILE"
        SMTP_TLS_CHAIN_LINE="smtpd_tls_chain_files = ${SMTP_TLS_CHAIN_FILE}"
        ;;
    self-signed)
        mkdir -p "$DEV_CERT_DIR"
        if [ ! -s "$DEV_CERT_CHAIN" ] || [ ! -r "$DEV_CERT_CHAIN" ]; then
            echo "[postfix] [$(date -Iseconds)] generating self-signed development certificate for ${SMTP_HOSTNAME}" >&2
            openssl req \
                -x509 \
                -newkey rsa:2048 \
                -nodes \
                -days "$SELF_SIGNED_CERT_DAYS" \
                -subj "/CN=${SMTP_HOSTNAME}" \
                -keyout "$DEV_CERT_KEY" \
                -out "$DEV_CERT_CERT" >/dev/null 2>&1
            cat "$DEV_CERT_KEY" "$DEV_CERT_CERT" > "$DEV_CERT_CHAIN"
            chmod 700 "$DEV_CERT_DIR"
            chmod 600 "$DEV_CERT_KEY" "$DEV_CERT_CERT" "$DEV_CERT_CHAIN"
        fi
        chown -R postfix:postfix "$DEV_CERT_DIR"
        SMTP_TLS_CHAIN_LINE="smtpd_tls_chain_files = ${DEV_CERT_CHAIN}"
        ;;
    disabled)
        SMTPD_TLS_SECURITY_LEVEL='none'
        SMTP_TLS_CHAIN_LINE=''
        ;;
    *)
        echo "[postfix] [$(date -Iseconds)] invalid SMTP_TLS_MODE: ${SMTP_TLS_MODE}" >&2
        exit 1
        ;;
esac

export SMTPD_TLS_SECURITY_LEVEL
export SMTP_TLS_CHAIN_LINE

envsubst '${SMTP_HOSTNAME} ${ACCEPTED_RCPT_DOMAIN} ${MAX_MESSAGE_BYTES} ${ANVIL_RATE_TIME_UNIT} ${SMTPD_CLIENT_CONNECTION_COUNT_LIMIT} ${SMTPD_CLIENT_CONNECTION_RATE_LIMIT} ${SMTPD_TIMEOUT} ${SMTPD_TLS_SECURITY_LEVEL} ${SMTP_TLS_CHAIN_LINE}' \
    < /etc/postfix/main.cf.template \
    > /etc/postfix/main.cf

/usr/sbin/postfix check

if [ "$CERT_RELOAD_ENABLED" -eq 1 ]; then
    last_reload_marker="$(cat "$CERT_RELOAD_TRIGGER" 2>/dev/null || true)"
    (
        while true; do
            current_marker="$(cat "$CERT_RELOAD_TRIGGER" 2>/dev/null || true)"
            if [ -n "$current_marker" ] && [ "$current_marker" != "$last_reload_marker" ]; then
                if /usr/sbin/postfix reload; then
                    echo "[postfix] [$(date -Iseconds)] reloaded after certificate update" >&2
                    last_reload_marker="$current_marker"
                else
                    echo "[postfix] [$(date -Iseconds)] failed to reload after certificate update" >&2
                fi
            fi

            sleep "$CERT_RELOAD_POLL_SECONDS"
        done
    ) &
fi

exec /usr/bin/supervisord -c /etc/supervisor/conf.d/mail-stack.conf

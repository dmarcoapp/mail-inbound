#!/bin/sh
set -eu

POSTFIX_PID="$(cat /var/spool/postfix/pid/master.pid)"

test -n "$POSTFIX_PID"

kill -0 "$POSTFIX_PID"
test -d /maildrop/incoming

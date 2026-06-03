FROM alpine:3.20

COPY certbot/export.sh /usr/local/bin/export-cert

RUN chmod 755 /usr/local/bin/export-cert

ENTRYPOINT ["/usr/local/bin/export-cert"]

FROM certbot/dns-cloudflare:v5.6.0

COPY certbot/run.sh /usr/local/bin/run-certbot

RUN chmod 755 /usr/local/bin/run-certbot

ENTRYPOINT ["/usr/local/bin/run-certbot"]

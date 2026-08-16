# mail-engine/docker/opendkim/Dockerfile
FROM alpine:3.20

RUN apk add --no-cache opendkim opendkim-utils \
    && mkdir -p /run/opendkim /etc/opendkim/keys \
    && chown -R opendkim:opendkim /run/opendkim /etc/opendkim

COPY opendkim.conf /etc/opendkim/opendkim.conf
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8891

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]

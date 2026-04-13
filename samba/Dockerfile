FROM alpine:3.21

RUN apk add --no-cache \
    samba \
    samba-common-tools \
    curl \
    jq \
    shadow \
    tini

COPY smb.conf /etc/samba/smb.conf
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 445

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/entrypoint.sh"]

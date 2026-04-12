FROM alpine:3.21

RUN apk add --no-cache \
    samba \
    samba-common-tools \
    linux-pam \
    curl \
    jq \
    shadow \
    tini

COPY smb.conf /etc/samba/smb.conf
COPY pam.d/samba /etc/pam.d/samba
COPY pam_las_auth.sh /usr/local/bin/pam_las_auth.sh
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /usr/local/bin/pam_las_auth.sh /entrypoint.sh

EXPOSE 445

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/entrypoint.sh"]

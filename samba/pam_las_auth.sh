#!/bin/sh
# PAM authentication script for Samba — verifies credentials against LAS API.
# Called by pam_exec.so with expose_authtok (password on stdin).
# Also handles dynamic Unix user/group creation for users added after container start.

set -e

# Read password from stdin (provided by pam_exec.so expose_authtok)
read -r PASS

BACKEND_URL="http://backend:8000/api/auth/smb-verify"

# Call LAS API to verify credentials
RESPONSE=$(curl -sf -w "\n%{http_code}" \
  -H "X-Internal-Key: ${SMB_INTERNAL_KEY}" \
  -d "username=${PAM_USER}&password=${PASS}" \
  "$BACKEND_URL" 2>/dev/null) || exit 1

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -1)

if [ "$HTTP_CODE" != "200" ]; then
  exit 1
fi

# Extract user info from JSON response
UID_NUM=$(echo "$BODY" | jq -r '.uid')
GID_NUM=$(echo "$BODY" | jq -r '.gid')
GROUPS=$(echo "$BODY" | jq -r '.groups')
IS_ADMIN=$(echo "$BODY" | jq -r '.is_admin')

# Create Unix user if not exists (for users added after container start)
if ! id "$PAM_USER" > /dev/null 2>&1; then
  # Find or create primary group
  PRIMARY_GROUP=$(getent group "$GID_NUM" 2>/dev/null | cut -d: -f1 || echo "")
  if [ -z "$PRIMARY_GROUP" ]; then
    addgroup -g "$GID_NUM" "grp_${GID_NUM}" 2>/dev/null || true
    PRIMARY_GROUP="grp_${GID_NUM}"
  fi
  adduser -D -u "$UID_NUM" -G "$PRIMARY_GROUP" -H -s /sbin/nologin "$PAM_USER" 2>/dev/null || true

  # Add to additional groups
  echo "$GROUPS" | tr ',' '\n' | while read -r grp; do
    [ -n "$grp" ] && addgroup "$PAM_USER" "$grp" 2>/dev/null || true
  done

  # Admin users get las_admins group
  if [ "$IS_ADMIN" = "true" ]; then
    addgroup "$PAM_USER" las_admins 2>/dev/null || true
  fi

  # Register in Samba (dummy password, PAM does real auth)
  echo -e "dummy_pass\ndummy_pass" | smbpasswd -a -s "$PAM_USER" 2>/dev/null || true
fi

exit 0

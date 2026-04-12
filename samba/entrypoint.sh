#!/bin/sh
set -e
export SMB_INTERNAL_KEY

echo "Syncing users from LAS backend..."

# Wait for backend (max 60s)
for i in $(seq 1 60); do
  if curl -sf -H "X-Internal-Key: $SMB_INTERNAL_KEY" \
    http://backend:8000/api/auth/smb-users > /dev/null 2>&1; then
    break
  fi
  echo "Waiting for backend... ($i/60)"
  sleep 1
done

USERS_JSON=$(curl -sf -H "X-Internal-Key: $SMB_INTERNAL_KEY" \
  http://backend:8000/api/auth/smb-users 2>/dev/null || echo '{"users":[],"groups":[]}')

# Create las_admins group
addgroup -g 19999 las_admins 2>/dev/null || true

# Sync groups
echo "$USERS_JSON" | jq -r '.groups[] | "\(.gid) \(.name)"' 2>/dev/null | \
while read -r gid name; do
  if [ -n "$gid" ] && ! getent group "$name" > /dev/null 2>&1; then
    addgroup -g "$gid" "$name" 2>/dev/null || true
  fi
done

# Sync users (without passwords — passwords are synced on LAS login)
echo "$USERS_JSON" | jq -r '.users[] | "\(.uid) \(.username) \(.primary_gid) \(.groups) \(.is_admin)"' 2>/dev/null | \
while read -r uid username primary_gid groups is_admin; do
  [ -z "$uid" ] && continue
  if ! id "$username" > /dev/null 2>&1; then
    primary_group=$(getent group "$primary_gid" 2>/dev/null | cut -d: -f1 || echo "nogroup")
    adduser -D -u "$uid" -G "${primary_group:-nogroup}" -H -s /sbin/nologin "$username" 2>/dev/null || true
  fi
  echo "$groups" | tr ',' '\n' | while read -r grp; do
    [ -n "$grp" ] && addgroup "$username" "$grp" 2>/dev/null || true
  done
  if [ "$is_admin" = "true" ]; then
    addgroup "$username" las_admins 2>/dev/null || true
  fi
  # Register user in Samba with a dummy password (real password synced on LAS login)
  if ! pdbedit -L 2>/dev/null | grep -q "^${username}:"; then
    echo -e "dummy_initial_pw\ndummy_initial_pw" | smbpasswd -a -s "$username" 2>/dev/null || true
  fi
done

echo "User sync complete."

# --- Password sync loop ---
# Backend writes {username}\n{password} to /smb-sync/{username}.passwd on login.
# We watch this directory and apply passwords to Samba's tdbsam.
mkdir -p /smb-sync
(
  while true; do
    for f in /smb-sync/*.passwd; do
      [ -f "$f" ] || continue
      username=$(head -1 "$f")
      password=$(tail -1 "$f")
      if [ -n "$username" ] && [ -n "$password" ]; then
        # Create Unix user if needed
        if ! id "$username" > /dev/null 2>&1; then
          adduser -D -H -s /sbin/nologin "$username" 2>/dev/null || true
        fi
        # Create/update Samba password
        echo -e "${password}\n${password}" | smbpasswd -a -s "$username" 2>/dev/null && \
          echo "Password synced for $username"
      fi
      rm -f "$f"
    done
    sleep 1
  done
) &

echo "Starting Samba..."
exec smbd --foreground --no-process-group --debug-stdout

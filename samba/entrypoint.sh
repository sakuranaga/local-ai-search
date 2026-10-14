#!/bin/sh
set -e
export SMB_INTERNAL_KEY

# Users, groups and Samba accounts follow LAS: synced at start and every 60 seconds; accounts
# start unusable and are enabled when LAS hands over the password on login.

# Wait for backend (max 60s)
for i in $(seq 1 60); do
  if curl -sf -H "X-Internal-Key: $SMB_INTERNAL_KEY" \
    http://backend:8000/api/auth/smb-users > /dev/null 2>&1; then
    break
  fi
  echo "Waiting for backend... ($i/60)"
  sleep 1
done

mkdir -p /smb-sync
/sync.sh start-clean
/sync.sh sync && echo "User sync complete." || echo "User sync failed; retried every 60 seconds."

(
  while true; do
    sleep 60
    /sync.sh sync || true
  done
) &

# Backend writes {username}\n{password} to /smb-sync/{username}.passwd on login.
(
  while true; do
    /sync.sh passwords || true
    sleep 1
  done
) &

echo "Starting Samba..."
exec smbd --foreground --no-process-group --debug-stdout

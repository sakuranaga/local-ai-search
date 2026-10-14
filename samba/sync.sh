#!/bin/sh
# Keep the container's users, groups and Samba accounts in line with LAS.
#   sync.sh sync         fetch the user list and apply it (adds and removes)
#   sync.sh passwords    apply the password files LAS writes on login
#   sync.sh start-clean  remove claimed password files left by a stop part-way
# The commands change the same files, so each runs under one lock.
set -u

SMB_SYNC_DIR="${SMB_SYNC_DIR:-/smb-sync}"
LAS_SYNC_STATE="${LAS_SYNC_STATE:-/run/las-sync}"
LAS_USERS_CMD="${LAS_USERS_CMD:-curl -sf -H \"X-Internal-Key: \$SMB_INTERNAL_KEY\" http://backend:8000/api/auth/smb-users}"
USERS="$LAS_SYNC_STATE/users" # "<name> <uid>" per line, from the last list that checked out

log() { echo "las-sync: $*" >&2; }

# The whole list must check out, or nothing is changed. Names: \A and \z, as "^" and "$" are
# line anchors and would take a name with a newline. Names and pairs are compared with grep -F (no patterns).
CHECK='
def int: type == "number" and . == floor;
def uniq(f): [f] | length == (unique | length);
try (
  (.users | type) == "array" and (.groups | type) == "array" and
  ([.groups[].gid] as $g |
    all(.groups[]; type == "object" and (.gid | int) and .gid >= 20000) and uniq(.groups[].gid) and
    all(.users[]; type == "object" and (.uid | int) and .uid >= 10000 and .uid < 65534 and
        (.username | type) == "string" and (.username | test("\\A[a-z_][a-z0-9_.-]*\\z")) and
        (.gids | type) == "array" and all(.gids[]; int and (. as $x | any($g[]; . == $x))))) and
  uniq(.users[].uid) and uniq(.users[].username)
) catch false'

uid_of() { id -u "$1" 2>/dev/null; }
has_account() { pdbedit -L 2>/dev/null | cut -d: -f1 | grep -Fqx -- "$1"; }

disconnect() { # stop the smbd processes serving this user's connections
  for pid in $(smbstatus -p 2>/dev/null | awk -v u="$1" '$1 ~ /^[0-9]+$/ && $2 == u {print $1}'); do
    kill "$pid" 2>/dev/null && log "disconnected $1 (smbd $pid)"
  done
}

make_account() { # a Samba account with no password that cannot be used, made in one import
  f=$(mktemp) || return 1
  printf '%s:%s:NO PASSWORDXXXXXXXXXXXXXXXXXXXXX:NO PASSWORDXXXXXXXXXXXXXXXXXXXXX:[NDU        ]:LCT-00000000:\n' \
    "$1" "$2" > "$f"
  pdbedit -i "smbpasswd:$f" > /dev/null 2>&1
  rc=$?
  rm -f "$f"
  return $rc
}

do_sync() {
  json=$(eval "$LAS_USERS_CMD" 2>/dev/null) || { log "could not fetch the user list; nothing changed"; return 1; }
  # -s: an answer holding two JSON texts is one wrong answer, not two lists
  if ! printf '%s' "$json" | jq -e -s "length == 1 and (.[0] | $CHECK)" > /dev/null 2>&1; then
    log "the user list does not check out; nothing changed"
    return 1
  fi
  mkdir -p "$LAS_SYNC_STATE"
  if ! { printf '%s' "$json" | jq -r '.users[] | "\(.username) \(.uid)"' > "$USERS.new" && mv "$USERS.new" "$USERS"; }
  then
    log "could not write $USERS; nothing changed" # the passwords would go by an old list
    return 1
  fi
  gids=$(printf '%s' "$json" | jq -r '.groups[].gid')

  # Groups: las_g<gid>
  for gid in $gids; do
    getent group "las_g$gid" > /dev/null || addgroup -g "$gid" "las_g$gid" || log "could not add group las_g$gid"
  done
  for g in $(awk -F: '$1 ~ /^las_g[0-9]+$/ {print $1}' /etc/group); do
    printf '%s\n' "$gids" | grep -Fqx -- "${g#las_g}" || delgroup "$g" || log "could not remove group $g"
  done
  getent group las_admins > /dev/null && delgroup las_admins

  # Users whose name and uid pair is not in the list go first
  for name in $( { awk -F: '$3 >= 10000 && $3 < 65534 {print $1}' /etc/passwd; pdbedit -L 2>/dev/null | cut -d: -f1; } \
                 | sort -u); do
    uid=$(uid_of "$name")
    [ -n "$uid" ] && grep -Fqx -- "$name $uid" "$USERS" && continue
    disconnect "$name"
    has_account "$name" && { pdbedit -x "$name" > /dev/null 2>&1 || log "could not remove the account of $name"; }
    [ -n "$uid" ] && { deluser "$name" 2>/dev/null || log "could not remove user $name"; }
    log "removed $name"
  done

  # Then everyone in the list
  printf '%s' "$json" | jq -r '.users[] | "\(.username) \(.uid) \(.gids | map("las_g\(.)") | join(","))"' |
  while read -r name uid groups; do
    if [ -z "$(uid_of "$name")" ]; then
      adduser -D -H -u "$uid" -G nobody -s /sbin/nologin "$name" || { log "could not add user $name"; continue; }
    fi
    [ "$(uid_of "$name")" = "$uid" ] || { log "$name has another uid; skipped"; continue; }
    usermod -G "$groups" "$name" || log "could not set the groups of $name"
    has_account "$name" || make_account "$name" "$uid" || log "could not add the account of $name"
  done
  return 0
}

listed() { # name and uid in the last list, the same uid here, and a Samba account
  uid=$(uid_of "$1")
  [ -n "$uid" ] && [ -f "$USERS" ] && grep -Fqx -- "$1 $uid" "$USERS" && has_account "$1"
}

do_passwords() {
  find "$SMB_SYNC_DIR" -maxdepth 1 -name '.*.tmp' -mmin +5 -exec rm -f {} + 2>/dev/null
  for f in "$SMB_SYNC_DIR"/*.passwd; do
    [ -f "$f" ] || continue
    work="$f.work.$$"
    mv "$f" "$work" 2>/dev/null || continue # claimed: a newer login's file is a new file, for the next pass
    [ -n "${LAS_AFTER_CLAIM:-}" ] && eval "$LAS_AFTER_CLAIM"
    name=$(sed -n 1p "$work")
    password=$(sed -n 2p "$work")
    if [ "$(basename "$f")" != "$name.passwd" ] || [ -z "$password" ]; then
      log "a password file that does not check out; dropped"
    else
      listed "$name" || do_sync # someone logging in for the first time gets a uid with the list
      if listed "$name"; then
        if printf '%s\n%s\n' "$password" "$password" | smbpasswd -s "$name" > /dev/null && \
           smbpasswd -e "$name" > /dev/null; then
          log "password synced for $name"
        else
          log "could not set the password of $name"
        fi
      else
        log "$name is not an active LAS user here; password dropped"
      fi
    fi
    rm -f "$work"
  done
}

mkdir -p "$LAS_SYNC_STATE"
exec 9> "$LAS_SYNC_STATE/lock"
flock 9
case "${1:-}" in
  sync) do_sync ;;
  passwords) do_passwords ;;
  start-clean) rm -f "$SMB_SYNC_DIR"/*.passwd.work.* ;;
  *) echo "usage: sync.sh sync|passwords|start-clean" >&2; exit 2 ;;
esac

#!/bin/sh
# Tests for samba/sync.sh. Run by scripts/test-samba.sh inside a throwaway container of the
# samba image, with the working tree's samba/ mounted at /src.
set -u

SYNC=/src/sync.sh
export LAS_USERS_CMD="cat /tmp/users.json"
export SMB_SYNC_DIR=/tmp/smb-sync
export LAS_SYNC_STATE=/tmp/las-sync
PASS=0
FAIL=0
CURRENT=""

# --- helpers ---------------------------------------------------------------

ok() { PASS=$((PASS + 1)); }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL [$CURRENT]: $*"; }
check() { if eval "$1"; then ok; else bad "$2"; fi; }

list() { # list '<users json array>' '<gid list, space separated>'
  groups=""
  for g in $2; do groups="${groups:+$groups,}{\"gid\":$g}"; done
  printf '{"users":%s,"groups":[%s]}' "$1" "$groups" > /tmp/users.json
}

sync() { sh "$SYNC" sync > /tmp/sync.log 2>&1; }
passwords() { sh "$SYNC" passwords > /tmp/pw.log 2>&1; }

flags() { pdbedit -Lv "$1" 2>/dev/null | sed -n 's/^Account Flags: *//p'; }
has_account() { pdbedit -L 2>/dev/null | cut -d: -f1 | grep -Fqx -- "$1"; }
login() { smbclient "//localhost/LAS" -U "$1%$2" -m SMB3 -c ls > /dev/null 2>&1; }
groups_of() { id -Gn "$1" 2>/dev/null | tr ' ' '\n' | grep '^las_g' | sort | tr '\n' ' '; }
put_password() { mkdir -p "$SMB_SYNC_DIR"; printf '%s\n%s' "$1" "$2" > "$SMB_SYNC_DIR/$1.passwd"; }
snapshot() { { cat /etc/passwd /etc/group; pdbedit -Lw 2>/dev/null; ls -a "$SMB_SYNC_DIR" 2>/dev/null; } | md5sum; }

reset() {
  for u in $(awk -F: '$3 >= 10000 && $3 < 60000 {print $1}' /etc/passwd); do
    pdbedit -x "$u" > /dev/null 2>&1; deluser "$u" 2>/dev/null
  done
  for g in $(awk -F: '/^las_g/ {print $1}' /etc/group); do delgroup "$g" 2>/dev/null; done
  rm -rf "$SMB_SYNC_DIR" "$LAS_SYNC_STATE"
  mkdir -p "$SMB_SYNC_DIR"
}

t() { CURRENT="$1"; reset; }

# --- smbd for logins ---------------------------------------------------------

cp /src/smb.conf /etc/samba/smb.conf
mkdir -p /share-base/fs
smbd -D
sleep 1

# --- tests -------------------------------------------------------------------

t "smb.conf has no admin users"
check '! grep -qi "^[[:space:]]*admin users" /etc/samba/smb.conf' "admin users is still set"

t "groups are las_g<gid>; a group gone from the list is removed"
list '[]' "20000 20001"
sync
check 'getent group las_g20000 | grep -q ":20000:"' "las_g20000 missing"
check 'getent group las_g20001 > /dev/null' "las_g20001 missing"
list '[]' "20000"
sync
check '! getent group las_g20001 > /dev/null' "las_g20001 not removed"
check 'getent group las_g20000 > /dev/null' "las_g20000 removed"

t "users get the LAS uid and exactly the listed groups"
list '[{"uid":10000,"username":"alice","gids":[20000]},{"uid":10001,"username":"bob","gids":[20000,20001]}]' "20000 20001"
sync
check '[ "$(id -u alice)" = 10000 ] && [ "$(id -u bob)" = 10001 ]' "uids differ"
check '[ "$(groups_of alice)" = "las_g20000 " ]' "alice groups: $(groups_of alice)"
check '[ "$(groups_of bob)" = "las_g20000 las_g20001 " ]' "bob groups: $(groups_of bob)"
list '[{"uid":10000,"username":"alice","gids":[]},{"uid":10001,"username":"bob","gids":[20001]}]' "20000 20001"
sync
check '[ "$(groups_of alice)" = "" ]' "alice still in: $(groups_of alice)"
check '[ "$(groups_of bob)" = "las_g20001 " ]' "bob groups: $(groups_of bob)"

t "a new account cannot be used; the old fixed password does not work"
list '[{"uid":10000,"username":"alice","gids":[]}]' ""
sync
check 'has_account alice' "no Samba account"
check 'flags alice | grep -q D' "account not disabled: $(flags alice)"
check '! login alice dummy_initial_pw' "dummy password works"

t "a synced password enables the account and the file goes"
list '[{"uid":10000,"username":"alice","gids":[]}]' ""
sync
put_password alice "pw-a1"
passwords
check '! flags alice | grep -q D' "still disabled: $(flags alice)"
check 'login alice pw-a1' "cannot log in with the synced password"
check '[ -z "$(ls -A "$SMB_SYNC_DIR")" ]' "files left: $(ls -A "$SMB_SYNC_DIR")"

t "sync never enables an account"
list '[{"uid":10000,"username":"alice","gids":[]}]' ""
sync
sync
check 'flags alice | grep -q D' "enabled by sync"

t "a password for someone not in the list creates nothing"
list '[{"uid":10000,"username":"alice","gids":[]}]' ""
sync
put_password zed "pw-z"
passwords
check '! id zed > /dev/null 2>&1' "zed created"
check '! has_account zed' "zed has an account"
check '[ ! -e "$SMB_SYNC_DIR/zed.passwd" ]' "zed's file left"

t "someone who logs in for the first time after the last sync is picked up"
list '[]' ""
sync
list '[{"uid":10000,"username":"alice","gids":[]}]' ""
put_password alice "pw-a2"
passwords
check '[ "$(id -u alice 2>/dev/null)" = 10000 ]' "alice not created with the LAS uid"
check 'login alice pw-a2' "cannot log in"

t "a user gone from the list is removed and disconnected; coming back starts disabled"
list '[{"uid":10000,"username":"alice","gids":[20000]},{"uid":10001,"username":"bob","gids":[]}]' "20000"
sync
put_password alice "pw-a3"
passwords
(sleep 20 | smbclient "//localhost/LAS" -U "alice%pw-a3" -m SMB3 > /dev/null 2>&1) &
held=$!
sleep 2
check 'smbstatus -p 2>/dev/null | grep -qw alice' "alice was not connected"
list '[{"uid":10001,"username":"bob","gids":[]}]' "20000"
sync
sleep 1
check '! has_account alice' "alice's account left"
check '! id alice > /dev/null 2>&1' "alice's Unix user left"
check '! smbstatus -p 2>/dev/null | grep -qw alice' "alice still connected"
check '! login alice pw-a3' "alice can still log in"
check 'has_account bob' "bob removed"
kill "$held" 2>/dev/null
list '[{"uid":10000,"username":"alice","gids":[20000]},{"uid":10001,"username":"bob","gids":[]}]' "20000"
sync
check 'flags alice | grep -q D' "alice came back usable: $(flags alice)"
check '! login alice pw-a3' "the old password works again"

t "an empty user list removes everyone"
list '[{"uid":10000,"username":"alice","gids":[]}]' ""
sync
list '[]' ""
sync
check '! has_account alice && ! id alice > /dev/null 2>&1' "alice left"

t "a renamed user: the old name goes, the new one is made disabled"
list '[{"uid":10000,"username":"alice","gids":[]}]' ""
sync
put_password alice "pw-a4"
passwords
list '[{"uid":10000,"username":"anna","gids":[]}]' ""
sync
check '! id alice > /dev/null 2>&1 && ! has_account alice' "alice left"
check '[ "$(id -u anna 2>/dev/null)" = 10000 ]' "anna not made with uid 10000"
check 'flags anna | grep -q D' "anna usable: $(flags anna)"

t "names are compared as they are, not as patterns"
list '[{"uid":10000,"username":"alice.x","gids":[]}]' ""
sync
put_password alice.x "pw-ax"
passwords
list '[{"uid":10000,"username":"alice-x","gids":[]}]' ""
sync
check '! id alice.x > /dev/null 2>&1 && ! has_account alice.x' "alice.x left"
check '! login alice.x pw-ax' "alice.x can still log in"
check '[ "$(id -u alice-x 2>/dev/null)" = 10000 ]' "alice-x not made with uid 10000"

t "a name used again by someone else: both get their own uid"
list '[{"uid":10000,"username":"alice","gids":[]}]' ""
sync
list '[{"uid":10000,"username":"anna","gids":[]},{"uid":10001,"username":"alice","gids":[]}]' ""
sync
check '[ "$(id -u anna 2>/dev/null)" = 10000 ]' "anna uid: $(id -u anna 2>/dev/null)"
check '[ "$(id -u alice 2>/dev/null)" = 10001 ]' "alice uid: $(id -u alice 2>/dev/null)"
check 'flags alice | grep -q D' "the new alice is usable"

t "an existing user with another uid is made again with the LAS uid"
adduser -D -H -u 10050 -G nobody -s /sbin/nologin alice
printf 'x\nx\n' | smbpasswd -a -s alice > /dev/null
list '[{"uid":10000,"username":"alice","gids":[]}]' ""
sync
check '[ "$(id -u alice)" = 10000 ]' "alice uid: $(id -u alice)"
check 'flags alice | grep -q D' "alice usable: $(flags alice)"
check '! login alice x' "the old password works"

t "a list that cannot be fetched or does not check out changes nothing"
list '[{"uid":10000,"username":"alice","gids":[20000]}]' "20000"
sync
put_password alice "pw-a5"
passwords
before=$(snapshot)
for body in \
  'not json' \
  '{"users":[]}' \
  '{"groups":[]}' \
  '{"users":{},"groups":[]}' \
  '{"users":[{"uid":10001,"username":"bob"}],"groups":[]}' \
  '{"users":[{"uid":10001,"gids":[]}],"groups":[]}' \
  '{"users":[{"username":"bob","gids":[]}],"groups":[]}' \
  '{"users":[{"uid":"10001","username":"bob","gids":[]}],"groups":[]}' \
  '{"users":[{"uid":9999,"username":"bob","gids":[]}],"groups":[]}' \
  '{"users":[{"uid":10001,"username":"Bob","gids":[]}],"groups":[]}' \
  '{"users":[{"uid":10001,"username":"bob x","gids":[]}],"groups":[]}' \
  '{"users":[{"uid":10001,"username":"bob\n","gids":[]}],"groups":[]}' \
  '{"users":[{"uid":10001,"username":"bob\nx!","gids":[]}],"groups":[]}' \
  '{"users":[{"uid":10001,"username":"bob","gids":[20009]}],"groups":[{"gid":20000}]}' \
  '{"users":[{"uid":10001,"username":"bob","gids":["20000"]}],"groups":[{"gid":20000}]}' \
  '{"users":[],"groups":[{"gid":19999}]}' \
  '{"users":[],"groups":[{"gid":20000},{"gid":20000}]}' \
  '{"users":[{"uid":10001,"username":"bob","gids":[]},{"uid":10001,"username":"carl","gids":[]}],"groups":[]}' \
  '{"users":[{"uid":10001,"username":"bob","gids":[]},{"uid":10002,"username":"bob","gids":[]}],"groups":[]}'
do
  printf '%s' "$body" > /tmp/users.json
  sync
  check '[ "$(snapshot)" = "$before" ]' "changed by: $body"
done
LAS_USERS_CMD="false" sync
check '[ "$(snapshot)" = "$before" ]' "changed when the fetch failed"
printf '%s%s' '{"users":[],"groups":[]}' '{"users":[],"groups":[]}' > /tmp/users.json
sync
check '[ "$(snapshot)" = "$before" ]' "changed by two lists in one answer"
list '[]' ""
mkdir "$LAS_SYNC_STATE/users.new" # the state file cannot be written
sync
check '[ "$(snapshot)" = "$before" ]' "changed although the state file could not be written"
rmdir "$LAS_SYNC_STATE/users.new"
check 'login alice pw-a5' "alice lost access"

t "leftover claimed files go at start; old temporary files go"
list '[]' ""
sync
printf 'alice\nx' > "$SMB_SYNC_DIR/alice.passwd.work.123"
printf 'alice\nx' > "$SMB_SYNC_DIR/.alice.old.tmp"
touch -d "@$(($(date +%s) - 600))" "$SMB_SYNC_DIR/.alice.old.tmp"
printf 'alice\nx' > "$SMB_SYNC_DIR/.alice.new.tmp"
sh "$SYNC" start-clean > /dev/null 2>&1
check '[ ! -e "$SMB_SYNC_DIR/alice.passwd.work.123" ]' ".work left at start"
passwords
check '[ ! -e "$SMB_SYNC_DIR/.alice.old.tmp" ]' "old .tmp left"
check '[ -e "$SMB_SYNC_DIR/.alice.new.tmp" ]' "a fresh .tmp (still being written) removed"

t "a new password file put while one is being applied is kept for the next pass"
list '[{"uid":10000,"username":"alice","gids":[]}]' ""
sync
put_password alice "pw-old"
LAS_AFTER_CLAIM='printf "alice\npw-new" > "$SMB_SYNC_DIR/alice.passwd"' passwords
check '[ -e "$SMB_SYNC_DIR/alice.passwd" ]' "the new file was removed"
passwords
check 'login alice pw-new' "the newest password is not in use"

# -----------------------------------------------------------------------------

echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]

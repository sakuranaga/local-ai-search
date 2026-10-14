#!/usr/bin/env bash
# samba sync tests: build the samba image and run samba/tests/test_sync.sh in a throwaway
# container (smbd runs inside it; nothing touches the running samba or its volume).
set -euo pipefail
cd "$(dirname "$0")/.."
docker build -q -t las-samba-test samba > /dev/null # a name of its own: compose names images by the folder
exec docker run --rm -v "$PWD/samba:/src:ro" --entrypoint sh las-samba-test /src/tests/test_sync.sh "$@"

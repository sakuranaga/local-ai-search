#!/bin/bash
# Build frontend inside Docker container (no npm install on host)
set -e
cd "$(dirname "$0")"
docker build -t las-frontend-build .
docker run --rm -v "$(pwd)/dist:/out" las-frontend-build sh -c "cp -r /app/dist/* /out/"
echo "Frontend built successfully -> dist/"

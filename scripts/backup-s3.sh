#!/bin/bash
# S3 backup script for DB dump + uploaded files (Wasabi)
# Usage: ./backup-s3.sh
# Cron example (daily 3AM): 0 3 * * * PLACEHOLDER_HOME/local-ai-search/scripts/backup-s3.sh

set -euo pipefail

ENDPOINT="https://s3.ap-northeast-1-ntt.wasabisys.com"
BUCKET="s3://REDACTED_BUCKET"
PROFILE="las"
PROJECT_DIR="PLACEHOLDER_HOME/local-ai-search"
DATA_DIR="$PROJECT_DIR/data/uploads"
DUMP_DIR="$PROJECT_DIR/data/dbdump"
LOG_FILE="$PROJECT_DIR/logs/backup.log"

mkdir -p "$(dirname "$LOG_FILE")" "$DUMP_DIR"

echo "$(date '+%Y-%m-%d %H:%M:%S') Backup started" >> "$LOG_FILE"

# 1. DB dump
echo "$(date '+%Y-%m-%d %H:%M:%S') DB dump started" >> "$LOG_FILE"
docker compose -f "$PROJECT_DIR/docker-compose.yml" exec -T db \
  pg_dump -U las -d las --clean --if-exists \
  | gzip > "$DUMP_DIR/las.sql.gz"
echo "$(date '+%Y-%m-%d %H:%M:%S') DB dump completed ($(du -h "$DUMP_DIR/las.sql.gz" | cut -f1))" >> "$LOG_FILE"

# Upload DB dump to S3
aws s3 cp "$DUMP_DIR/las.sql.gz" "$BUCKET/dbdump/las.sql.gz" \
  --endpoint-url "$ENDPOINT" \
  --profile "$PROFILE" \
  >> "$LOG_FILE" 2>&1

# 2. Sync uploaded files
echo "$(date '+%Y-%m-%d %H:%M:%S') File sync started" >> "$LOG_FILE"
aws s3 sync "$DATA_DIR" "$BUCKET/uploads/" \
  --endpoint-url "$ENDPOINT" \
  --profile "$PROFILE" \
  --exclude "tus/*.info" \
  --delete \
  >> "$LOG_FILE" 2>&1

echo "$(date '+%Y-%m-%d %H:%M:%S') Backup completed" >> "$LOG_FILE"

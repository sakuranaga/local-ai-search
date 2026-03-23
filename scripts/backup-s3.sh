#!/bin/bash
# S3 backup script for uploaded files
# Usage: ./backup-s3.sh
# Cron example (daily 3AM): 0 3 * * * PLACEHOLDER_HOME/local-ai-search/scripts/backup-s3.sh

set -euo pipefail

BUCKET="s3://las-backup-ddr8"
DATA_DIR="PLACEHOLDER_HOME/local-ai-search/data/uploads"
LOG_FILE="PLACEHOLDER_HOME/local-ai-search/logs/backup.log"

mkdir -p "$(dirname "$LOG_FILE")"

echo "$(date '+%Y-%m-%d %H:%M:%S') Backup started" >> "$LOG_FILE"

aws s3 sync "$DATA_DIR" "$BUCKET/uploads/" \
  --exclude "tus/*" \
  --delete \
  >> "$LOG_FILE" 2>&1

echo "$(date '+%Y-%m-%d %H:%M:%S') Backup completed" >> "$LOG_FILE"

#!/usr/bin/env bash
set -euo pipefail

# Release script for LAS (Local AI Search)
# Usage: ./scripts/release.sh <major|minor|patch> [--dry-run]

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

VERSION_FILES=(
  "frontend/package.json"
  "frontend/src/App.tsx"
  "backend/app/main.py"
)

DRY_RUN=false

usage() {
  echo "Usage: $0 <major|minor|patch> [--dry-run]"
  echo ""
  echo "  major   Bump major version (x.0.0) — breaking changes"
  echo "  minor   Bump minor version (0.x.0) — new features"
  echo "  patch   Bump patch version (0.0.x) — bug fixes"
  echo "  --dry-run  Show what would change without modifying files"
  exit 1
}

# Parse arguments
[[ $# -lt 1 ]] && usage
BUMP_TYPE="$1"
[[ "$BUMP_TYPE" != "major" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "patch" ]] && usage
[[ "${2:-}" == "--dry-run" ]] && DRY_RUN=true

# Get current version from package.json (source of truth)
CURRENT_VERSION=$(grep -oP '"version":\s*"\K[0-9]+\.[0-9]+\.[0-9]+' "$PROJECT_DIR/frontend/package.json")

if [[ -z "$CURRENT_VERSION" ]]; then
  echo "Error: Could not read current version from frontend/package.json"
  exit 1
fi

IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT_VERSION"

# Calculate new version
case "$BUMP_TYPE" in
  major) NEW_VERSION="$((MAJOR + 1)).0.0" ;;
  minor) NEW_VERSION="$MAJOR.$((MINOR + 1)).0" ;;
  patch) NEW_VERSION="$MAJOR.$MINOR.$((PATCH + 1))" ;;
esac

echo "Current version: $CURRENT_VERSION"
echo "New version:     $NEW_VERSION"
echo ""

if $DRY_RUN; then
  echo "[dry-run] Would update the following files:"
  for f in "${VERSION_FILES[@]}"; do
    echo "  - $f"
  done
  echo "[dry-run] Would create git tag: v$NEW_VERSION"
  exit 0
fi

# Check for uncommitted changes
if ! git -C "$PROJECT_DIR" diff --quiet HEAD 2>/dev/null; then
  echo "Error: There are uncommitted changes. Commit or stash them first."
  exit 1
fi

# Update frontend/package.json
sed -i "s/\"version\": \"$CURRENT_VERSION\"/\"version\": \"$NEW_VERSION\"/" \
  "$PROJECT_DIR/frontend/package.json"

# Update frontend/src/App.tsx
sed -i "s/LAS Version $CURRENT_VERSION/LAS Version $NEW_VERSION/" \
  "$PROJECT_DIR/frontend/App.tsx" 2>/dev/null || \
sed -i "s/LAS Version $CURRENT_VERSION/LAS Version $NEW_VERSION/" \
  "$PROJECT_DIR/frontend/src/App.tsx"

# Update backend/app/main.py
sed -i "s/version=\"$CURRENT_VERSION\"/version=\"$NEW_VERSION\"/" \
  "$PROJECT_DIR/backend/app/main.py"

echo "Updated files:"
for f in "${VERSION_FILES[@]}"; do
  echo "  - $f"
done

# Commit and tag
git -C "$PROJECT_DIR" add \
  frontend/package.json \
  frontend/src/App.tsx \
  backend/app/main.py

git -C "$PROJECT_DIR" commit -m "$(cat <<EOF
release: v$NEW_VERSION

Bump version from $CURRENT_VERSION to $NEW_VERSION
EOF
)"

git -C "$PROJECT_DIR" tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"

echo ""
echo "Done! Created commit and tag v$NEW_VERSION"
echo "To push: git push && git push --tags"

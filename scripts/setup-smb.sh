#!/bin/bash
# Setup host prerequisites for SMB file sharing (FUSE mount propagation).
# Run once after cloning the repo, or after a host reboot.
# Requires sudo.

set -e

FUSE_MOUNT_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/fuse-mount"

echo "Setting up SMB/FUSE mount propagation..."

mkdir -p "$FUSE_MOUNT_DIR"

# Create a bind mount and make it shared so FUSE mounts inside
# the las-fuse container propagate to the host and samba container.
if findmnt -n "$FUSE_MOUNT_DIR" > /dev/null 2>&1; then
    echo "  $FUSE_MOUNT_DIR is already mounted."
else
    echo "  Creating bind mount..."
    sudo mount --bind "$FUSE_MOUNT_DIR" "$FUSE_MOUNT_DIR"
fi

# Check if already shared
PROP=$(findmnt -n -o PROPAGATION "$FUSE_MOUNT_DIR" 2>/dev/null || echo "")
if [ "$PROP" = "shared" ]; then
    echo "  Mount propagation is already shared."
else
    echo "  Setting mount propagation to shared..."
    sudo mount --make-shared "$FUSE_MOUNT_DIR"
fi

mkdir -p "$FUSE_MOUNT_DIR/fs"
mkdir -p "$(cd "$(dirname "$0")/.." && pwd)/data/smb-staging"
mkdir -p "$(cd "$(dirname "$0")/.." && pwd)/data/smb-sync"

echo ""
echo "Done. You can now start SMB services:"
echo "  docker compose up -d --build las-fuse samba"
echo ""
echo "NOTE: This setup is lost on host reboot."
echo "To make it persistent, add to /etc/fstab:"
echo "  $FUSE_MOUNT_DIR $FUSE_MOUNT_DIR none bind,shared 0 0"

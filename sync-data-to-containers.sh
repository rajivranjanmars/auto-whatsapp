#!/bin/bash

# Sync Data to Containers Script
# Copies new files from host ./data to all container volumes
# Does NOT delete any files from containers (preserves WhatsApp sessions)

set -e

echo "🔄 Starting data sync to containers..."
echo ""

# Configuration
HOST_DATA_DIR="./data"
CONTAINER_DATA_DIR="/app/data"
CONTAINERS=("whatsapp-api-1" "whatsapp-api-2" "whatsapp-api-3" "whatsapp-api-4" "whatsapp-api-5" "whatsapp-api-6" "whatsapp-api-7" "whatsapp-api-8" "whatsapp-api-9" "whatsapp-api-10")

# Check if data directory exists
if [ ! -d "$HOST_DATA_DIR" ]; then
    echo "❌ Error: $HOST_DATA_DIR directory not found!"
    exit 1
fi

# Get list of files in host data directory (excluding chrome_profile)
echo "📂 Scanning host data directory..."
HOST_FILES=$(find "$HOST_DATA_DIR" -maxdepth 1 -type f -exec basename {} \;)

if [ -z "$HOST_FILES" ]; then
    echo "⚠️  No files found in $HOST_DATA_DIR"
    exit 0
fi

echo "Found files in host directory:"
echo "$HOST_FILES" | while read -r file; do
    echo "  - $file"
done
echo ""

# Function to sync files to a container
sync_to_container() {
    local container=$1
    local new_files=0
    local skipped_files=0
    
    echo "📦 Syncing to $container..."
    
    # Check if container is running
    if ! docker ps --format '{{.Names}}' | grep -q "^${container}$"; then
        echo "   ⚠️  Container not running, skipping..."
        return
    fi
    
    # Get list of files already in container
    CONTAINER_FILES=$(docker exec "$container" find "$CONTAINER_DATA_DIR" -maxdepth 1 -type f -exec basename {} \; 2>/dev/null || echo "")
    
    # Copy each file if it doesn't exist in container
    echo "$HOST_FILES" | while read -r file; do
        if [ -z "$file" ]; then
            continue
        fi
        
        # Check if file exists in container
        if echo "$CONTAINER_FILES" | grep -q "^${file}$"; then
            echo "   ⏭️  Skipped: $file (already exists)"
            skipped_files=$((skipped_files + 1))
        else
            # Copy file to container
            if docker cp "$HOST_DATA_DIR/$file" "$container:$CONTAINER_DATA_DIR/" 2>/dev/null; then
                echo "   ✅ Copied: $file"
                new_files=$((new_files + 1))
            else
                echo "   ❌ Failed to copy: $file"
            fi
        fi
    done
    
    echo ""
}

# Sync to all containers
for container in "${CONTAINERS[@]}"; do
    sync_to_container "$container"
done

echo "✅ Data sync complete!"
echo ""
echo "📊 Summary:"
echo "   - Containers processed: ${#CONTAINERS[@]}"
echo "   - Files in host directory: $(echo "$HOST_FILES" | wc -l)"
echo ""
echo "🔍 Verify with: docker exec whatsapp-api-2 ls -la /app/data"

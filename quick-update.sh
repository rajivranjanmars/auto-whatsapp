#!/bin/bash
# Quick Update Script - Uses cache for faster rebuilds
# Run this on mars@oracle:~/auto-whatsapp

echo "⚡ Quick update with cache..."

# Pull latest code
echo "📥 Pulling from GitHub..."
git pull

# Rebuild with cache
echo "🔨 Rebuilding (with cache)..."
docker-compose -f docker-compose-multi.yml build

# Stop and remove containers (keep volumes)
echo "� Stopping containers..."
docker-compose -f docker-compose-multi.yml stop
docker-compose -f docker-compose-multi.yml rm -f

# Start with new images
echo "🚀 Starting containers..."
docker-compose -f docker-compose-multi.yml up -d

echo ""
echo "✅ Quick update complete!"
docker-compose -f docker-compose-multi.yml ps

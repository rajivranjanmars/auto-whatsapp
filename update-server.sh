#!/bin/bash
# Full Update Script for Oracle Server (with no-cache rebuild)
# Run this on mars@oracle:~/auto-whatsapp
# NOTE: Preserves WhatsApp sessions - no need to scan QR codes again!

echo "🔄 Updating WhatsApp API with latest code..."

# Pull latest code
echo "📥 Pulling latest changes from GitHub..."
git pull

# Rebuild all instances (with no cache to ensure fresh build)
echo "🔨 Rebuilding Docker images (no cache)..."
docker-compose -f docker-compose-multi.yml build --no-cache

# Stop containers but keep volumes (preserves WhatsApp sessions)
echo "🛑 Stopping containers (keeping volumes)..."
docker-compose -f docker-compose-multi.yml stop

# Remove old containers (but NOT volumes)
echo "�️ Removing old containers..."
docker-compose -f docker-compose-multi.yml rm -f

# Start all instances with new images (volumes persist)
echo "🚀 Starting all instances with new images..."
docker-compose -f docker-compose-multi.yml up -d

echo ""
echo "✅ Update complete!"
echo ""
echo "📊 Container Status:"
docker-compose -f docker-compose-multi.yml ps

echo ""
echo "🎯 Latest Features:"
echo "  - ✅ /screenshot-page - HTML viewer with auto-refresh"
echo "  - ✅ /message - Send text messages (no auth check)"
echo "  - ✅ /send-media - Upload & send media in one request"
echo "  - ✅ /message-media - Send media with file path"
echo "  - ✅ Phone login flow with verification codes"
echo ""
echo "� WhatsApp sessions preserved - no need to re-authenticate!"
echo ""
echo "�📱 Test with:"
echo '  curl -X POST http://localhost:4600/message -H "Content-Type: application/json" -d '"'"'{"phone_number":"918540029641","message":"Test!"}'"'"''

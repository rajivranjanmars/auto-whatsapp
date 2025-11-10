#!/bin/bash
# Quick Update Script for Oracle Server
# Run this on mars@oracle:~/auto-whatsapp

echo "🔄 Updating WhatsApp API with latest code..."

# Pull latest code
echo "📥 Pulling latest changes from GitHub..."
git pull

# Rebuild all instances
echo "🔨 Rebuilding Docker images..."
docker-compose -f docker-compose-multi.yml build

# Restart all instances
echo "🔄 Restarting all instances..."
docker-compose -f docker-compose-multi.yml restart

echo ""
echo "✅ Update complete!"
echo ""
echo "📊 Container Status:"
docker-compose -f docker-compose-multi.yml ps

echo ""
echo "🎯 Changes applied:"
echo "  - Removed authentication checks from /message endpoint"
echo "  - Removed authentication checks from /send-media endpoint"
echo "  - Messages will now send even if auth detection fails"
echo ""
echo "📱 Test with:"
echo '  curl -X POST http://localhost:4600/message -H "Content-Type: application/json" -d '"'"'{"phone_number":"918540029641","message":"Test!"}'"'"''

#!/bin/bash
# Options Tracker — Auto-start setup for Mac
# Run this once: bash setup-autostart.sh

echo "Setting up auto-start services..."

# 1. Find node path
NODE_PATH=$(which node)
echo "Node found at: $NODE_PATH"

# 2. Find ngrok path
NGROK_PATH=$(which ngrok)
echo "Ngrok found at: $NGROK_PATH"

# 3. Get home directory
HOME_DIR=$HOME
echo "Home directory: $HOME_DIR"

# 4. Copy and configure bridge plist
BRIDGE_PLIST="$HOME_DIR/Library/LaunchAgents/com.options-tracker.ib-bridge.plist"
cp com.options-tracker.ib-bridge.plist "$BRIDGE_PLIST"
# Update paths
sed -i '' "s|/usr/local/bin/node|$NODE_PATH|g" "$BRIDGE_PLIST"
sed -i '' "s|/Users/lewis|$HOME_DIR|g" "$BRIDGE_PLIST"
echo "✅ Bridge plist installed at $BRIDGE_PLIST"

# 5. Copy and configure ngrok plist
NGROK_PLIST="$HOME_DIR/Library/LaunchAgents/com.options-tracker.ngrok.plist"
cp com.options-tracker.ngrok.plist "$NGROK_PLIST"
# Update ngrok path
sed -i '' "s|/opt/homebrew/bin/ngrok|$NGROK_PATH|g" "$NGROK_PLIST"
echo "✅ Ngrok plist installed at $NGROK_PLIST"

# 6. Load the services
launchctl load "$BRIDGE_PLIST"
launchctl load "$NGROK_PLIST"
echo "✅ Services loaded"

# 7. Verify
sleep 2
echo ""
echo "=== Status ==="
launchctl list | grep options-tracker
echo ""
echo "Bridge log: tail -f /tmp/ib-bridge.log"
echo "Ngrok log:  tail -f /tmp/ngrok.log"
echo ""
echo "To get the ngrok URL:"
echo "  curl -s http://localhost:4040/api/tunnels | python3 -c \"import sys,json; print(json.load(sys.stdin)['tunnels'][0]['public_url'])\""
echo ""
echo "To stop services:"
echo "  launchctl unload ~/Library/LaunchAgents/com.options-tracker.ib-bridge.plist"
echo "  launchctl unload ~/Library/LaunchAgents/com.options-tracker.ngrok.plist"
echo ""
echo "Done! Both services will auto-start on login."

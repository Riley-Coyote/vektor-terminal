#!/bin/bash
# Launch Vektor Terminal as a native Electron app
# Usage: ./launch.sh

cd "$(dirname "$0")"

echo "⏀ Launching Vektor Terminal..."
npx electron . 2>&1 &
echo "⏀ Running (PID: $!)"

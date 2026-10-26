#!/bin/bash
set -e
echo "=== Installing Python dependencies ==="
pip install -r requirements.txt 2>&1 | tail -5
echo "=== Installing Node.js dependencies ==="
npm install
echo "=== Build complete ==="

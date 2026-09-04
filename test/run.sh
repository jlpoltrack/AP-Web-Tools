#!/bin/sh
# Needs node and the firmware fixtures (test/fixtures.sh).
set -e
cd "$(dirname "$0")"
node bootloader.test.mjs
echo
node ui.test.mjs

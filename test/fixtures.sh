#!/bin/sh
# Re-fetch the firmware the tests run against.
set -e
cd "$(dirname "$0")/fixtures"
curl -fsSL -o CubeOrange.apj      https://firmware.ardupilot.org/Copter/stable/CubeOrange/arducopter.apj
curl -fsSL -o CubeRedPrimary.apj  https://firmware.ardupilot.org/Copter/stable/CubeRedPrimary/arducopter.apj

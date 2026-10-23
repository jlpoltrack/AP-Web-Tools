# AP Web Tools

Browser tools for ArduPilot hardware, using Web Serial (Chromium desktop browsers).

| Tool | Hosted | What it does |
|---|---|---|
| [ap-updater](ap-updater/) | https://jlpoltrack.github.io/AP-Web-Tools/ap-updater/ | Flash an ArduPilot `.apj` over the bootloader |
| [dronecan-updater](dronecan-updater/) | https://jlpoltrack.github.io/AP-Web-Tools/dronecan-updater/ | Flash a DroneCAN node `.bin` via an SLCAN adapter |

Pushes to `main` redeploy both. To run one locally: `cd <tool> && ./serve.sh` (http://localhost:8000).

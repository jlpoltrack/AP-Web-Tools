# AP Web Tools

Browser tools for ArduPilot hardware, using Web Serial (Chromium desktop browsers).

Hosted: **https://jlpoltrack.github.io/AP-Web-Tools/** — one page, one tab per tool. Pushes to `main` redeploy it.

| Tab | Folder | What it does |
|---|---|---|
| AP Updater (`#ap`) | [ap-updater](ap-updater/) | Flash an ArduPilot `.apj` over the bootloader |
| DroneCAN Updater (`#dronecan`) | [dronecan-updater](dronecan-updater/) | Flash a DroneCAN node `.bin` via an SLCAN adapter |

Run locally: `python3 -m http.server 8000 --bind 127.0.0.1` at the repo root, or `./serve.sh` inside a tool folder.

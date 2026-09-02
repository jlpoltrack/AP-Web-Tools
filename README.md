# DroneCAN Updater (web)

A minimal browser version of Mission Planner's DroneCAN firmware updater: pick a serial
SLCAN adapter, pick a node, pick a `.bin`, flash.

## Run

Hosted: **https://jlpoltrack.github.io/DroneCAN-Updater/** — pushes to `main` redeploy it.

Locally:

```sh
./serve.sh          # http://localhost:8000
```

Needs the Web Serial API and a secure context (GitHub Pages is HTTPS; `localhost` also
counts). That means Chromium desktop browsers — Chrome, Edge, Opera, Brave, Arc — or
Firefox 151+ on desktop, where Web Serial is gated behind an add-on that explains the
permission before the port picker appears (and is off by default under Enterprise
Policies). Safari and mobile browsers do not support it.

No WebUSB is involved: Web Serial talks to the port the OS CDC-ACM driver already
provides, so nothing has to claim the USB interface.

## Use

1. **Connect** — choose the flight controller's USB port. The picker is filtered to
   ArduPilot USB IDs (`0x1209:0x5740/0x5741` plus the Cube, Holybro, ThePeach, 3DR and
   VRBrain vendor IDs from hwdef). If your board isn't listed, press Connect again and
   every serial port is shown. Nothing needs to be configured
   on the FC: if the port is streaming MAVLink, the app sets `CAN_SLCAN_CPORT=1`,
   `CAN_P1_DRIVER=1`, `CAN_SLCAN_TIMOUT=2` and then blind-sets `CAN_SLCAN_SERNUM=0`, which
   hands the port over to SLCAN — the same sequence Mission Planner uses. If
   `CAN_SLCAN_CPORT` was 0 the change only applies after a reboot, so a **Reboot FC**
   button appears. SLCAN also auto-disables while armed.
2. **Nodes** — nodes appear as their `NodeStatus` broadcasts arrive; names/versions come
   from `GetNodeInfo`. Click a row to select it.
3. **Firmware** — choose the `.bin` and press *Update selected node*.

The node reboots into its bootloader, requests the image from us over
`uavcan.protocol.file.Read`, and reboots when done. The progress bar tracks bytes served.

## How it works

- `js/slcan.js` — Web Serial port + SLCAN framing (`T<id><dlc><data>\r`).
- `js/dronecan.js` — DroneCAN/UAVCAN v0 CAN ID packing, tail bytes, multi-frame
  assembly, transfer CRC (CRC-16-CCITT seeded with the data type signature).
- `js/mavlink.js` — enough MAVLink v1/v2 to read a heartbeat and set parameters, so the
  FC can be flipped into SLCAN mode without touching Mission Planner first.
- `js/app.js` — node discovery, `BeginFirmwareUpdate`, and the `file.Read` server that
  feeds the bootloader 256-byte chunks.

DroneCAN frames were verified byte-for-byte against `pydronecan`, MAVLink frames against `pymavlink`.

## Limitations

- No dynamic node ID allocation server: the target must already have a node ID.
- One node at a time; no parameter editing, no node restart button.

# AP Updater (web)

A browser version of Mission Planner's firmware uploader: pick an ArduPilot `.apj`,
reboot the flight controller into its bootloader, flash it.

Local firmware files only for now. Downloading builds from `firmware.ardupilot.org`
needs a proxy — see [Firmware downloads](#firmware-downloads).

## Run

Hosted: **https://jlpoltrack.github.io/AP-Updater/** — pushes to `main` redeploy it.

Locally:

```sh
./serve.sh          # http://localhost:8000
```

Needs the Web Serial API and a secure context (`localhost` counts, as does HTTPS). That
means Chromium desktop browsers — Chrome, Edge, Opera, Brave, Arc — or Firefox 151+ on
desktop, where Web Serial sits behind an add-on. Safari and mobile browsers do not
support it.

## Use

1. **Firmware** — choose the `.apj`. Its board ID, size and git hash are shown.
2. **Reboot board to bootloader** — pick the flight controller's port. The app waits
   briefly for a heartbeat to learn the target IDs, then sends
   `MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN` with `param1 = 3`, plus an NSH `reboot -b` for
   boards running a shell. Skip this if the board is already in bootloader mode.
3. **Connect to bootloader** — the board comes back as a *different* USB device, so
   pick its port once. After that the grant is remembered and this step is silent.
4. **Flash firmware** — erase, program, CRC verify, reboot.

`param1 = 3` sets `RTC_BOOT_HOLD`, so the bootloader waits indefinitely rather than
timing out while you grant access to the new port.

### The extra click

Web Serial grants permission per USB device. A board's running firmware and its
bootloader are different devices (`0x1209:0x5740` → `0x5741`, or Cube's
`0x2dae:0x1016` → `0x1011`), so the bootloader needs its own grant the first time you
flash a given board. Chrome remembers both afterwards, and **Connect to bootloader**
probes already-permitted ports before showing the picker. Mission Planner has no
equivalent step because it can open any port it likes.

## How it works

- `js/serial.js` — Web Serial port as a byte stream with blocking, timed reads, which
  is what a strict request/response protocol needs.
- `js/apj.js` — `.apj` parsing (JSON, base64, zlib via `DecompressionStream`) and
  ArduPilot's CRC-32.
- `js/bootloader.js` — the PX4/ArduPilot bootloader protocol: `GET_SYNC`, `GET_DEVICE`,
  `CHIP_ERASE`, `PROG_MULTI` in 252-byte chunks, `GET_CRC`, `REBOOT`, and the `EXTF_*`
  commands for boards with external flash.
- `js/mavlink.js` — enough MAVLink v1 to spot a heartbeat and command the reboot.
- `js/boards.js` — board ID → name, generated from ArduPilot's
  `Tools/AP_Bootloader/board_types.txt`.

Image and external-flash CRCs were checked against `uploader.py` for a plain board
(CubeOrange) and one with external flash (CubeRedPrimary); the reboot frames match
`uploader.py`'s hardcoded ones byte for byte.

## Tests

```sh
./test/fixtures.sh   # downloads two .apj files (not in git)
./test/run.sh
```

`test/mock-bootloader.mjs` implements the bootloader side in memory, so the erase /
program / verify path runs without hardware.

## Firmware downloads

`firmware.ardupilot.org` sends no `Access-Control-Allow-Origin`, on the manifest or on
the `.apj` files, so a static page cannot fetch builds directly. Adding a firmware
picker means putting a small proxy (a Cloudflare Worker will do) in front of
`manifest.json.gz` and the build paths, and filtering it by the board ID reported by
the bootloader.

## Limitations

- No firmware catalog; local `.apj` files only.
- No bootloader flashing and no DFU recovery for a board with no working bootloader.
- Bootloader protocol revisions below 3 cannot be verified, so they are refused.

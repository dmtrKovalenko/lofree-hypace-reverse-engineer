# Lofree HYPACE — Reverse-Engineered HID Protocol

Source: reverse-engineered from `https://www.lofree.tech/home/` (Vite SPA "Control HUB WEB"), bundle `assets/index-BTVblIUr.js`, plus the JSON files served alongside it (`cfg.json`, `ref.json`, `sensor.json`).

The web app uses **WebHID** to talk to the mouse. Everything below was extracted from the bundle's minified source — names like `Fe.*`, `de.*`, `Ts.*`, `Jn`, etc. are the original symbol names.

---

## 1. Transport

- API: WebHID (`navigator.hid.requestDevice` + `device.sendReport` / `device.sendFeatureReport`).
- HID **Report ID = 8** (constant `cr` in JS).
- Each report is **16 bytes** of payload following the report ID.
- The mouse uses **OutputReport** mode by default. Some devices use **FeatureReport** — the firmware-config blob has a `feature: bool` flag per command.

### Request-device filter (from `cfg.json` → `opt.mouse`)

| VendorID | ProductID candidates |
|----------|---|
| 0x373B | 0x101B, 0xF5F4, 0xF590, 0xF5D5, 0xF53E, 0xF501, 0xF5F6, 0xFB16 |
| 0x3554 | (same set) |

Pick all 16 (vid, pid) combinations as the WebHID filter list, or filter on connection by reading the descriptor.

> The keyboard counterpart uses VID `0x05AC`, `0x3554`, `0x388D` with a different PID set — see `cfg.json` → `opt.keyboard`.

---

## 2. Packet format

All command packets are 16 bytes.

```
offset  size  field
------  ----  -----
0       1     opcode            (Fe.* enum, see §3)
1       1     0
2       2     address (BE)      (only used by ReadFlashData / WriteFlashData)
4       1     length | classBit  (low 7 bits = payload length, bit 7 = 1 for keyboard)
5       10    payload           (zero-padded)
15      1     checksum
```

### Checksum

The JS computes the checksum like this:

```js
function nt(buf) {
    let s = 0;
    for (let i = 0; i < buf.length - 1; i++) s += buf[i];
    s &= 0xFF;
    return 85 - s;        // not masked — may be negative
}
buf[15] = nt(buf) - 8;     // subtract report ID (cr=8)
```

The HID stack prepends the report ID (8) to the buffer before sending it on the wire, so on the firmware side the validating constant is:

```
sum(reportId + buf[0..15])  mod 256  ===  85  (decimal) === 0x55
```

Equivalently: `sum(buf[0..15]) === 77 (mod 256)`.

> Note: byte 15 starts initialised to `239` in the JS (visible in `Uint8Array.of(...)` literals), but it's always overwritten by the checksum — `239` carries no meaning, it's just dead init.

---

## 3. Opcodes (the `Fe` enum)

```
EncryptionData     = 1
PCDriverStatus     = 2
DeviceOnLine       = 3
BatteryLevel       = 4
DongleEnterPair    = 5
GetPairState       = 6
WriteFlashData     = 7
ReadFlashData      = 8
ClearSetting       = 9
StatusChanged      = 10
GetCurrentConfig   = 14
SetCurrentConfig   = 15
ReadVersionID      = 18
SetLongRangeMode   = 22
GetLongRangeMode   = 23
GetDongleVersion   = 29
```

### Inbound (device → host) packet decoders

Variable `Ie` is a `Uint8Array(16)` holding the report (already stripped of the report ID).

| opcode | meaning |
|---|---|
| `EncryptionData` (1) | `Ie[9]=cid`, `Ie[10]=mid`, `Ie[11]=type` (0=wireless 1KHz, 1=wireless 4KHz, 2=wired 1KHz, 3=wired 8KHz, 4=wireless 2KHz, 5=wireless 8KHz). Sent on connect. |
| `PCDriverStatus` (2) | (no-op in the host code) |
| `DeviceOnLine` (3) | `Ie[5]=online?`, `Ie[6..8]=device address` (3 bytes, reversed) |
| `BatteryLevel` (4) | `Ie[5]=level%`, `Ie[6]=charging? 0/1`, `Ie[7..8]=voltage(mV) BE` |
| `DongleEnterPair` (5) | starts a 1Hz `GetPairState` poll |
| `GetPairState` (6) | `Ie[5]=status`, `Ie[6]=secondsLeft` |
| `WriteFlashData` (7) | ack: `Ie[3..4]` = address echo, `Ie[4]` = length echo |
| `ReadFlashData` (8) | `Ie[2..3]=address` (BE), `Ie[4]=length`, `Ie[5..]=data` |
| `ClearSetting` (9) | factory-reset ack |
| `StatusChanged` (10) | `Ie[5]` = bitmask of changed regions; host responds by reading the right flash region |
| `GetCurrentConfig` (14) | `Ie[5]` = active profile index |
| `ReadVersionID` (18) | firmware version `v{Ie[5]}.{Ie[6] hex padded 2}` |
| `GetLongRangeMode` (23) | `Ie[5]` = 0/1 |
| `GetDongleVersion` (29) | dongle firmware version, same encoding as ReadVersionID |

### `StatusChanged` bitmask (mouse, `Ie[5]`)

| bit | meaning | host action |
|----:|---|---|
| 0x01 | DPI changed | re-read `de.CurrentDPI` (2 bytes) |
| 0x02 | Report rate changed | re-read `de.ReportRate` (2 bytes) |
| 0x04 | Profile changed | issue `GetCurrentConfig` |
| 0x08 | DPI effect changed | re-read `de.DPIEffectMode` (8 bytes) |
| 0x20 | Light effect changed | re-read `de.Light` (7 bytes) |
| 0x40 | Battery level changed | re-issue `BatteryLevel` |

### Outbound packet builders (host → device)

**Get / poll** (no payload) — `ha(opcode)`:
```
[opcode, 0, 0, 0, classBit, 0,0,0,0,0,0,0,0,0,0, ck]
```
where `classBit = 0` for mouse, `0x80` for keyboard.

**Read flash** — `Bt(addr, len)`:
```
[8 (=ReadFlashData), 0, addrHi, addrLo, len|classBit, 0,0,0,0,0,0,0,0,0,0, ck]
```
Device replies with a `ReadFlashData` packet containing the bytes.

**Write a single byte to flash** — `Pe(addr, val)`:
```
[7 (=WriteFlashData), 0, addrHi, addrLo, 2|classBit, val, (85-val) & 0xFF, 0,0,0,0,0,0,0,0, ck]
```
The redundant `(85-val)` byte is a per-byte parity (firmware verifies it).

**Write a block to flash** — `st(addr, bytes[])`: chunks data into 10-byte sections, one packet per chunk:
```
[7, 0, (addr+i*10)Hi, (addr+i*10)Lo, chunkLen|classBit, b0,b1,...,b9 (zero-padded), ck]
```

**Generic command with payload** — `Ri(opcode, payload[])`:
```
[opcode, 0, 0, 0, payload.length|classBit, p0,p1,...,p9 (zero-padded), ck]
```

---

## 4. Mouse flash memory map (`de` enum)

```
ReportRate           0     uint16
maxDpiStage          2     uint8 (probably index of the highest enabled DPI stage)
CurrentDPI           4     uint16
LOD                 10     uint8 (1/2 mm)
DPIValue            12     8 stages × 4 bytes (each = uint16 DPI in big-endian + 0x55 parity?)
DPIColor            44     8 stages × 4 bytes (R,G,B + parity)
DPIEffectMode       76     uint8
DPIEffectBrightness 78
DPIEffectSpeed      80
DPIEffectState      82
KeyFunction         96     N buttons × 4 bytes — see §5
Light              160     7 bytes (mode/brightness/speed/etc.)
DebounceTime       169
MotionSync         171
SleepTime          173
Angle              175
Ripple             177
MovingOffLight     179
PerformanceState   181
Performance        183
SensorMode         185
ShortcutKey        256     up to N slots × 32 bytes — see §6
Macro              768     up to N slots × 384 bytes — see §7
```

The HYPACE has `keysCount = 6` (verified against `cfg.json`).

### Single-byte-with-parity layout

Anywhere flash stores a one-byte setting (`Pe`-class writes), it is:
```
[value, 85-value]
```
i.e. `byte[addr+0] + byte[addr+1] === 85 (mod 256)`. This is the firmware's per-byte integrity check.

---

## 5. Button assignments — `KeyFunction` (offset 96)

Each button takes **4 bytes**:

```
offset  meaning
------  -------
0       action type (Ts enum, see below)
1       param hi
2       param lo
3       checksum  (= nt([type, paramHi, paramLo]) mod 256, where nt = 85 - sum(...))
```

To rebind button index `n` (0 .. keysCount-1), call `WriteFlashData` to address `96 + n*4` with the 4-byte block above.

### Action types — the `Ts` enum

```
Disable           = 0
MouseKey          = 1
DPISwitch         = 2
LeftRightRoll     = 3
FireKey           = 4
ShortcutKey       = 5
Macro             = 6
ReportRateSwitch  = 7
LightSwitch       = 8
ProfileSwitch     = 9
DPILock           = 10
UpDownRoll        = 11
MouseFireKey      = 13
LeftKey           = 256   (alternate left-click code)
```

### Action `param` semantics

| type | param meaning |
|---|---|
| `Disable` (0) | param = 0 |
| `MouseKey` (1) | bitmask: `0x0100` L, `0x0200` R, `0x0400` Middle, `0x0800` Back, `0x1000` Forward |
| `DPISwitch` (2) | `0x0100` = cycle (per cfg `keys[5]` default for the HYPACE's top button) |
| `LeftRightRoll` (3) | direction tilt-wheel (param TBD — encoder probably symmetric to UpDownRoll) |
| `FireKey` (4) | a "burst" / rapid-fire of a key, param probably = (count<<8) | mouseBitmask |
| `ShortcutKey` (5) | param = slot index in the ShortcutKey table (256+slot*32) |
| `Macro` (6) | param = slot index in the Macro table (768+slot*384) |
| `ReportRateSwitch` (7) | cycles report-rate values (see lang_en `ReportRates`) |
| `LightSwitch` (8) | toggles light effects |
| `ProfileSwitch` (9) | switches profile |
| `DPILock` (10) | hold-to-set-low-DPI (sniper) |
| `UpDownRoll` (11) | scroll-wheel direction |

(The exact param encoding for `FireKey` / `LeftRightRoll` / `UpDownRoll` is not fully exhausted from this trace; you can confirm by reading back `KeyFunction` on a freshly bound button.)

### Default button mapping for HYPACE (from `cfg.json`)

| index | location (web UI px) | type | param | meaning |
|---|---|---:|---:|---|
| 0 | (160,280) | 1 | 0x0100 | Left click |
| 1 | (100,230) | 1 | 0x0200 | Right click |
| 2 | (220,180) | 1 | 0x0400 | Middle click |
| 3 | (360,250) | 1 | 0x0800 | Back |
| 4 | (306,260) | 1 | 0x1000 | Forward |
| 5 | (290,155) | 2 | 0x0100 | DPI cycle (top button) |

---

## 6. ShortcutKey slots (offset 256)

Each slot = **32 bytes**, index `e`. Layout (host code in `em(e, keysArr)`):

```
[0]    keyCount * 2          (each key takes 3 bytes after the header; *2 is the firmware convention)
[1..]  triplets of (type | 0x80, valLo, valHi)   for each key in the chord
```

The `type` and `value` come from the `Jn` keymap dict (see §9). For chords like `Cmd+Shift+T`, push each modifier first, then the regular key.

The `Set_MS_Multimedia` builder (`Qh`) creates a ShortcutKey-style slot but with a **different first byte 2** and uses both a 0x82-prefixed copy and a 0x42-prefixed copy of the same value — that is the firmware's representation of a **consumer-control** (multimedia) keypress.

To make a button play a multimedia shortcut, set the button's KeyFunction to type 5 (ShortcutKey) and `param` = slot index, then write the multimedia-encoded slot at `256 + slot*32`.

---

## 7. Macro slots (offset 768)

Each slot = **384 bytes**.

- Bytes `[0..30]`: macro **name** (UTF-8, 31-byte field; written by `rm(e, name)`).
- Bytes `[31..]`: macro **context** = the recorded event sequence (written by `nm(e, contexts)`).

Each event in the context uses one of the InsertEventOptions from `lang_en.json`:

```
command 0 = Press
command 1 = Release
command 2 = Left Click   (value 0x040001)
command 3 = Right Click  (value 0x040002)
command 4 = Middle Click (value 0x040004)
command 5 = Forward      (value 0x040010)
command 6 = Backward     (value 0x040008)
```

The exact event-record byte format is built by `w6` / `lm` / `sm` (search those names in the bundle to recover the bit-level layout). It interleaves keypress events (Jn-type/value triplets) and click commands plus a delay field.

---

## 8. Other settings (single-byte writes via `Pe`)

| Setting | Address | Values |
|---|---:|---|
| Report rate | 0 | values from `lang_en.ReportRates` (e.g. 1=1000Hz, 2=500, 4=250, 8=125, 16=2000, 32=4000, 64=8000) |
| LOD | 10 | 1 or 2 mm |
| Debounce | 169 | 0 .. 15 (ms) |
| Motion sync | 171 | 0/1 |
| Sleep time | 173 | values from `lang_en.LightOffTimeOptions` (1=10s, 3=30s, 6=1m, 12=2m, 30=5m, 60=10m, 90=15m) |
| Angle snapping | 175 | 0/1 |
| Ripple control | 177 | 0/1 |
| Performance state | 181 | 0/1 |
| Performance time | 183 | seconds |
| Sensor mode | 185 | one of `sensor.json` mode codes |
| Long-range mode | (separate, opcode 22/23 — not in flash map) | 0/1 |

The DPI table (`DPIValue` at 12, `DPIColor` at 44) is set with `st()` chunked writes — DPI is uint16 BE and color is RGB888 (each 4-byte slot ends with parity / 85-checksum byte).

---

## 9. Keymap dictionary `Jn`

104 entries, each `{ type, value, text }`. Two type categories:

- **type 0** — modifier (the `value` is an HID modifier-byte bitmask):
  ```
  ControlLeft  1     ShiftLeft   2     AltLeft   4     MetaLeft  8
  ControlRight 16    ShiftRight 32     AltRight 64     MetaRight 128
  ```
- **type 1** — regular key (the `value` is a USB HID Keyboard/Keypad Usage ID):
  e.g. `Esc=41, Tab=43, Space=44, Enter=40, Backspace=42, A=4, B=5, ..., Z=29, 1=30, ..., 0=39, F1=58, ..., F12=69`

The full table is dumped in `keymap_Jn.txt` next to this doc.

When written into a ShortcutKey slot or a Macro context, the type byte is OR'd with `0x80` (the "send-this-key" bit).

---

## 10. Multimedia / consumer-control codes (from `cfg.json` → `medias`)

Each media key uses `[type=0x03, hidConsumerUsage]`:

| icon | usage |
|---|---:|
| light-up | 0x006F |
| light-down | 0x0070 |
| mute | 0x00E2 |
| volume-up | 0x00E9 |
| volume-down | 0x00EA |
| play | 0x00CD |
| previous | 0x00B6 |
| next | 0x00B5 |
| stop | (look in cfg.medias) |
| backward | 0x0225 |
| forward | 0x0224 |
| favorites | 0x022A |
| web-stop | 0x0226 |
| refresh | 0x0227 |

These are written into a ShortcutKey slot via the multimedia variant (see §6), and the button is bound with type=5 (ShortcutKey) pointing at that slot.

---

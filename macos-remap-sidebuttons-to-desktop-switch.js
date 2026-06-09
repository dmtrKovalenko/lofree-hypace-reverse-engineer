#!/usr/bin/env node
// Remap HYPACE side buttons to macOS Mission Control desktop switching:
//   Button 3 (Back, side-thumb-back)    -> Ctrl+Left
//   Button 4 (Forward, side-thumb-fwd)  -> Ctrl+Right
//
// Recovery: factory reset = ClearSetting (opcode 9). Or run with --restore
// to put the side buttons back to standard MouseKey 0x0800 / 0x1000.

const HID = require('node-hid');

const REPORT_ID = 8;
const Fe = { WriteFlashData: 7, ReadFlashData: 8, ClearSetting: 9 };
const de = { KeyFunction: 96, ShortcutKey: 256 };

const VIDS = [0x373B, 0x3554];
const PIDS = [0x101B, 0xF5F4, 0xF590, 0xF5D5, 0xF53E, 0xF501, 0xF5F6, 0xFB14, 0xFB16];
const VENDOR_USAGE_PAGES = new Set([0xFF02, 0xFF03, 0xFF04, 0xFF05, 0xFF06]);

// HID Usage IDs from the Jn keymap
const HID_KEY = {
  ControlLeft:  { type: 0, value:   1 },
  ArrowLeft:    { type: 1, value: 0x50 },
  ArrowRight:   { type: 1, value: 0x4F },
};

function findHypace() {
  const matches = HID.devices().filter(d => VIDS.includes(d.vendorId) && PIDS.includes(d.productId));
  return matches.find(d => VENDOR_USAGE_PAGES.has(d.usagePage)) || matches[0];
}

function packetChecksum(buf) {
  let s = 0;
  for (let i = 0; i < 15; i++) s += buf[i];
  return (85 - REPORT_ID - s) & 0xFF;
}

function blockChecksum(bytes) {
  // Slot/key-block checksum: stored at bytes[length-1] = (85 - sum(bytes[0..length-2])) & 0xFF
  let s = 0;
  for (let i = 0; i < bytes.length - 1; i++) s += bytes[i];
  return (85 - s) & 0xFF;
}

function send(dev, buf) {
  const out = Buffer.concat([Buffer.from([REPORT_ID]), buf]);
  dev.write(Array.from(out));
}

function readOnce(dev, timeoutMs = 800) {
  return new Promise(resolve => {
    const t = setTimeout(() => { dev.removeAllListeners('data'); resolve(null); }, timeoutMs);
    dev.once('data', d => { clearTimeout(t); resolve(d); });
  });
}

async function readFlash(dev, addr, len) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const buf = Buffer.alloc(16, 0);
    buf[0] = Fe.ReadFlashData;
    buf[2] = (addr >> 8) & 0xFF;
    buf[3] = addr & 0xFF;
    buf[4] = len;
    buf[15] = packetChecksum(buf);
    send(dev, buf);
    const reply = await readOnce(dev);
    if (!reply) continue;
    const off = reply.length === 17 ? 1 : 0;
    if (reply[off] !== Fe.ReadFlashData) continue;
    if (((reply[off + 2] << 8) | reply[off + 3]) !== addr) continue;
    return reply.slice(off + 5, off + 5 + len);
  }
  return null;
}

// Chunked write: max 10 bytes per packet at addr+i*10. Mirrors st() in the bundle.
async function writeFlash(dev, addr, bytes) {
  const totalChunks = Math.ceil(bytes.length / 10);
  for (let i = 0; i < totalChunks; i++) {
    const chunkAddr = addr + i * 10;
    const chunkLen = Math.min(10, bytes.length - i * 10);
    const buf = Buffer.alloc(16, 0);
    buf[0] = Fe.WriteFlashData;
    buf[2] = (chunkAddr >> 8) & 0xFF;
    buf[3] = chunkAddr & 0xFF;
    buf[4] = chunkLen;
    for (let j = 0; j < chunkLen; j++) buf[5 + j] = bytes[i * 10 + j];
    buf[15] = packetChecksum(buf);
    send(dev, buf);
    await new Promise(r => setTimeout(r, 30)); // small gap so the firmware isn't overrun
  }
}

// Build a ShortcutKey slot payload for a key chord.
// Mirrors em(slot, keysArr) in the bundle:
//   [count*2, (type|0x80, valLo, valHi) for each key, (type|0x40, valLo, valHi) for each key reversed, checksum]
function buildShortcutSlot(keys) {
  const a = [];
  a.push(keys.length * 2);
  for (const k of keys) {
    a.push(k.type | 0x80);
    a.push(k.value & 0xFF);
    a.push((k.value >> 8) & 0xFF);
  }
  for (let i = keys.length - 1; i >= 0; i--) {
    const k = keys[i];
    a.push(k.type | 0x40);
    a.push(k.value & 0xFF);
    a.push((k.value >> 8) & 0xFF);
  }
  a.push(0); // placeholder for checksum
  a[a.length - 1] = blockChecksum(a);
  return a;
}

// Build a 4-byte KeyFunction record.
function buildKeyBlock(type, param) {
  const block = [type, (param >> 8) & 0xFF, param & 0xFF, 0];
  block[3] = blockChecksum(block);
  return block;
}

async function bindShortcutToButton(dev, buttonIdx, keys) {
  // 1. Write the ShortcutKey slot. Slot index == button index.
  const slotAddr = de.ShortcutKey + buttonIdx * 32;
  const slotBytes = buildShortcutSlot(keys);
  console.log(`  slot ${buttonIdx} @ 0x${slotAddr.toString(16)}: ${Buffer.from(slotBytes).toString('hex')}`);
  await writeFlash(dev, slotAddr, slotBytes);

  // 2. Bind the button to type=5 (ShortcutKey). Param=0; the firmware uses buttonIdx as the slot.
  const btnAddr = de.KeyFunction + buttonIdx * 4;
  const btnBytes = buildKeyBlock(5, 0);
  console.log(`  btn ${buttonIdx}  @ 0x${btnAddr.toString(16)}: ${Buffer.from(btnBytes).toString('hex')}`);
  await writeFlash(dev, btnAddr, btnBytes);
}

async function restoreDefaults(dev) {
  // Original side buttons:
  //   index 3 -> MouseKey 0x0800 (Back)
  //   index 4 -> MouseKey 0x1000 (Forward)
  console.log('Restoring side buttons to MouseKey defaults...');
  await writeFlash(dev, de.KeyFunction + 3 * 4, buildKeyBlock(1, 0x0800));
  await writeFlash(dev, de.KeyFunction + 4 * 4, buildKeyBlock(1, 0x1000));
  console.log('Done.');
}

async function readBackButton(dev, idx) {
  const data = await readFlash(dev, de.KeyFunction + idx * 4, 4);
  if (!data) return null;
  return {
    type: data[0],
    param: '0x' + (((data[1] << 8) | data[2])).toString(16).padStart(4, '0'),
    check: data[3],
  };
}

async function main() {
  const m = findHypace();
  if (!m) { console.error('HYPACE not found'); process.exit(1); }
  console.log(`Opening ${m.vendorId.toString(16)}:${m.productId.toString(16)} on path=${m.path}`);
  const dev = new HID.HID(m.path);

  if (process.argv.includes('--restore')) {
    await restoreDefaults(dev);
  } else {
    console.log('Binding button 3 -> Ctrl+Left');
    await bindShortcutToButton(dev, 3, [HID_KEY.ControlLeft, HID_KEY.ArrowLeft]);
    console.log('Binding button 4 -> Ctrl+Right');
    await bindShortcutToButton(dev, 4, [HID_KEY.ControlLeft, HID_KEY.ArrowRight]);
  }

  // Drain any unsolicited reports for a moment, then read back.
  await new Promise(r => setTimeout(r, 200));
  console.log('\nVerification:');
  console.log('  button 3 ->', await readBackButton(dev, 3));
  console.log('  button 4 ->', await readBackButton(dev, 4));

  setTimeout(() => { dev.close(); process.exit(0); }, 200);
}

main().catch(e => { console.error(e); process.exit(1); });

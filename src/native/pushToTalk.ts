import fs from "node:fs";
import { Worker } from "node:worker_threads";

import { ipcMain } from "electron";

import { config } from "./config";
import { mainWindow } from "./window";

/**
 * Push-to-talk
 *
 * Key detection has two sources:
 *  - `before-input-event` on the main window (works everywhere, focused only)
 *  - Linux evdev (`/dev/input/event*`), which works globally on both X11 and
 *    Wayland, and also sees mouse side buttons. Requires read access to the
 *    input devices (i.e. the user is in the `input` group).
 *
 * The resulting state is sent to the renderer, where the preload gates the
 * microphone tracks returned by getUserMedia (see `world/pushToTalk.ts`).
 */

export type PushToTalkState = {
  /** push-to-talk is turned on */
  enabled: boolean;
  /** microphone is currently allowed to transmit */
  open: boolean;
  /** configured key, KeyboardEvent.code-style */
  keybind: string;
  /** whether the key is detected while the window isn't focused */
  global: boolean;
};

// KeyboardEvent.code-style name -> Linux evdev key code
const EVDEV_CODES: Record<string, number> = {
  Escape: 1,
  Digit1: 2,
  Digit2: 3,
  Digit3: 4,
  Digit4: 5,
  Digit5: 6,
  Digit6: 7,
  Digit7: 8,
  Digit8: 9,
  Digit9: 10,
  Digit0: 11,
  Minus: 12,
  Equal: 13,
  Backspace: 14,
  Tab: 15,
  KeyQ: 16,
  KeyW: 17,
  KeyE: 18,
  KeyR: 19,
  KeyT: 20,
  KeyY: 21,
  KeyU: 22,
  KeyI: 23,
  KeyO: 24,
  KeyP: 25,
  BracketLeft: 26,
  BracketRight: 27,
  Enter: 28,
  ControlLeft: 29,
  KeyA: 30,
  KeyS: 31,
  KeyD: 32,
  KeyF: 33,
  KeyG: 34,
  KeyH: 35,
  KeyJ: 36,
  KeyK: 37,
  KeyL: 38,
  Semicolon: 39,
  Quote: 40,
  Backquote: 41,
  ShiftLeft: 42,
  Backslash: 43,
  KeyZ: 44,
  KeyX: 45,
  KeyC: 46,
  KeyV: 47,
  KeyB: 48,
  KeyN: 49,
  KeyM: 50,
  Comma: 51,
  Period: 52,
  Slash: 53,
  ShiftRight: 54,
  NumpadMultiply: 55,
  AltLeft: 56,
  Space: 57,
  CapsLock: 58,
  F1: 59,
  F2: 60,
  F3: 61,
  F4: 62,
  F5: 63,
  F6: 64,
  F7: 65,
  F8: 66,
  F9: 67,
  F10: 68,
  NumLock: 69,
  ScrollLock: 70,
  Numpad7: 71,
  Numpad8: 72,
  Numpad9: 73,
  NumpadSubtract: 74,
  Numpad4: 75,
  Numpad5: 76,
  Numpad6: 77,
  NumpadAdd: 78,
  Numpad1: 79,
  Numpad2: 80,
  Numpad3: 81,
  Numpad0: 82,
  NumpadDecimal: 83,
  IntlBackslash: 86,
  F11: 87,
  F12: 88,
  NumpadEnter: 96,
  ControlRight: 97,
  NumpadDivide: 98,
  PrintScreen: 99,
  AltRight: 100,
  Home: 102,
  ArrowUp: 103,
  PageUp: 104,
  ArrowLeft: 105,
  ArrowRight: 106,
  End: 107,
  ArrowDown: 108,
  PageDown: 109,
  Insert: 110,
  Delete: 111,
  Pause: 119,
  MetaLeft: 125,
  MetaRight: 126,
  ContextMenu: 127,
  F13: 183,
  F14: 184,
  F15: 185,
  F16: 186,
  F17: 187,
  F18: 188,
  F19: 189,
  F20: 190,
  F21: 191,
  F22: 192,
  F23: 193,
  F24: 194,
  MouseMiddle: 274,
  Mouse4: 275, // BTN_SIDE (usually "back")
  Mouse5: 276, // BTN_EXTRA (usually "forward")
  Mouse6: 277, // BTN_FORWARD
  Mouse7: 278, // BTN_BACK
};

function codeToEvdev(code: string): number | undefined {
  if (code in EVDEV_CODES) return EVDEV_CODES[code];
  const match = /^Evdev(\d+)$/.exec(code);
  return match ? Number(match[1]) : undefined;
}

// ---- state ----

let open = false;
let keyHeld = false;
let releaseTimer: NodeJS.Timeout | undefined;

function sendState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("pushToTalk", getPushToTalkState());
  }
}

export function getPushToTalkState(): PushToTalkState {
  return {
    enabled: config.pushToTalk,
    open,
    keybind: config.pushToTalkKeybind,
    global: evdevActive(),
  };
}

function setOpen(value: boolean) {
  if (releaseTimer) {
    clearTimeout(releaseTimer);
    releaseTimer = undefined;
  }

  if (open !== value) {
    open = value;
    sendState();
  }
}

function onKey(code: string, down: boolean) {
  if (!config.pushToTalk || code !== config.pushToTalkKeybind) return;

  if (down) {
    // ignore auto-repeat and the same press seen from a second source
    if (keyHeld) return;
    keyHeld = true;

    if (config.pushToTalkMode === "toggle") {
      setOpen(!open);
    } else {
      setOpen(true);
    }
  } else {
    if (!keyHeld) return;
    keyHeld = false;

    if (config.pushToTalkMode === "hold") {
      const delay = config.pushToTalkReleaseDelay;
      if (delay > 0) {
        if (releaseTimer) clearTimeout(releaseTimer);
        releaseTimer = setTimeout(() => setOpen(false), delay);
      } else {
        setOpen(false);
      }
    }
  }
}

// ---- in-window key events ----

function handleBeforeInput(_event: Electron.Event, input: Electron.Input) {
  if (input.type !== "keyDown" && input.type !== "keyUp") return;
  if (input.isAutoRepeat) return;

  // global listener already sees everything
  if (evdevActive()) return;

  onKey(input.code, input.type === "keyDown");
}

function handleBlur() {
  // without the global listener we'll never see the key-up once unfocused
  if (!evdevActive() && keyHeld) {
    onKey(config.pushToTalkKeybind, false);
  }
}

// ---- global (evdev) key events ----

// Each device is read from its own worker thread using blocking reads, so we
// don't tie up libuv's shared thread pool.
const EVDEV_WORKER = `
const { workerData, parentPort } = require("node:worker_threads");
const fs = require("node:fs");
let fd;
try { fd = fs.openSync(workerData, "r"); } catch (e) { process.exit(1); }
// struct input_event on 64-bit: timeval (16), type u16, code u16, value s32
const SIZE = 24;
const buf = Buffer.alloc(SIZE * 64);
for (;;) {
  let n;
  try { n = fs.readSync(fd, buf, 0, buf.length, null); } catch (e) { break; }
  if (n <= 0) break;
  for (let o = 0; o + SIZE <= n; o += SIZE) {
    if (buf.readUInt16LE(o + 16) !== 1) continue; // EV_KEY
    const value = buf.readInt32LE(o + 20);
    if (value === 2) continue; // auto-repeat
    parentPort.postMessage([buf.readUInt16LE(o + 18), value === 1]);
  }
}
`;

const evdevWorkers = new Map<string, Worker>();
let evdevScanInterval: NodeJS.Timeout | undefined;

function evdevActive() {
  return evdevWorkers.size > 0;
}

type InputDevice = { path: string; keys: bigint };

/**
 * List input devices and the keys they support from /proc/bus/input/devices
 */
function listInputDevices(): InputDevice[] {
  let text: string;
  try {
    text = fs.readFileSync("/proc/bus/input/devices", "utf8");
  } catch {
    return [];
  }

  const wordBits = BigInt(process.arch.endsWith("64") ? 64 : 32);
  const devices: InputDevice[] = [];

  for (const block of text.split(/\n\s*\n/)) {
    const event = /^H: Handlers=.*\b(event\d+)\b/m.exec(block)?.[1];
    const keyLine = /^B: KEY=([0-9a-f ]+)$/m.exec(block)?.[1];
    if (!event || !keyLine) continue;

    let keys = 0n;
    keyLine
      .trim()
      .split(/\s+/)
      .reverse()
      .forEach((word, i) => {
        keys |= BigInt("0x" + word) << (wordBits * BigInt(i));
      });

    devices.push({ path: `/dev/input/${event}`, keys });
  }

  return devices;
}

const supports = (device: InputDevice, code: number) =>
  ((device.keys >> BigInt(code)) & 1n) === 1n;

/**
 * Start listening on any devices that have the configured key
 * @returns whether any device could be opened
 */
function scanEvdevDevices(): boolean {
  if (process.platform !== "linux") return false;

  const target = codeToEvdev(config.pushToTalkKeybind);

  for (const device of listInputDevices()) {
    if (evdevWorkers.has(device.path)) continue;

    if (target === undefined || !supports(device, target)) continue;

    try {
      fs.accessSync(device.path, fs.constants.R_OK);
    } catch {
      continue;
    }

    const worker = new Worker(EVDEV_WORKER, {
      eval: true,
      workerData: device.path,
    });
    worker.on("message", ([code, down]: [number, boolean]) => {
      if (code === target) onKey(config.pushToTalkKeybind, down);
    });
    const remove = () => {
      if (evdevWorkers.get(device.path) === worker) {
        evdevWorkers.delete(device.path);
        sendState();
      }
    };
    worker.on("error", remove);
    worker.on("exit", remove);
    worker.unref();
    evdevWorkers.set(device.path, worker);
  }

  return evdevActive();
}

function startEvdev() {
  const before = evdevWorkers.size;
  scanEvdevDevices();
  if (evdevWorkers.size !== before) sendState();
  // pick up devices plugged in later
  if (!evdevScanInterval) {
    evdevScanInterval = setInterval(() => {
      const before = evdevWorkers.size;
      scanEvdevDevices();
      if (evdevWorkers.size !== before) sendState();
    }, 5000);
    evdevScanInterval.unref();
  }
}

function stopEvdev() {
  if (evdevScanInterval) {
    clearInterval(evdevScanInterval);
    evdevScanInterval = undefined;
  }

  for (const worker of evdevWorkers.values()) {
    worker.terminate();
  }

  evdevWorkers.clear();
}

// ---- lifecycle ----

/**
 * Re-apply configuration (called from config setters)
 */
export function onPushToTalkConfigChanged() {
  keyHeld = false;
  setOpen(false);

  stopEvdev();
  if (config.pushToTalk) startEvdev();

  sendState();
}

export function initPushToTalk() {
  ipcMain.handle("pushToTalk:getState", () => getPushToTalkState());

  // mouse buttons seen by the page (when there's no global listener)
  ipcMain.on("pushToTalk:input", (_, code: string, down: boolean) => {
    if (!evdevActive() && typeof code === "string") onKey(code, !!down);
  });

  mainWindow.webContents.on("before-input-event", handleBeforeInput);
  mainWindow.on("blur", handleBlur);

  // resend state after reloads
  mainWindow.webContents.on("did-finish-load", sendState);

  if (config.pushToTalk) startEvdev();
}

export function destroyPushToTalk() {
  stopEvdev();
}

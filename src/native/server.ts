import { BrowserWindow, app, ipcMain, net } from "electron";

import { config } from "./config";
import { serverPickerHtml } from "./serverPicker";
import { mainWindow } from "./window";

/** Official hosted instance */
export const OFFICIAL_SERVER = "https://stoat.chat/app";

const forcedServer = app.commandLine.hasSwitch("force-server")
  ? app.commandLine.getSwitchValue("force-server")
  : undefined;

/**
 * Server the app is configured to use, if one has been chosen
 */
export function getServerUrl(): URL | undefined {
  const value = forcedServer || config.serverUrl;
  if (!value) return;

  try {
    return new URL(value);
  } catch {
    return;
  }
}

function normaliseServerUrl(input: string): string {
  let value = input.trim();
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = "https://" + value;

  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Only http:// and https:// addresses are supported.");
  }

  url.hash = "";
  return url.toString();
}

function isPickerFrame(frame: Electron.WebFrameMain | null) {
  return !!frame && frame.url.startsWith("data:");
}

/**
 * Show the server picker in the given window
 */
export function showServerPicker(window: BrowserWindow, error?: string) {
  const html = serverPickerHtml({
    official: OFFICIAL_SERVER,
    current: getServerUrl()?.toString(),
    error,
    canCancel: !!getServerUrl() && !error,
  });

  window.loadURL(
    "data:text/html;charset=utf-8;base64," +
      Buffer.from(html).toString("base64"),
  );
}

/**
 * Load the configured server, or ask for one
 */
export function loadApp(window: BrowserWindow) {
  const url = getServerUrl();
  if (!url) return showServerPicker(window);

  window
    .loadURL(url.toString())
    .then(() => window.webContents.reload())
    .catch(() => {
      // handled by did-fail-load
    });
}

export function initServerSelection(window: BrowserWindow) {
  // fall back to the picker when the server can't be reached
  window.webContents.on(
    "did-fail-load",
    (_event, code, description, url, isMainFrame) => {
      // -3 = ERR_ABORTED (e.g. superseded navigation)
      if (!isMainFrame || code === -3 || url.startsWith("data:")) return;
      showServerPicker(
        window,
        `Couldn't connect to ${new URL(url).host} (${description}).`,
      );
    },
  );
}

ipcMain.handle("server:choose", async (event, input: string) => {
  if (!isPickerFrame(event.senderFrame)) {
    throw new Error("Not allowed");
  }

  let url: string;
  try {
    url = normaliseServerUrl(String(input));
  } catch (err) {
    return { error: (err as Error).message || "That address isn't valid." };
  }

  // make sure something is actually there before switching
  try {
    const response = await net.fetch(url, {
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      return {
        error: `${new URL(url).host} responded with ${response.status} ${response.statusText}.`,
      };
    }
  } catch (err) {
    return {
      error: `Couldn't reach ${new URL(url).host}: ${(err as Error).message}`,
    };
  }

  config.serverUrl = url;
  loadApp(mainWindow);
  return { ok: true };
});

ipcMain.on("server:cancel", (event) => {
  if (isPickerFrame(event.senderFrame) && getServerUrl()) loadApp(mainWindow);
});

ipcMain.on("server:openPicker", () => showServerPicker(mainWindow));

ipcMain.handle("server:get", () => getServerUrl()?.toString() ?? null);

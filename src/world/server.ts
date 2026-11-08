import { contextBridge, ipcRenderer } from "electron";

if (location.protocol === "data:") {
  // the built-in server picker page
  contextBridge.exposeInMainWorld("serverPicker", {
    choose: (url: string) =>
      ipcRenderer.invoke("server:choose", String(url)) as Promise<{
        ok?: boolean;
        error?: string;
      }>,
    cancel: () => ipcRenderer.send("server:cancel"),
  });
} else {
  contextBridge.exposeInMainWorld("desktopServer", {
    get: () => ipcRenderer.invoke("server:get") as Promise<string | null>,
    change: () => ipcRenderer.send("server:openPicker"),
  });
}

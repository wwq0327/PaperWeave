import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("paperweave", {
  getRuntimeVersions: () => ipcRenderer.invoke("app:getRuntimeVersions"),
  platform: process.platform,
});

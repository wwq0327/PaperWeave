import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("paperweave", {
  getRuntimeVersions: () => ipcRenderer.invoke("app:getRuntimeVersions"),
  platform: process.platform,
  loadDraft: () => ipcRenderer.invoke("editor:load"),
  saveDraft: (draft: unknown) => ipcRenderer.invoke("editor:save", draft),
  chooseImage: () => ipcRenderer.invoke("editor:chooseImage"),
  getImage: (id: string) => ipcRenderer.invoke("editor:image", id),
});

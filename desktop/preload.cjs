const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('workbench', Object.freeze({
  chooseDirectory: () => ipcRenderer.invoke('choose-directory'),
  chooseFile: () => ipcRenderer.invoke('choose-file'),
}));

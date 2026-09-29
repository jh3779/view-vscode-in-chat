const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  host: (nick, port) => ipcRenderer.invoke('host', { nick, port }),
  join: (nick, address) => ipcRenderer.invoke('join', { nick, address }),
  info: () => ipcRenderer.invoke('info'),
  onRooms: (cb) => ipcRenderer.on('rooms', (_e, rooms) => cb(rooms)),
});

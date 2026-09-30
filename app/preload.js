const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  host: (nick, port, password) => ipcRenderer.invoke('host', { nick, port, password }),
  join: (nick, address, password) => ipcRenderer.invoke('join', { nick, address, password }),
  probe: (address) => ipcRenderer.invoke('probe', { address }),
  info: () => ipcRenderer.invoke('info'),
  onRooms: (cb) => ipcRenderer.on('rooms', (_e, rooms) => cb(rooms)),
});

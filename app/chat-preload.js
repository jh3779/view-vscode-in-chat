// 채팅 창에 노출하는 최소 API.
// 방 목록은 메인 프로세스가 UDP 로 모아 주고, 이동도 메인이 수행한다.
// 페이지가 스스로 다른 origin 으로 가는 것은 will-navigate 가 막는다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lanRooms', {
  onRooms: (cb) => ipcRenderer.on('rooms', (_e, rooms) => cb(rooms)),
  switchTo: (room, password, nick) =>
    ipcRenderer.invoke('switch-room', { ip: room.ip, port: room.port, password, nick }),
});

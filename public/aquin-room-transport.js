// public/aquin-room-transport.js — the pluggable ROOM TRANSPORT interface (Prompt H2). Breakouts +
// presenter control are APPLICATION logic written against this interface, so the media provider
// (today: the WebRTC mesh; tomorrow: an SFU fleet — LiveKit/mediasoup/managed) can be swapped
// WITHOUT changing breakout/animation code. The interface is:
//   createRoom(baseId, index) -> roomId
//   joinRoom(roomId, opts)    -> handle   (opts: peerId, name, localStream, onData, onRoster, onPeerStream, onPeerLeave)
//   leaveRoom(handle)
//   moveParticipant(handle, opts, newRoomId) -> newHandle   (leave one small room, join another)
//   broadcast(handle, msg)
// A MeshTransport implements it against the CURRENT transport. Assignment logic is PURE + tested.
(function () {
  // ---- pure assignment: split participants into many SMALL rooms (H2's scaling principle) ----
  // mode 'even': `count` rooms, round-robin. mode 'size': `count` = target size per room.
  function assignParticipants(ids, count, mode) {
    ids = (ids || []).slice(); count = Math.max(1, count | 0);
    var nRooms = mode === 'size' ? Math.max(1, Math.ceil(ids.length / count)) : count;
    var rooms = []; for (var i = 0; i < nRooms; i++) rooms.push([]);
    if (mode === 'size') { for (var j = 0; j < ids.length; j++) rooms[(j / count) | 0].push(ids[j]); }
    else { for (var k = 0; k < ids.length; k++) rooms[k % nRooms].push(ids[k]); }   // even round-robin
    return rooms;
  }
  function moveParticipant(rooms, id, toIndex) {
    var next = rooms.map(function (r) { return r.filter(function (x) { return x !== id; }); });
    if (toIndex >= 0 && toIndex < next.length) next[toIndex].push(id);
    return next;
  }
  function roomOf(rooms, id) { for (var i = 0; i < rooms.length; i++) if (rooms[i].indexOf(id) >= 0) return i; return -1; }
  function breakoutRoomId(baseId, index) { return String(baseId) + '__bo' + index; }   // deterministic sub-room id
  function isBreakoutId(roomId) { return /__bo\d+$/.test(String(roomId)); }
  function baseOf(roomId) { return String(roomId).replace(/__bo\d+$/, ''); }

  // ---- MeshTransport: the interface implemented against the current WebRTC mesh ----
  function createMeshTransport(MeshRef) {
    var Mesh = MeshRef || (typeof window !== 'undefined' ? window.AquinMesh : null);
    return {
      kind: 'mesh',
      createRoom: function (baseId, index) { return index == null ? String(baseId) : breakoutRoomId(baseId, index); },
      joinRoom: function (roomId, opts) { if (!Mesh) return null; return Mesh.join(Object.assign({ roomId: roomId }, opts || {})); },
      leaveRoom: function (handle) { if (handle && handle.leave) handle.leave(); },
      moveParticipant: function (handle, opts, newRoomId) { if (handle && handle.leave) handle.leave(); return this.joinRoom(newRoomId, opts); },
      broadcast: function (handle, msg) { if (handle && handle.broadcast) handle.broadcast(msg); },
    };
  }

  var mod = { assignParticipants: assignParticipants, moveParticipant: moveParticipant, roomOf: roomOf, breakoutRoomId: breakoutRoomId, isBreakoutId: isBreakoutId, baseOf: baseOf, createMeshTransport: createMeshTransport };
  if (typeof window !== 'undefined') window.AquinRoomTransport = mod;
  if (typeof module !== 'undefined' && module.exports) module.exports = mod;
})();

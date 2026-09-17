const socket = io();

let localStream = null;
let roomId = null;
let networkType = null;
let joined = false;
const peerConnections = new Map();

const logPanel = document.getElementById('logPanel');
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const controls = document.getElementById('controls');
const joinBtn = document.getElementById('joinBtn');

function logEvent(entry) {
  const li = document.createElement('li');
  li.textContent =
    `[${new Date().toLocaleTimeString()}] ${entry.eventType}` +
    (entry.candidateType ? ` — ${entry.candidateType}` : '') +
    (entry.iceState ? ` — ${entry.iceState}` : '');
  logPanel.prepend(li);
  if (joined) socket.emit('ice-log', entry);
}

function candidateType(str) {
  const m = /typ (\w+)/.exec(str || '');
  return m ? m[1] : null;
}

function buildIceServers() {
  const { turnHost, turnUser, turnPass } = window.__ICE_CONFIG__ || {};
  if (turnHost) {
    return [
      { urls: `stun:${turnHost}:3478` },
      { urls: `turn:${turnHost}:3478`, username: turnUser, credential: turnPass },
      { urls: `turns:${turnHost}:5349`, username: turnUser, credential: turnPass },
    ];
  }
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];
}

function createPeerConnection(remoteSocketId) {
  const pc = new RTCPeerConnection({ iceServers: buildIceServers() });

  localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      logEvent({
        eventType: 'ice-candidate',
        candidateType: candidateType(event.candidate.candidate),
      });
      socket.emit('signal', {
        to: remoteSocketId,
        data: { type: 'ice', candidate: event.candidate },
      });
    } else {
      logEvent({ eventType: 'ice-candidate', candidateType: 'end' });
    }
  };

  pc.oniceconnectionstatechange = () => {
    logEvent({ eventType: 'ice-state', iceState: pc.iceConnectionState });
  };

  pc.onconnectionstatechange = () => {
    logEvent({ eventType: 'pc-state', iceState: pc.connectionState });
  };

  pc.ontrack = (event) => {
    const [stream] = event.streams;
    remoteVideo.srcObject = stream;
    remoteVideo.play().catch(() => {
      if (document.getElementById('unmuteBtn')) return;
      const btn = document.createElement('button');
      btn.id = 'unmuteBtn';
      btn.textContent = ' Activer le son distant';
      btn.onclick = () => {
        remoteVideo.muted = false;
        remoteVideo.play();
        btn.remove();
      };
      document.body.appendChild(btn);
    });
  };

  peerConnections.set(remoteSocketId, pc);
  return pc;
}

async function callPeer(remoteSocketId) {
  const pc = createPeerConnection(remoteSocketId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('signal', {
    to: remoteSocketId,
    data: { type: 'offer', sdp: pc.localDescription },
  });
  logEvent({ eventType: 'offer-sent', iceState: remoteSocketId.slice(0, 6) });
}

async function handleSignal({ from, data }) {
  let pc = peerConnections.get(from);

  if (data.type === 'offer') {
    if (!pc) pc = createPeerConnection(from);
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('signal', {
      to: from,
      data: { type: 'answer', sdp: pc.localDescription },
    });
    logEvent({ eventType: 'offer-received', iceState: from.slice(0, 6) });
  } else if (data.type === 'answer') {
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      logEvent({ eventType: 'answer-received', iceState: from.slice(0, 6) });
    }
  } else if (data.type === 'ice') {
    if (pc) {
      try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
      catch (e) { console.warn('addIceCandidate', e); }
    }
  }
}

socket.on('signal', handleSignal);

socket.on('peers-in-room', (others) => {
  logEvent({ eventType: 'peers-in-room', iceState: others.length });
  others.forEach((id) => callPeer(id));
});

socket.on('peer-joined', ({ socketId }) => {
  logEvent({ eventType: 'peer-joined', iceState: socketId.slice(0, 6) });
});

socket.on('peer-left', ({ socketId }) => {
  logEvent({ eventType: 'peer-left', iceState: socketId.slice(0, 6) });
  const pc = peerConnections.get(socketId);
  if (pc) { pc.close(); peerConnections.delete(socketId); }
  if (peerConnections.size === 0) remoteVideo.srcObject = null;
});

socket.on('log-broadcast', (entry) => {
  if (entry.peerId && entry.peerId !== socket.id) {
    const li = document.createElement('li');
    li.textContent = `[distant] ${entry.eventType}` +
      (entry.candidateType ? ` — ${entry.candidateType}` : '');
    logPanel.prepend(li);
  }
});

document.getElementById('toggleMic').addEventListener('click', (e) => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  e.target.textContent = track.enabled ? 'Couper le micro' : ' Activer le micro';
});

document.getElementById('toggleCam').addEventListener('click', (e) => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  e.target.textContent = track.enabled ? 'Couper la caméra' : 'Activer la caméra';
});

document.getElementById('remoteVolume').addEventListener('input', (e) => {
  remoteVideo.volume = parseFloat(e.target.value);
});

joinBtn.addEventListener('click', async () => {
  if (joined) return;

  roomId = document.getElementById('roomId').value.trim();
  networkType = document.getElementById('networkType').value;
  if (!roomId) { alert('ID de salle requis'); return; }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
  } catch (err) {
    alert(`Erreur caméra/micro : ${err.name} — ${err.message}`);
    console.error(err);
    return;
  }

  localVideo.srcObject = localStream;
  controls.style.display = 'flex';
  joined = true;

  socket.emit('join', { roomId, networkType });
  logEvent({ eventType: 'join-sent', iceState: roomId });
});

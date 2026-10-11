const video = document.getElementById('video');
const status = document.getElementById('connectionStatus');
const form = document.getElementById('login');
const keys = new Set();
let socket;
let peer;
let mouseX = 0;
let mouseY = 0;
let interval;
let generation = 0;
let mediaUrl;

function disconnect() {
  generation++;
  clearInterval(interval);
  keys.clear();
  peer?.close();
  socket?.close();
  video.srcObject = null;
  video.removeAttribute('src');
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = null;
  form.hidden = false;
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  disconnect();
  const attempt = generation;
  status.textContent = 'Starting private renderer…';
  try {
    const response = await fetch('/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value }),
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'Incorrect password' : 'Cannot create session (server capacity or access denied)');
    const config = await response.json();
    if (attempt !== generation) return;
    form.hidden = true;
    peer = new RTCPeerConnection({ iceServers: config.iceServers });
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`);
    const currentPeer = peer;
    const currentSocket = socket;
    currentSocket.binaryType = 'arraybuffer';
    const send = message => {
      if (currentSocket.readyState === WebSocket.OPEN) currentSocket.send(JSON.stringify(message));
    };
    const pendingIce = [];
    let chain = Promise.resolve();
    let sourceBuffer;
    let mediaSource;
    let fallback = false;
    const chunks = [];
    function appendChunk() {
      if (!sourceBuffer || sourceBuffer.updating || !chunks.length) return;
      // Keep at most 20 seconds of decoded history.
      if (sourceBuffer.buffered.length && video.currentTime > 25 &&
          sourceBuffer.buffered.start(0) < video.currentTime - 20) {
        sourceBuffer.remove(sourceBuffer.buffered.start(0), video.currentTime - 20);
        return;
      }
      sourceBuffer.appendBuffer(chunks.shift());
    }
    currentPeer.ontrack = event => {
      video.srcObject = event.streams[0];
      void video.play().catch(() => { status.textContent = 'Click video to play'; });
    };
    currentPeer.onicecandidate = event => {
      if (event.candidate) send({ type: 'ice', candidate: event.candidate.toJSON() });
    };
    currentPeer.onconnectionstatechange = () => {
      if (fallback) return;
      status.textContent = `Video: ${currentPeer.connectionState}`;
    };
    currentSocket.onmessage = event => {
      chain = chain.then(async () => {
        if (attempt !== generation) return;
        if (event.data instanceof ArrayBuffer) {
          if (chunks.length > 100) throw new Error('Video receiver too slow');
          chunks.push(event.data);
          appendChunk();
          return;
        }
        const message = JSON.parse(event.data);
        if (fallback && (message.type === 'offer' || message.type === 'ice')) return;
        if (message.type === 'offer') {
          await currentPeer.setRemoteDescription({ type: 'offer', sdp: message.sdp });
          for (const candidate of pendingIce.splice(0)) await currentPeer.addIceCandidate(candidate);
          await currentPeer.setLocalDescription(await currentPeer.createAnswer());
          send({ type: 'answer', sdp: currentPeer.localDescription.sdp });
        } else if (message.type === 'ice') {
          if (currentPeer.remoteDescription) await currentPeer.addIceCandidate(message.candidate);
          else pendingIce.push(message.candidate);
        } else if (message.type === 'fallback') {
          if (!window.MediaSource || !MediaSource.isTypeSupported(message.mimeType)) {
            throw new Error('WebRTC unavailable; this browser cannot play the WebM fallback');
          }
          fallback = true;
          currentPeer.onicecandidate = null;
          currentPeer.close();
          video.srcObject = null;
          mediaSource = new MediaSource();
          mediaUrl = URL.createObjectURL(mediaSource);
          video.src = mediaUrl;
          mediaSource.addEventListener('sourceopen', () => {
            if (attempt !== generation) return;
            sourceBuffer = mediaSource.addSourceBuffer(message.mimeType);
            sourceBuffer.addEventListener('updateend', appendChunk);
            appendChunk();
          }, { once: true });
          status.textContent = 'Video: WebSocket fallback';
          void video.play().catch(() => { status.textContent = 'Click video to play'; });
        } else if (message.type === 'error') throw new Error(message.message);
      }).catch(error => {
        if (attempt === generation) { disconnect(); status.textContent = error.message; }
      });
    };
    currentSocket.onclose = () => {
      if (attempt === generation) { disconnect(); status.textContent = 'Disconnected. Start a new session.'; }
    };
    currentSocket.onerror = () => { status.textContent = 'Signaling connection failed'; };
    interval = setInterval(() => {
      send({
        type: 'input', forward: keys.has('ArrowUp') || keys.has('KeyW'),
        backward: keys.has('ArrowDown') || keys.has('KeyS'),
        left: keys.has('ArrowLeft') || keys.has('KeyA'),
        right: keys.has('ArrowRight') || keys.has('KeyD'), x: mouseX, y: mouseY,
      });
      mouseX = mouseY = 0;
    }, 50);
  } catch (error) {
    if (attempt === generation) { disconnect(); status.textContent = error.message; }
  }
});
const navigationKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];
document.addEventListener('keydown', event => {
  if (form.hidden && navigationKeys.includes(event.code)) { event.preventDefault(); keys.add(event.code); }
});
document.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => { keys.clear(); mouseX = mouseY = 0; });
video.addEventListener('click', () => {
  void video.play().catch(() => {});
  if (form.hidden) video.requestPointerLock()?.catch(() => { status.textContent = 'Mouse lock unavailable'; });
});
document.addEventListener('mousemove', event => {
  if (document.pointerLockElement === video) {
    mouseX += event.movementX;
    mouseY += event.movementY;
  }
});
document.addEventListener('pointerlockchange', () => {
  keys.clear();
  mouseX = mouseY = 0;
});
window.addEventListener('pagehide', disconnect);

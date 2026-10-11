const video = document.getElementById('video');
const status = document.getElementById('connectionStatus');
const form = document.getElementById('login');
const diagnostics = document.getElementById('diagnostics');
const keys = new Set();
let socket;
let peer;
let mouseX = 0;
let mouseY = 0;
let wheel = 0;
let interval;
let generation = 0;
let mediaUrl;
const pausePanel = document.getElementById('pausePanel');
const wireframe = document.getElementById('wireframe');
const measureButton = document.getElementById('measure');
const measurementStatus = document.getElementById('measurementStatus');
let paused = true;
let measuring = false;
let lockRequested = false;
let measurementRequest = 0;
let picking = false;
let rendererReady = false;

function sendCommand(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function measurement(action, point = {}) {
  picking = action === 'pick';
  sendCommand({ type: 'measure', action, requestId: ++measurementRequest, ...point });
}
function pause() {
  paused = true;
  lockRequested = false;
  clearInput();
  sendCommand({ type: 'pause', paused: true });
  pausePanel.hidden = !form.hidden;
  if (document.pointerLockElement === video) document.exitPointerLock();
}
function resume() {
  if (!form.hidden || !rendererReady || socket?.readyState !== WebSocket.OPEN) return;
  if (measuring) measurement('cancel');
  measuring = false;
  measureButton.setAttribute('aria-pressed', 'false');
  measurementStatus.textContent = '';
  clearInput();
  lockRequested = true;
  void video.play().catch(() => {});
  try {
    video.requestPointerLock()?.catch(() => {
      pause();
      status.textContent = 'Mouse lock unavailable. Use Resume to try again.';
    });
  } catch {
    pause();
    status.textContent = 'Mouse lock unavailable. Use Resume to try again.';
  }
}

// The video is styled object-fit: contain with centered content.
function videoPoint(event) {
  const rect = video.getBoundingClientRect();
  if (!video.videoWidth || !video.videoHeight || !rect.width || !rect.height) return null;
  const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  const x = (event.clientX - rect.left - (rect.width - width) / 2) / width;
  const y = (event.clientY - rect.top - (rect.height - height) / 2) / height;
  return Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

function disconnect() {
  pause();
  generation++;
  rendererReady = false;
  measurementRequest++;
  measuring = picking = false;
  wireframe.checked = false;
  measureButton.setAttribute('aria-pressed', 'false');
  measurementStatus.textContent = '';
  pausePanel.hidden = true;
  clearInterval(interval);
  keys.clear();
  mouseX = mouseY = wheel = 0;
  peer?.close();
  socket?.close();
  video.srcObject = null;
  video.removeAttribute('src');
  if (mediaUrl) URL.revokeObjectURL(mediaUrl);
  mediaUrl = null;
  form.hidden = false;
  diagnostics.hidden = true;
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
    pausePanel.hidden = false;
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
        } else if (message.type === 'ready') {
          rendererReady = true;
          sendCommand({ type: 'pause', paused: true });
          sendCommand({ type: 'wireframe', enabled: wireframe.checked });
        } else if (message.type === 'measurement') {
          if (!measuring || message.requestId !== measurementRequest) return;
          picking = false;
          measurementStatus.textContent = message.status === 'complete'
            ? `Distance: ${message.distance.toPrecision(6)} model units. Click to start another measurement.`
            : message.status === 'no-hit' ? 'No model surface here. Try another point.'
            : message.status === 'second' ? 'Click the second model surface point.'
            : 'Click the first model surface point.';
        } else if (message.type === 'stats') {
          diagnostics.hidden = false;
          document.getElementById('fps').textContent = message.fps.toFixed(1);
          document.getElementById('renderTime').textContent = `${message.renderTime.toFixed(1)} ms`;
          document.getElementById('inputLatency').textContent = message.inputLatency === null
            ? 'No input yet' : `${message.inputLatency.toFixed(1)} ms`;
          document.getElementById('gpuVendor').textContent = message.gpu.vendor;
          document.getElementById('gpuRenderer').textContent = message.gpu.renderer;
          document.getElementById('performanceWarning').textContent = [
            message.fps < 20 ? 'Low FPS (<20)' : '',
            message.renderTime > 40 ? 'Slow render (>40 ms)' : '',
          ].filter(Boolean).join(' · ');
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
      if (paused || measuring || document.pointerLockElement !== video) return;
      const shift = keys.has('ShiftLeft') || keys.has('ShiftRight');
      send({
        type: 'input', forward: keys.has('ArrowUp') || keys.has('KeyW'),
        backward: keys.has('ArrowDown') || keys.has('KeyS'),
        left: keys.has('ArrowLeft') || keys.has('KeyA'),
        right: keys.has('ArrowRight') || keys.has('KeyD'),
        up: keys.has('KeyE'), down: keys.has('KeyQ'), boost: shift,
        x: mouseX, y: mouseY, wheel,
      });
      mouseX = mouseY = wheel = 0;
    }, 50);
  } catch (error) {
    if (attempt === generation) { disconnect(); status.textContent = error.message; }
  }
});
const navigationKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'];
document.addEventListener('keydown', event => {
  if (form.hidden && event.code === 'Escape') { pause(); return; }
  if (form.hidden && !paused && !measuring && document.pointerLockElement === video &&
      !event.repeat && navigationKeys.includes(event.code)) { event.preventDefault(); keys.add(event.code); }
});
document.addEventListener('keyup', event => keys.delete(event.code));
function clearInput() {
  keys.clear();
  mouseX = mouseY = wheel = 0;
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', reset: true }));
}
window.addEventListener('blur', pause);
video.addEventListener('wheel', event => {
  if (form.hidden && !paused && !measuring && document.pointerLockElement === video) {
    if (socket?.readyState !== WebSocket.OPEN) return;
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? video.clientHeight || 720 : 1;
    const delta = Number.isFinite(event.deltaY) ? Math.max(-500, Math.min(500, event.deltaY * unit)) : 0;
    wheel = Math.max(-500, Math.min(500, wheel + delta));
  }
}, { passive: false });
video.addEventListener('click', event => {
  void video.play().catch(() => {});
  if (measuring) {
    if (picking) return;
    const point = videoPoint(event);
    if (point) measurement('pick', point);
    else measurementStatus.textContent = 'Click inside the video image.';
  } else if (form.hidden && paused) resume();
});
document.addEventListener('mousemove', event => {
  if (!paused && !measuring && document.pointerLockElement === video) {
    mouseX += event.movementX;
    mouseY += event.movementY;
  }
});
document.addEventListener('pointerlockchange', () => {
  clearInput();
  if (document.pointerLockElement === video && lockRequested && !measuring && form.hidden) {
    lockRequested = false;
    paused = false;
    pausePanel.hidden = true;
    sendCommand({ type: 'pause', paused: false });
  } else {
    pause();
    if (form.hidden) document.getElementById('resume').focus();
  }
});
document.addEventListener('pointerlockerror', () => {
  pause();
  status.textContent = 'Mouse lock unavailable. Use Resume to try again.';
});
wireframe.addEventListener('change', () => sendCommand({ type: 'wireframe', enabled: wireframe.checked }));
measureButton.addEventListener('click', () => {
  if (!rendererReady) { measurementStatus.textContent = 'Wait for the model to finish loading.'; return; }
  pause();
  measuring = true;
  measureButton.setAttribute('aria-pressed', 'true');
  measurementStatus.textContent = 'Click the first model surface point.';
  measurement('start');
});
document.getElementById('clearMeasurement').addEventListener('click', () => {
  if (measuring) {
    measurement('clear');
    measurementStatus.textContent = 'Click the first model surface point.';
  }
});
document.getElementById('cancelMeasurement').addEventListener('click', () => {
  measurement('cancel');
  measuring = false;
  measureButton.setAttribute('aria-pressed', 'false');
  measurementStatus.textContent = '';
});
document.getElementById('resume').addEventListener('click', resume);
window.addEventListener('pagehide', disconnect);

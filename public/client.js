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
let sessionState = 'setup';
let readinessCleanup = () => {};
const toolbar = document.getElementById('toolbar');
const solidButton = document.getElementById('solid');
const wireframeButton = document.getElementById('wireframeTool');
const modelSelect = document.getElementById('model');
const startButton = document.getElementById('startViewing');
const setupPanel = document.getElementById('setupPanel');
const controlsHelp = document.getElementById('controlsHelp');
const hud = document.getElementById('hud');
const diagnosticsButton = document.getElementById('showDiagnostics');
let catalogAttempt = 0;

document.getElementById('loadModels').addEventListener('click', async () => {
  const attempt = ++catalogAttempt;
  const button = document.getElementById('loadModels');
  const modelStatus = document.getElementById('modelStatus');
  button.disabled = true;
  modelStatus.textContent = 'Loading available models…';
  try {
    const response = await fetch('/models', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value }),
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'Enter the correct password, then load models.' : 'Cannot discover models. Check the server configuration.');
    const catalog = await response.json();
    if (attempt !== catalogAttempt) return;
    modelSelect.replaceChildren(...catalog.models.map(model => new Option(model.name, model.id)));
    modelSelect.disabled = false;
    modelStatus.textContent = catalog.message || 'Select a model, then Start Viewing.';
  } catch (error) {
    if (attempt === catalogAttempt) modelStatus.textContent = error.message;
  } finally {
    if (attempt === catalogAttempt) button.disabled = false;
  }
});

function updateTools() {
  solidButton.setAttribute('aria-pressed', String(!wireframe.checked));
  wireframeButton.setAttribute('aria-pressed', String(wireframe.checked));
  measureButton.setAttribute('aria-pressed', String(measuring));
}
function setWireframe(enabled) {
  if (sessionState !== 'viewing') return;
  wireframe.checked = enabled;
  updateTools();
  sendCommand({ type: 'wireframe', enabled });
}

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
  pausePanel.hidden = sessionState !== 'viewing';
  if (document.pointerLockElement === video) document.exitPointerLock();
}
function resume() {
  if (sessionState !== 'viewing' || !rendererReady || socket?.readyState !== WebSocket.OPEN) return;
  if (measuring) measurement('cancel');
  measuring = false;
  measureButton.setAttribute('aria-pressed', 'false');
  measurementStatus.textContent = '';
  clearInput();
  lockRequested = true;
  const attempt = generation;
  void video.play().catch(() => {});
  try {
    video.requestPointerLock()?.catch(() => {
      if (attempt !== generation) return;
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
  sessionState = 'setup';
  readinessCleanup();
  readinessCleanup = () => {};
  pause();
  generation++;
  rendererReady = false;
  measurementRequest++;
  measuring = picking = false;
  wireframe.checked = false;
  updateTools();
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
  setupPanel.hidden = false;
  controlsHelp.hidden = false;
  toolbar.hidden = true;
  hud.classList.remove('viewing');
  startButton.disabled = false;
  diagnostics.hidden = true;
  diagnosticsButton.setAttribute('aria-pressed', 'false');
}
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (sessionState === 'connecting') return;
  disconnect();
  sessionState = 'connecting';
  startButton.disabled = true;
  const attempt = generation;
  const controller = new AbortController();
  const connectionTimeout = setTimeout(() => {
    if (attempt === generation && sessionState === 'connecting') {
      controller.abort();
      disconnect();
      status.textContent = 'Model stream timed out. Try Start Viewing again.';
    }
  }, 90000);
  readinessCleanup = () => { clearTimeout(connectionTimeout); controller.abort(); };
  status.textContent = 'Starting private renderer…';
  try {
    const response = await fetch('/session', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('password').value,
        ...(modelSelect.value ? { modelId: modelSelect.value } : {}) }),
    });
    if (!response.ok) throw new Error(response.status === 401 ? 'Incorrect password'
      : response.status === 400 ? 'Selected model is invalid or unavailable. Load available models again.'
      : 'Cannot create session (server capacity or access denied)');
    const config = await response.json();
    if (attempt !== generation) return;
    peer = new RTCPeerConnection({ iceServers: config.iceServers });
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signal`);
    const currentPeer = peer;
    const currentSocket = socket;
    currentSocket.binaryType = 'arraybuffer';
    const send = message => {
      if (attempt === generation && currentSocket.readyState === WebSocket.OPEN) currentSocket.send(JSON.stringify(message));
    };
    const pendingIce = [];
    let chain = Promise.resolve();
    let sourceBuffer;
    let mediaSource;
    let fallback = false;
    const chunks = [];
    let frameSeen = false;
    let frameCallback;
    let playbackEpoch = 0;
    function connected() {
      if (attempt !== generation || sessionState !== 'connecting' || !rendererReady ||
          !frameSeen || video.paused || video.readyState < 2 || !video.videoWidth) return;
      sessionState = 'viewing';
      form.hidden = setupPanel.hidden = controlsHelp.hidden = true;
      pausePanel.hidden = diagnostics.hidden = true;
      toolbar.hidden = false;
      hud.classList.add('viewing');
      status.textContent = 'Click video to navigate · ESC for options';
      readinessCleanup();
      startButton.disabled = false;
    }
    function playing() {
      if (attempt !== generation) return;
      const epoch = playbackEpoch;
      if (!video.requestVideoFrameCallback) { frameSeen = true; connected(); }
      else {
        if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback);
        frameCallback = video.requestVideoFrameCallback(() => {
          if (attempt !== generation || epoch !== playbackEpoch) return;
          frameSeen = true;
          connected();
        });
      }
    }
    video.addEventListener('playing', playing);
    readinessCleanup = () => {
      clearTimeout(connectionTimeout);
      video.removeEventListener('playing', playing);
      if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback);
    };
    function appendChunk() {
      if (attempt !== generation || !sourceBuffer || sourceBuffer.updating || !chunks.length) return;
      // Keep at most 20 seconds of decoded history.
      if (sourceBuffer.buffered.length && video.currentTime > 25 &&
          sourceBuffer.buffered.start(0) < video.currentTime - 20) {
        sourceBuffer.remove(sourceBuffer.buffered.start(0), video.currentTime - 20);
        return;
      }
      sourceBuffer.appendBuffer(chunks.shift());
    }
    currentPeer.ontrack = event => {
      if (attempt !== generation || fallback) return;
      video.srcObject = event.streams[0];
      void video.play().catch(() => { if (attempt === generation) status.textContent = 'Click video to play'; });
    };
    currentPeer.onicecandidate = event => {
      if (attempt !== generation || fallback) return;
      if (event.candidate) send({ type: 'ice', candidate: event.candidate.toJSON() });
    };
    currentPeer.onconnectionstatechange = () => {
      if (attempt !== generation || fallback) return;
      if (['failed', 'disconnected', 'closed'].includes(currentPeer.connectionState)) {
        // The renderer can switch a failed WebRTC attempt to WebM while connecting.
        if (sessionState === 'viewing') {
          disconnect();
          status.textContent = 'Video disconnected. Start a new session.';
          return;
        }
      }
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
          playbackEpoch++;
          if (frameCallback !== undefined) video.cancelVideoFrameCallback?.(frameCallback);
          frameSeen = false;
          currentPeer.onicecandidate = null;
          currentPeer.close();
          video.srcObject = null;
          mediaSource = new MediaSource();
          mediaUrl = URL.createObjectURL(mediaSource);
          video.src = mediaUrl;
          mediaSource.addEventListener('sourceopen', () => {
            if (attempt !== generation) return;
            try {
              sourceBuffer = mediaSource.addSourceBuffer(message.mimeType);
              sourceBuffer.addEventListener('updateend', () => {
                try { appendChunk(); } catch (error) {
                  if (attempt === generation) { disconnect(); status.textContent = error.message; }
                }
              });
              sourceBuffer.addEventListener('error', () => {
                if (attempt === generation) { disconnect(); status.textContent = 'Video decoding failed. Start a new session.'; }
              });
              appendChunk();
            } catch (error) {
              if (attempt === generation) { disconnect(); status.textContent = error.message; }
            }
          }, { once: true });
          status.textContent = 'Video: WebSocket fallback';
          void video.play().catch(() => { if (attempt === generation) status.textContent = 'Click video to play'; });
        } else if (message.type === 'ready') {
          rendererReady = true;
          sendCommand({ type: 'pause', paused: true });
          sendCommand({ type: 'wireframe', enabled: wireframe.checked });
          connected();
        } else if (message.type === 'measurement') {
          if (!measuring || message.requestId !== measurementRequest) return;
          picking = false;
          measurementStatus.textContent = message.status === 'complete'
            ? `Distance: ${message.distance.toPrecision(6)} model units. Click to start another measurement.`
            : message.status === 'no-hit' ? 'No model surface here. Try another point.'
            : message.status === 'second' ? 'Click the second model surface point.'
            : 'Click the first model surface point.';
        } else if (message.type === 'stats') {
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
    currentSocket.onerror = () => {
      if (attempt === generation) { disconnect(); status.textContent = 'Signaling connection failed. Try again.'; }
    };
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
  if (sessionState === 'viewing' && event.code === 'Escape') { pause(); return; }
  if (sessionState === 'viewing' && !paused && !measuring && document.pointerLockElement === video &&
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
  if (sessionState === 'viewing' && !paused && !measuring && document.pointerLockElement === video) {
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
  } else if (sessionState === 'viewing' && paused) resume();
});
document.addEventListener('mousemove', event => {
  if (!paused && !measuring && document.pointerLockElement === video) {
    mouseX += event.movementX;
    mouseY += event.movementY;
  }
});
document.addEventListener('pointerlockchange', () => {
  clearInput();
  if (document.pointerLockElement === video && lockRequested && !measuring && sessionState === 'viewing') {
    lockRequested = false;
    paused = false;
    pausePanel.hidden = true;
    sendCommand({ type: 'pause', paused: false });
  } else {
    pause();
    if (sessionState === 'viewing') document.getElementById('resume').focus();
  }
});
document.addEventListener('pointerlockerror', () => {
  pause();
  status.textContent = 'Mouse lock unavailable. Use Resume to try again.';
});
solidButton.addEventListener('click', () => setWireframe(false));
wireframeButton.addEventListener('click', () => setWireframe(true));
wireframe.addEventListener('change', () => setWireframe(wireframe.checked));
diagnosticsButton.addEventListener('click', () => {
  diagnostics.hidden = !diagnostics.hidden;
  diagnosticsButton.setAttribute('aria-pressed', String(!diagnostics.hidden));
});
measureButton.addEventListener('click', () => {
  if (sessionState !== 'viewing' || !rendererReady) { measurementStatus.textContent = 'Wait for the model to finish loading.'; return; }
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
video.addEventListener('error', () => {
  if (sessionState !== 'setup' && video.error) {
    disconnect();
    status.textContent = 'Video playback failed. Start a new session.';
  }
});

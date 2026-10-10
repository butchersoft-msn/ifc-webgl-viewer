// Client-side WebRTC streaming viewer

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const userIdElement = document.getElementById('userId');
const fpsElement = document.getElementById('fps');
const latencyElement = document.getElementById('latency');
const statusElement = document.getElementById('connectionStatus');

// Resize canvas to fill window
function resizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
}
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

// Input tracking
const keys = {};
let mouseDelta = { x: 0, y: 0 };
let pointerLocked = false;

// FPS tracking
let frameCount = 0;
let lastFrameTime = Date.now();
let fps = 0;
let lastSendTime = Date.now();
let latency = 0;

// Connect to WebSocket
const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const wsUrl = `${protocol}//localhost:8080`;
const ws = new WebSocket(wsUrl);

ws.onopen = () => {
  console.log('Connected to server');
  statusElement.textContent = '● Connected';
  statusElement.className = 'status-connected';
};

ws.onmessage = (event) => {
  const data = event.data;
  
  // Check if it's a JSON message (init) or image data
  if (data.startsWith('{')) {
    try {
      const message = JSON.parse(data);
      if (message.type === 'init') {
        userIdElement.textContent = message.userId;
        console.log(`User ID: ${message.userId}, Active users: ${message.activeUsers}`);
      }
    } catch (e) {
      console.error('Error parsing JSON message:', e);
    }
  } else if (data.startsWith('data:image')) {
    // Render frame
    const img = new Image();
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      frameCount++;
      
      // Calculate latency (round trip time)
      latency = Math.round(Date.now() - lastSendTime);
      latencyElement.textContent = latency;
      
      // Draw crosshair
      drawCrosshair();
    };
    img.onerror = () => {
      console.warn('Failed to load image frame');
    };
    img.src = data;
  }
};

ws.onerror = (error) => {
  console.error('WebSocket error:', error);
  statusElement.textContent = '● Error';
  statusElement.className = 'status-disconnected';
};

ws.onclose = () => {
  console.log('Disconnected from server');
  statusElement.textContent = '● Disconnected';
  statusElement.className = 'status-disconnected';
};

// Draw crosshair in center
function drawCrosshair() {
  const centerX = canvas.width / 2;
  const centerY = canvas.height / 2;
  const size = 10;
  
  ctx.strokeStyle = 'rgba(0, 255, 0, 0.5)';
  ctx.lineWidth = 2;
  
  // Vertical line
  ctx.beginPath();
  ctx.moveTo(centerX, centerY - size);
  ctx.lineTo(centerX, centerY + size);
  ctx.stroke();
  
  // Horizontal line
  ctx.beginPath();
  ctx.moveTo(centerX - size, centerY);
  ctx.lineTo(centerX + size, centerY);
  ctx.stroke();
  
  // Circle
  ctx.beginPath();
  ctx.arc(centerX, centerY, size, 0, Math.PI * 2);
  ctx.stroke();
}

// Keyboard input
document.addEventListener('keydown', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'arrowup' || key === 'w') keys.forward = true;
  if (key === 'arrowdown' || key === 's') keys.backward = true;
  if (key === 'arrowleft' || key === 'a') keys.left = true;
  if (key === 'arrowright' || key === 'd') keys.right = true;
  if (key === 'escape') {
    document.exitPointerLock = document.exitPointerLock || document.mozExitPointerLock;
    document.exitPointerLock();
  }
});

document.addEventListener('keyup', (e) => {
  const key = e.key.toLowerCase();
  if (key === 'arrowup' || key === 'w') keys.forward = false;
  if (key === 'arrowdown' || key === 's') keys.backward = false;
  if (key === 'arrowleft' || key === 'a') keys.left = false;
  if (key === 'arrowright' || key === 'd') keys.right = false;
});

// Request pointer lock for mouse look
canvas.addEventListener('click', () => {
  canvas.requestPointerLock = canvas.requestPointerLock || canvas.mozRequestPointerLock;
  canvas.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  pointerLocked = document.pointerLockElement === canvas;
  console.log(`Pointer lock: ${pointerLocked}`);
});

// Mouse movement
document.addEventListener('mousemove', (e) => {
  if (pointerLocked) {
    mouseDelta.x = e.movementX;
    mouseDelta.y = e.movementY;
  }
});

// Send input to server
setInterval(() => {
  if (ws.readyState === WebSocket.OPEN) {
    lastSendTime = Date.now();
    ws.send(JSON.stringify({
      forward: keys.forward || false,
      backward: keys.backward || false,
      left: keys.left || false,
      right: keys.right || false,
      mouseDelta: { x: mouseDelta.x, y: mouseDelta.y }
    }));
    mouseDelta = { x: 0, y: 0 };
  }
}, 33); // ~30 FPS input rate

// Update FPS counter
setInterval(() => {
  const now = Date.now();
  const elapsed = (now - lastFrameTime) / 1000;
  fps = Math.round(frameCount / elapsed);
  fpsElement.textContent = fps;
  frameCount = 0;
  lastFrameTime = now;
}, 1000);

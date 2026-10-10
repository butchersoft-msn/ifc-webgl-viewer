const express = require('express');
const path = require('path');
const WebSocket = require('ws');
const THREE = require('three');
const fs = require('fs');
const { createCanvas } = require('canvas');

const app = express();
const HTTP_PORT = 3000;
const WS_PORT = 8080;

// Serve static files (HTML, CSS, JS)
app.use(express.static(path.join(__dirname, 'public')));

// Setup Three.js scene
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1920 / 1080, 0.1, 10000);
camera.position.set(0, 10, 30);

// Create canvas for rendering
const canvas = createCanvas(1920, 1080);
const renderer = new THREE.WebGLRenderer({ 
  canvas,
  antialias: true,
  precision: 'highp',
  alpha: false
});
renderer.setPixelRatio(1);
renderer.setSize(1920, 1080);
renderer.setClearColor(0x87ceeb, 1);

// Lighting
const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
scene.add(ambientLight);

const directionalLight = new THREE.DirectionalLight(0xffffff, 0.8);
directionalLight.position.set(100, 100, 100);
directionalLight.castShadow = true;
scene.add(directionalLight);

// Load sample model or placeholder
function loadSampleModel() {
  // Create a simple cube as placeholder
  const geometry = new THREE.BoxGeometry(10, 10, 10);
  const material = new THREE.MeshPhongMaterial({ 
    color: 0x00ff00,
    side: THREE.DoubleSide
  });
  const cube = new THREE.Mesh(geometry, material);
  scene.add(cube);
  
  // Add a grid helper
  const gridHelper = new THREE.GridHelper(100, 10);
  scene.add(gridHelper);
  
  console.log('Loaded sample model (green cube)');
}

// Load IFC model if file exists
function loadIFCModel(filePath) {
  if (fs.existsSync(filePath)) {
    console.log('IFC file detected. In production, use web-ifc-three loader.');
    console.log('For now, using sample placeholder model.');
  }
  loadSampleModel();
}

// Initialize model
loadIFCModel('./public/model.ifc');

// Track active sessions
const activeSessions = new Map();

// WebSocket server for streaming
const wss = new WebSocket.Server({ port: WS_PORT });

wss.on('connection', (ws) => {
  const userId = Math.random().toString(36).substr(2, 9);
  
  const session = {
    userId,
    position: new THREE.Vector3(0, 10, 30),
    rotation: new THREE.Euler(0, 0, 0),
    speed: 0.5,
    camera: camera.clone()
  };
  
  activeSessions.set(userId, session);
  
  console.log(`[${new Date().toLocaleTimeString()}] User ${userId} connected. Active users: ${activeSessions.size}`);
  
  // Send initial state
  ws.send(JSON.stringify({
    type: 'init',
    userId,
    activeUsers: activeSessions.size
  }));
  
  // Render loop for this user
  let frameCount = 0;
  const renderInterval = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN || !activeSessions.has(userId)) {
      clearInterval(renderInterval);
      return;
    }
    
    try {
      // Update camera from session state
      camera.position.copy(session.position);
      camera.rotation.copy(session.rotation);
      
      // Render scene
      renderer.render(scene, camera);
      
      // Capture frame as JPEG
      const imageData = canvas.toDataURL('image/jpeg', 0.8);
      
      // Send to client
      ws.send(imageData);
      
      frameCount++;
    } catch (error) {
      console.error(`Error rendering frame for user ${userId}:`, error.message);
    }
  }, 33); // ~30 FPS
  
  // Handle input from client
  ws.on('message', (data) => {
    try {
      const input = JSON.parse(data);
      
      if (!activeSessions.has(userId)) return;
      
      const session = activeSessions.get(userId);
      
      // Handle movement (WASD / Arrow keys)
      const moveVector = new THREE.Vector3();
      if (input.forward) moveVector.z -= session.speed;
      if (input.backward) moveVector.z += session.speed;
      if (input.left) moveVector.x -= session.speed;
      if (input.right) moveVector.x += session.speed;
      
      // Apply camera rotation to movement vector
      if (moveVector.length() > 0) {
        moveVector.applyAxisAngle(new THREE.Vector3(0, 1, 0), session.rotation.y);
        session.position.add(moveVector);
      }
      
      // Handle camera rotation (mouse look)
      if (input.mouseDelta && input.mouseDelta.x !== 0 || input.mouseDelta.y !== 0) {
        session.rotation.y += input.mouseDelta.x * 0.005;
        session.rotation.x += input.mouseDelta.y * 0.005;
        
        // Clamp vertical rotation
        session.rotation.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, session.rotation.x));
      }
    } catch (error) {
      console.error(`Error processing input for user ${userId}:`, error.message);
    }
  });
  
  // Handle disconnect
  ws.on('close', () => {
    activeSessions.delete(userId);
    console.log(`[${new Date().toLocaleTimeString()}] User ${userId} disconnected. Active users: ${activeSessions.size}`);
  });
  
  ws.on('error', (error) => {
    console.error(`WebSocket error for user ${userId}:`, error.message);
  });
});

// HTTP server
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(HTTP_PORT, () => {
  console.log(`\n========================================`);
  console.log(`IFC WebGL Viewer - Local Prototype`);
  console.log(`========================================`);
  console.log(`HTTP Server running on http://localhost:${HTTP_PORT}`);
  console.log(`WebSocket Server running on ws://localhost:${WS_PORT}`);
  console.log(`\nOpen your browser to http://localhost:${HTTP_PORT}`);
  console.log(`\nControls:`);
  console.log(`  Arrow Keys or WASD - Move`);
  console.log(`  Mouse - Look around (click canvas first)`);
  console.log(`  ESC - Exit mouse lock`);
  console.log(`========================================\n`);
});

wss.on('error', (error) => {
  console.error('WebSocket server error:', error.message);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  wss.clients.forEach((ws) => ws.close());
  process.exit(0);
});

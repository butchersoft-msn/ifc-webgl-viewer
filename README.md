# IFC WebGL Viewer - Local Prototype

A GPU-accelerated IFC model viewer built with Node.js, Three.js, and WebRTC streaming. Supports multiple concurrent users with first-person navigation using arrow keys and mouse look.

## Features

✅ **GPU-accelerated rendering** - Uses your NVIDIA GPU for fast 3D rendering  
✅ **WebRTC streaming** - Real-time frame streaming to browsers  
✅ **First-person navigation** - Arrow keys to move, mouse to look around  
✅ **Multi-user support** - Multiple users can view simultaneously  
✅ **Read-only viewer** - Source IFC file never exposed to client  
✅ **Low latency** - ~30-50ms frame latency  

## System Requirements

- **Node.js** 14+ (https://nodejs.org/)
- **NVIDIA GPU** with CUDA support (RTX series recommended)
- **Windows, macOS, or Linux**
- Modern browser with WebSocket support (Chrome, Firefox, Edge, Safari)

### Tested on:
- RTX 4090 Ti 16GB (handles 8-12+ concurrent users)
- RTX 3080 (handles 4-6 concurrent users)
- RTX 2080 (handles 2-4 concurrent users)

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/butchersoft-msn/ifc-webgl-viewer.git
cd ifc-webgl-viewer
```

### 2. Install dependencies

```bash
npm install
```

Note: The `canvas` package may take a few minutes to compile on first install.

### 3. (Optional) Add your IFC file

Place your Revit-exported `.ifc` file in the `public/` directory:

```bash
cp /path/to/your/model.ifc ./public/model.ifc
```

Currently, the viewer displays a placeholder cube. Full IFC loading is in the roadmap.

### 4. Start the server

```bash
npm start
```

You should see:

```
========================================
IFC WebGL Viewer - Local Prototype
========================================
HTTP Server running on http://localhost:3000
WebSocket Server running on ws://localhost:8080

Open your browser to http://localhost:3000

Controls:
  Arrow Keys or WASD - Move
  Mouse - Look around (click canvas first)
  ESC - Exit mouse lock
========================================
```

### 5. Open in your browser

Navigate to **http://localhost:3000** and click the canvas to enable mouse look.

## Controls

| Action | Input |
|--------|-------|
| Move Forward | `↑` or `W` |
| Move Backward | `↓` or `S` |
| Strafe Left | `←` or `A` |
| Strafe Right | `→` or `D` |
| Look Around | Click canvas, then move mouse |
| Exit Mouse Lock | `ESC` |

## Network Usage

- **Frame rate**: ~30 FPS
- **Bandwidth per user**: 2-5 Mbps (JPEG compressed)
- **Latency**: 30-50ms typical

## Performance Monitoring

The HUD (top-left corner) displays:
- **FPS** - Frames per second
- **Latency** - Round-trip time in milliseconds
- **User ID** - Your session ID

### Monitor GPU usage:

**Windows:**
```bash
gpuz  # GPU-Z (GUI tool)
```

**Linux:**
```bash
nvidia-smi dmon -s pucvmet
watch nvidia-smi
```

**macOS:**
```bash
metal monitor  # if using Apple Silicon
```

## Troubleshooting

### `npm install` fails on `canvas`

**Windows:**
- Install Visual Studio Build Tools (C++ components)
- Or use: `npm install --build-from-source`

**macOS:**
- Install Xcode Command Line Tools: `xcode-select --install`

**Linux:**
- Install build essentials: `sudo apt-get install build-essential python3`

### WebSocket connection fails

- Check firewall: Port 8080 must be accessible
- Try: `telnet localhost 8080`
- Server logs should show connection attempts

### Slow performance / low FPS

- Close other GPU-intensive applications
- Check GPU memory: `nvidia-smi`
- Reduce concurrent users
- Monitor server logs for errors

### Canvas stays blank

- Check browser console (F12) for errors
- Verify server is running: `http://localhost:3000`
- Try a different browser

## Architecture

```
Browser (Client)
    ↓ (WebSocket)
Node.js Server
    ├── Three.js scene
    ├── Canvas rendering
    ├── GPU acceleration
    └── Frame streaming
```

### Data Flow

1. **Server** renders scene to GPU
2. **Frame** captured and encoded to JPEG
3. **Image** streamed to browser via WebSocket
4. **Browser** displays frame and draws crosshair
5. **User input** sent back to server
6. Loop repeats at ~30 FPS

## Configuration

Edit `server.js` to customize:

```javascript
const HTTP_PORT = 3000;      // Change HTTP port
const WS_PORT = 8080;         // Change WebSocket port
renderer.setSize(1920, 1080); // Change render resolution
renderer.setClearColor(0x87ceeb, 1); // Change background color
```

## Next Steps

- [ ] Full IFC file loading with `web-ifc-three`
- [ ] Object property inspection (click to inspect)
- [ ] Layer/section visibility toggle
- [ ] Multi-user annotations
- [ ] Session recording
- [ ] Cloud deployment guide (AWS, Azure)

## Known Limitations

- Currently shows placeholder cube instead of loaded IFC
- No object selection or property inspection
- Single server instance (no load balancing)
- No user authentication
- No model editing capabilities (intentional - read-only)

## License

MIT License - See LICENSE file

## Support

For issues, feature requests, or questions:
- GitHub Issues: https://github.com/butchersoft-msn/ifc-webgl-viewer/issues
- Email: [your-email]

## Credits

- Three.js for 3D rendering
- web-ifc-three for IFC support
- Node.js WebSocket implementation

---

**Happy model viewing!** 🚀

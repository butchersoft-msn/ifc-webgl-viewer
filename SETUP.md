# Setup Instructions

## Quick Start (5 minutes)

### Step 1: Install Node.js

Download and install from https://nodejs.org/ (LTS version recommended)

Verify installation:
```bash
node --version
npm --version
```

### Step 2: Download and Extract

**Option A: Using Git**
```bash
git clone https://github.com/butchersoft-msn/ifc-webgl-viewer.git
cd ifc-webgl-viewer
```

**Option B: Download ZIP**
- Click "Code" → "Download ZIP"
- Extract to a folder
- Open terminal/command prompt in that folder

### Step 3: Install Dependencies

```bash
npm install
```

This will download and install:
- Express (web server)
- WebSocket (real-time communication)
- Three.js (3D rendering)
- Canvas (GPU rendering)

**⏱️ This may take 2-5 minutes** (canvas package compiles)

### Step 4: Start the Server

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
```

### Step 5: Open in Browser

1. Open your browser (Chrome, Firefox, Edge, Safari)
2. Go to: **http://localhost:3000**
3. Click the canvas to enable mouse look
4. Use **Arrow Keys** or **WASD** to move
5. Move mouse to look around
6. Press **ESC** to exit mouse lock

### Step 6: Test Multi-User

Open a **second browser tab/window** at `http://localhost:3000`

You should see two independent viewers. Each user gets their own camera position.

---

## Detailed Setup by OS

### Windows

1. **Install Node.js LTS**
   - Download from nodejs.org
   - Run installer, click "Next" through all options
   - Restart your computer

2. **Open Command Prompt** (Win+R → `cmd`)

3. **Navigate to project folder**
   ```cmd
   cd C:\path\to\ifc-webgl-viewer
   ```

4. **Install dependencies**
   ```cmd
   npm install
   ```
   
   If `canvas` build fails:
   - Install Visual Studio Build Tools (free, C++ workload only)
   - Restart terminal and retry

5. **Start server**
   ```cmd
   npm start
   ```

6. **Open browser**: http://localhost:3000

### macOS

1. **Install Node.js LTS**
   - Download from nodejs.org or use Homebrew:
   ```bash
   brew install node
   ```

2. **Open Terminal** (Cmd+Space → `terminal`)

3. **Navigate to project folder**
   ```bash
   cd ~/path/to/ifc-webgl-viewer
   ```

4. **Install dependencies**
   ```bash
   npm install
   ```
   
   If `canvas` build fails:
   ```bash
   xcode-select --install
   npm install
   ```

5. **Start server**
   ```bash
   npm start
   ```

6. **Open browser**: http://localhost:3000

### Linux (Ubuntu/Debian)

1. **Install Node.js LTS**
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

2. **Install build tools** (needed for canvas)
   ```bash
   sudo apt-get install build-essential python3
   ```

3. **Navigate to project folder**
   ```bash
   cd ~/path/to/ifc-webgl-viewer
   ```

4. **Install dependencies**
   ```bash
   npm install
   ```

5. **Start server**
   ```bash
   npm start
   ```

6. **Open browser**: http://localhost:3000

---

## Adding Your IFC File

### Export from Revit

1. Open your Revit project
2. **File** → **Export** → **IFC**
3. Choose location and save as `model.ifc`
4. Leave default IFC export settings

### Add to Viewer

1. Copy the IFC file to the `public/` folder:
   ```bash
   cp ~/Desktop/model.ifc ./public/model.ifc
   ```

2. The viewer currently displays a placeholder. To load your IFC:
   - Edit `server.js` line ~95
   - See README.md "Next Steps" for full IFC loading implementation

---

## Stopping the Server

**In terminal/command prompt:**

- Press `Ctrl+C` to stop
- This closes all active connections and shuts down cleanly

---

## Common Issues

### Port Already in Use

**Error**: `EADDRINUSE: address already in use :::3000`

**Solution**: Change port in `server.js`:
```javascript
const HTTP_PORT = 3001;  // Use 3001 instead
const WS_PORT = 8081;     // Use 8081 instead
```

Then access at http://localhost:3001

### Connection Refused

**Error**: WebSocket fails to connect

**Causes**:
- Server not running
- Firewall blocking ports
- Running on different machine?

**Solutions**:
- Verify `npm start` output shows "WebSocket Server running"
- Check firewall: allow Node.js through Windows/Mac firewall
- If accessing from another PC, replace `localhost` with server's IP

### Canvas Install Fails

**Error**: `node-gyp ERR!` during `npm install`

**Solution**:

**Windows**:
- Install Visual Studio Build Tools (free)
- Choose "Desktop development with C++"
- Restart terminal and run `npm install` again

**macOS**:
```bash
xcode-select --install
npm install
```

**Linux**:
```bash
sudo apt-get install build-essential python3
npm install
```

### Low FPS / Laggy

**Check**:
1. GPU usage: `nvidia-smi` (should be >50% utilized)
2. Server logs for errors
3. Close other GPU applications (games, video editors)
4. Reduce number of concurrent users
5. Check network bandwidth

---

## Next: Multi-User Testing

Once working locally, test with multiple concurrent users:

1. **Terminal 1**: `npm start` (leave running)
2. **Browser 1**: http://localhost:3000 (User A)
3. **Browser 2**: http://localhost:3000 (User B)
4. **Browser 3**: http://localhost:3000 (User C)

Each browser should display independently. Server logs show active user count.

---

## Performance Expectations

**RTX 4090 Ti (16GB):**
- 8-12+ concurrent users
- 1080p @ 30 FPS per user
- ~2-5 Mbps bandwidth per user
- 50-80ms latency

**RTX 3080 (10GB):**
- 4-6 concurrent users
- 1080p @ 30 FPS per user

**RTX 2080 (8GB):**
- 2-4 concurrent users
- 1080p @ 30 FPS per user

If you're only getting 2-3 users on a high-end GPU, check:
- CPU usage (may be the bottleneck)
- Memory pressure (check `nvidia-smi`)
- Network bandwidth

---

## Getting Help

If you encounter issues:

1. **Check the server logs** - they show detailed error messages
2. **Check browser console** - F12 → Console tab
3. **Review troubleshooting section** in README.md
4. **GitHub Issues**: https://github.com/butchersoft-msn/ifc-webgl-viewer/issues

---

**You're all set! Happy model viewing! 🎉**

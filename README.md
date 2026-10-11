# IFC WebGL Viewer — streaming prototype

Render private model geometry on the server and stream video to a browser with first-person input. This is a prototype, not a production service or DRM system.

## Architecture

- Express serves the client and same-origin WebSocket signaling on one HTTP port.
- Puppeteer runs Chromium with Three.js **on the server only**. Private renderer URLs use an intercepted loopback origin. Puppeteer fulfills these virtual requests inside server Chromium; no HTTP endpoint actually serves the models.
- `canvas.captureStream()` feeds the preferred WebRTC transport, with video encoding handled by Chromium. If WebRTC has not connected after **5 seconds**, video automatically falls back to the authenticated same-origin WebSocket: Chromium `MediaRecorder` encodes the server canvas as WebM, and the client's built-in `MediaSource` displays it in a video element.
- Fallback requires browser support for `MediaSource` with `video/webm` VP8; it is not universal. Neither transport uses base64 JPEG. The client displays video and sends input; it does not receive geometry, IFC, GLB, or the Three.js scene.
- Sessions are non-shareable, use an HttpOnly cookie, allow one WebSocket per session, and expire after one hour. Use separate browser profiles/private contexts for independent viewers, not tabs sharing a cookie.

## Quick start

Requires **Node.js >=22.12** and Chromium's runtime dependencies. See [SETUP.md](SETUP.md) for Windows instructions and deployment.

```sh
npm install
npm start
```

Open **http://127.0.0.1:3000**. With no `MODEL_PATH`, the viewer renders a demo scene. Use WASD or arrow keys to move; click the video for mouse look, and press Escape to release pointer lock.

`npm run dev` uses built-in `node --watch` (no nodemon). `npm test` runs the available Node built-in integration tests.

## Private models

Keep both source IFC and converted GLB **outside `public/`**. Convert offline using the pure `web-ifc` WebAssembly converter:

```powershell
npm run convert -- "C:\private\model.ifc" "C:\private\model.glb"
$env:MODEL_PATH = "C:\private\model.glb"
npm start
```

`MODEL_PATH` must point to a self-contained `.glb` without external asset dependencies. There is no runtime model-download route. The converter exports geometry only: BIM metadata and complete material fidelity are not preserved. Huge models can exceed conversion/rendering memory limits.

The converter creates output GLB files exclusively and refuses to overwrite an existing file. Deliberately delete the old output before reconversion, or choose a new output path.

## Configuration

Set environment variables before starting:

| Variable | Purpose / default |
| --- | --- |
| `HOST` | Bind address; default `127.0.0.1`. |
| `PORT` | HTTP and same-origin WebSocket port; default `3000`. |
| `MAX_SESSIONS` | Concurrent session limit; default `4`, not a performance guarantee. |
| `MODEL_PATH` | Private self-contained GLB path; unset selects the demo. |
| `VIEWER_PASSWORD` | Optional shared login password, submitted as `password` to `POST /session`. |
| `APP_ORIGIN` | Externally visible origin; required when `HOST` is not loopback. |
| `ICE_SERVERS` | JSON array of `RTCIceServer` objects for STUN/TURN. |
| `CHROME_EXECUTABLE_PATH` | Optional Chromium executable override. |
| `CHROME_SOFTWARE_RENDERING` | Set to `1` to explicitly use the SwiftShader fallback. |

For external access, use an HTTPS reverse proxy with WebSocket upgrade support and set `APP_ORIGIN` to its public HTTPS origin. Preferred WebRTC media needs UDP connectivity or appropriate TURN relay service; the proxy does not relay WebRTC media. Supported browsers can instead use the automatic WebM fallback over that WebSocket.

A public/non-loopback `APP_ORIGIN` requires HTTPS and `VIEWER_PASSWORD`, even when backend `HOST` is loopback. Express rate limits all HTTP requests to 120/minute/IP and `POST /session` to 10/minute/IP. Behind a reverse proxy, the default limiter sees the proxy IP, so users share its quota. Do not blindly change `trust proxy`; proxy trust and rate limiting need production review.

## Limits and verification

Each viewer incurs server rendering, encoding, memory, and bandwidth costs. GPU acceleration is environment-dependent; no NVIDIA/NVENC encoding, hardware capacity, latency, or frame-rate guarantee is made. SwiftShader is a software fallback, not GPU acceleration. Keep Chromium's sandbox enabled.

Private model files are not delivered to clients, but visible pixels can be captured: this is **not DRM**. A shared password is not per-user account management.

Linux Node 22 integration passed with sandbox-enabled software rendering, IFC conversion, decoded fallback video, navigation, session isolation, and private-route checks. `npm audit` reported zero vulnerabilities. The direct WebRTC path could not be validated because the runner returned no usable ICE candidates. Hardware GPU and Windows execution remain pending; follow the Windows checklist in [SETUP.md](SETUP.md).

Windows CI is `action_required`, awaiting maintainer approval; no Windows jobs have executed.

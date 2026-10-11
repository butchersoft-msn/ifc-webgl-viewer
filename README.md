# IFC WebGL Viewer — streaming prototype

Render private model geometry on the server and stream video to a browser with first-person input. This is a prototype, not a production service or DRM system.

## Architecture

- Express serves the client and same-origin WebSocket signaling on one HTTP port.
- Puppeteer runs Chromium with Three.js **on the server only**. Renderer modules use an intercepted loopback origin. GLB downloads use normal HTTP at `/private-model`, restricted to loopback peers and a random per-session renderer token that is revoked when the session ends. Model bytes never pass through the DevTools control channel.
- `canvas.captureStream()` feeds the preferred WebRTC transport, with video encoding handled by Chromium. If WebRTC has not connected after **5 seconds**, video automatically falls back to the authenticated same-origin WebSocket: Chromium `MediaRecorder` encodes the server canvas as WebM, and the client's built-in `MediaSource` displays it in a video element.
- Fallback requires browser support for `MediaSource` with `video/webm` VP8; it is not universal. Neither transport uses base64 JPEG. The client displays video and sends input; it does not receive geometry, IFC, GLB, or the Three.js scene.
- Sessions are non-shareable, use an HttpOnly cookie, allow one WebSocket per session, and expire after one hour. Use separate browser profiles/private contexts for independent viewers, not tabs sharing a cookie.

## Quick start

Requires **Node.js >=22.12** and Chromium's runtime dependencies. See [SETUP.md](SETUP.md) for Windows instructions and deployment.

```sh
npm install
npm start
```

Open **http://127.0.0.1:3000**. With no `MODEL_PATH`, the viewer renders a demo scene. Click **Resume navigation** (or the video) to enable mouse look and WASD/arrow movement. Escape releases pointer lock, stops navigation, and opens the options panel. Blur and lost pointer lock also pause; held keys do not restart movement until released and pressed again.

Models and the demo cube start in a closer, perspective-aware view that fits their full bounds with a small margin. Navigation speed scales with model size. Hold Shift while moving with arrows or WASD (or vertically) to smoothly ramp from normal speed to an 8× cap over 3.5 seconds; releasing Shift or stopping resets the boost. Q moves down and E moves up, replacing the old Shift+arrow vertical controls.

Scroll up over the video to approach and down to retreat along the viewing direction while navigation is active. Mouse wheels and trackpads are supported, with bounded sensitivity and Shift boost. Input is batched every 33 ms with at most one input RPC in flight; keyboard state is replaced by the latest state and mouse/wheel deltas are accumulated within bounded limits and consumed once. Pause discards pending movement and invalidates late input RPCs. Blur, lost mouse lock, disconnect, and new sessions clear navigation state; stale input stops movement and resets acceleration after 250 ms.

### Paused-viewer options

- **Wireframe model** toggles only model mesh materials, including the demo cube; disabling restores the original solid appearance. Grids and measurement helpers are unchanged.
- **Measure distance** keeps navigation paused. Click two visible model surfaces in the video (not its letterbox bars). Instructions, no-hit feedback, streamed endpoint markers/segment, and a distance readout guide the selection. Click again after completion for another measurement, **Clear / start again** to reset, or **Cancel measurement** to remove it.
- **Resume navigation** exits measurement and requests pointer lock using your explicit gesture. If locking fails, navigation remains paused and you can retry.

Distances are Euclidean distances between server-raycast **world-space** surface points, including model transforms/scales, labeled **model units**. The converter applies IFC placement transforms, but the viewer accepts arbitrary self-contained GLBs and does not verify their physical units; it does not guarantee meters. Picks send only normalized image coordinates; geometry, scene assets, and model tokens remain private. Wireframe and measurement state belong to each session.

The HUD updates every 0.5 seconds with server-rendered FPS, average CPU render-call time, time since the renderer's last input update, and WebGL GPU vendor/model. Warnings appear below 20 FPS or above 40 ms average render time. Input update age is not end-to-end network/video latency, and CPU render time is not GPU execution time or utilization. A SwiftShader/software model name indicates software rendering; a hardware model name does not guarantee hardware video encoding. These diagnostics help identify slow rendering but cannot by themselves separate every CPU, GPU, encoding, or network bottleneck.

`npm run dev` uses built-in `node --watch` (no nodemon). `npm test` runs the available Node built-in integration tests.

## Private models

Keep both source IFC and converted GLB **outside `public/`**. Convert offline using the pure `web-ifc` WebAssembly converter:

```powershell
npm run convert -- "C:\private\model.ifc" "C:\private\model.glb"
$env:MODEL_PATH = "C:\private\model.glb"
npm start
```

`MODEL_PATH` must point to a self-contained `.glb` without external asset dependencies. The server keeps only its private path and streams the file to server Chromium through the token-protected loopback endpoint; viewer clients receive neither the token nor geometry. The converter exports geometry only: BIM metadata and complete material fidelity are not preserved. Huge models can exceed conversion/rendering memory limits.

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

Manual checks for **both WebRTC and WebSocket WebM fallback**: confirm decoded video and diagnostics; hold W/Shift, press Escape, and verify movement stops even while continuing to hold/repeat keys. Tab through the options, toggle wireframe on/off, select two surfaces, miss the model, reset/cancel and repeat. Resize to a letterboxed viewport and verify bars cannot select points. Confirm markers/readout and independent sessions, blur/reconnect reset, and Resume/pointer-lock failure behavior. Fallback video can lag the server scene; wait for the paused view to settle before selecting points. For fallback, block WebRTC connectivity and wait for the automatic five-second switch.

Each viewer incurs server rendering, encoding, memory, and bandwidth costs. GPU acceleration is environment-dependent; no NVIDIA/NVENC encoding, hardware capacity, latency, or frame-rate guarantee is made. SwiftShader is a software fallback, not GPU acceleration. Keep Chromium's sandbox enabled.

Private model files are not delivered to clients, but visible pixels can be captured: this is **not DRM**. A shared password is not per-user account management.

Linux Node 22 integration passed with sandbox-enabled software rendering, IFC conversion, decoded fallback video, navigation, session isolation, and private-route checks. `npm audit` reported zero vulnerabilities. The direct WebRTC path could not be validated because the runner returned no usable ICE candidates. Hardware GPU and Windows execution remain pending; follow the Windows checklist in [SETUP.md](SETUP.md).

For the navigation update, `node --test test/navigation.test.js` passed all four deterministic tests (bounds fitting, acceleration/reset, facing-direction dolly, and client controls/wheel normalization). `CHROME_EXECUTABLE_PATH=/usr/bin/chromium CHROME_SOFTWARE_RENDERING=1 npm test` ran on Node 22: four passed and all four browser integration tests failed at Chromium launch with “No usable sandbox”, before streaming/session checks could execute. The sandbox was not disabled. JavaScript syntax and `git diff --check` passed; the locked dependency install reported zero audit vulnerabilities.

Windows CI is `action_required`, awaiting maintainer approval; no Windows jobs have executed.

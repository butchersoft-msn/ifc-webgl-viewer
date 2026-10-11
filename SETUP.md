# Prototype setup

Requires **Node.js >=22.12**. `npm test` runs Node built-in integration tests. Linux Node 22 integration passed with sandbox-enabled software rendering, IFC conversion, decoded fallback video, navigation, session isolation, and private-route checks; `npm audit` reported zero vulnerabilities. Direct WebRTC could not be validated because the runner returned no usable ICE candidates. Hardware GPU and Windows execution remain pending.

## Windows (PowerShell)

Install [NVM for Windows](https://github.com/coreybutler/nvm-windows), then use an elevated terminal if required:

```powershell
nvm install 22
nvm list
```

Run `nvm use` with the **actual installed 22.x version** shown by `nvm list` (at least 22.12.0), for example `nvm use 22.22.0` only if that exact version is installed.

```powershell
node --version
npm --version
Set-Location "C:\path\to\ifc-webgl-viewer"
```

If replacing the old prototype package, remove its dependencies and lockfile before installing the new package:

```powershell
if (Test-Path node_modules) { Remove-Item node_modules -Recurse -Force }
if (Test-Path package-lock.json) { Remove-Item package-lock.json -Force }
npm install
npm start
```

For a fresh checkout, just run `npm install` and `npm start`. Open **http://127.0.0.1:3000**. Puppeteer uses Chromium for server rendering; installation may download a browser. The old native `canvas` package is not part of this architecture.

For development, `npm run dev` uses built-in `node --watch`; nodemon is not required.

## Linux / macOS

Install Node >=22.12, then in the project directory:

```sh
node --version
npm install
npm start
```

On Linux, Chromium needs the system libraries appropriate to your distribution and a working sandbox. Resolve missing libraries or sandbox configuration rather than disabling the sandbox. macOS verification is not claimed here.

## Load a private model

To offer a model dropdown, create `model/` in the repository root (or configure `MODEL_DIRECTORY` to another private directory), then convert each source IFC offline into a self-contained GLB in that folder:

```powershell
New-Item -ItemType Directory -Force model
npm run convert -- "C:\private\building.ifc" ".\model\building.glb"
# Optional alternative catalog location:
$env:MODEL_DIRECTORY = "C:\private\converted-models"
```

The folder must be outside `public/`. Only supported `.glb` files directly in the folder are listed; IFC files are not rendered directly or converted automatically. In the browser, enter the configured password, click **Load available models**, choose a model, then **Start Viewing**. Listing requires the same password/origin checks as starting a session. An empty/missing folder leaves the default model/demo available. Each user's selection is bound to that session's private renderer token; paths and geometry are never included in the catalog response.

Setup hides only when the model is ready and video playback has begun. The compact toolbar provides solid, wireframe, and distance measurement controls. Click the video to navigate; press ESC to access options and release mouse lock before using tools. Measurement opens the existing two-surface picking instructions, clear/cancel controls, and result. Diagnostics stay hidden until **Show diagnostics** is selected in options. Connection failures restore setup so you can retry.

Keep IFC and GLB files outside `public/`. Convert offline with the pure `web-ifc` WebAssembly converter, then configure the resulting self-contained GLB:

```powershell
npm run convert -- "C:\private\model.ifc" "C:\private\model.glb"
$env:MODEL_PATH = "C:\private\model.glb"
npm start
```

The converter exclusively creates the output GLB and refuses to overwrite existing files. Before reconversion, deliberately delete the old output (for example, `Remove-Item "C:\private\model.glb"` in PowerShell), or choose a new output path.

On Linux/macOS:

```sh
npm run convert -- "/private/model.ifc" "/private/model.glb"
MODEL_PATH="/private/model.glb" npm start
```

Without `MODEL_PATH`, a demo scene is used. GLB files must not depend on external assets. Conversion is geometry-only, not complete BIM metadata/material preservation; huge models may exhaust memory. Renderer modules use an intercepted loopback origin. GLB files are streamed over normal HTTP at `/private-model`, accessible only from loopback with a random per-session renderer token. Tokens are never sent to viewer clients and are revoked when sessions end; file paths remain private. Viewers can capture visible pixels; this is not DRM.

## Video transport

WebRTC is preferred. If it has not connected after **5 seconds**, video automatically falls back over the authenticated same-origin WebSocket. Chromium `MediaRecorder` encodes the server canvas as WebM; the client's built-in `MediaSource` plays it in a video element. This requires `MediaSource` support for `video/webm` VP8 and is not universal. There is no base64 JPEG streaming or client geometry in either mode.

## Environment and external access

Local PowerShell examples (set only the options you need):

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "3000"
$env:MAX_SESSIONS = "4"
$env:VIEWER_PASSWORD = Read-Host "Shared viewer password"
# Optional: use an existing compatible Chromium installation
$env:CHROME_EXECUTABLE_PATH = "C:\path\to\chrome.exe"
# Explicit software rendering fallback, if needed
$env:CHROME_SOFTWARE_RENDERING = "1"
npm start
```

`VIEWER_PASSWORD` enables shared login via `POST /session` with a `password` field. Sessions use a non-shareable HttpOnly cookie, expire after one hour, and permit one WebSocket per session. Independent viewers need separate browser profiles/private contexts.

For external access, configure an HTTPS reverse proxy that forwards to the server and supports same-origin WebSocket upgrades. When `HOST` is not loopback, `APP_ORIGIN` is required and must match the public origin:

A public/non-loopback `APP_ORIGIN` requires HTTPS and `VIEWER_PASSWORD`, even if backend `HOST` remains loopback. Set the shared password before starting with the external configuration below.

```powershell
$env:HOST = "0.0.0.0"
$env:APP_ORIGIN = "https://viewer.example.com"
$env:ICE_SERVERS = '[{"urls":"stun:stun.example.com:3478"},{"urls":"turn:turn.example.com:3478","username":"replace-me","credential":"replace-me"}]'
npm start
```

Replace example ICE endpoints/credentials with your STUN/TURN service. `ICE_SERVERS` is a JSON array of `RTCIceServer` objects. Allow WebRTC UDP connectivity or provide a reachable TURN relay: an HTTPS/WebSocket proxy does not relay WebRTC media. The automatic WebM fallback uses the proxied WebSocket on supported browsers. Keep passwords and TURN credentials out of source control.

Express limits all HTTP requests to 120/minute/IP and `POST /session` to 10/minute/IP. Behind a reverse proxy, the default limiter uses the proxy IP, so all users share its quota. Do not change `trust proxy` blindly; review proxy trust and rate limiting before production deployment.

## Troubleshooting and Windows verification

- Install errors: confirm the active Node version and check Puppeteer's browser download/network access.
- Chromium launch errors: check system dependencies or `CHROME_EXECUTABLE_PATH`; do not disable its sandbox.
- Signaling failure: check `APP_ORIGIN`, login/cookies, and proxy WebSocket upgrade handling. There is no separate port 8080.
- Connected but no video: inspect browser/server logs and ICE connectivity; check UDP/firewall/TURN configuration. After 5 seconds without WebRTC, check WebSocket fallback delivery and `MediaSource` WebM/VP8 support.
- Slow rendering: reduce concurrent sessions/model size and inspect CPU, memory, GPU, and network use. Each session has rendering/encoding costs. GPU use is not guaranteed, SwiftShader is software, and Chromium encoding does not promise NVENC.

Windows verification checklist (not a record of completed tests):

Windows CI currently reports `action_required` awaiting maintainer approval. No Windows jobs have executed.

- [ ] Confirm Node >=22.12 and successful `npm install` from the replacement package.
- [ ] Start on `127.0.0.1:3000`; verify demo video, WASD/arrows, mouse look, and Escape.
- [ ] Convert a private IFC and view its self-contained GLB via `MODEL_PATH`.
- [ ] Verify shared-password login, one WebSocket per session, independent browser contexts, one-hour expiration, and the configured session limit.
- [ ] Confirm clients cannot download source IFC/GLB or server-only renderer assets.
- [ ] Verify HTTPS proxy upgrades and WebRTC connectivity across the intended network, including TURN where needed.
- [ ] With WebRTC unavailable, verify automatic WebM fallback after 5 seconds on a browser supporting `MediaSource` WebM/VP8.
- [ ] Check Chromium rendering mode and resource use; stop with Ctrl+C.

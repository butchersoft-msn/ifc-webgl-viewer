const express = require('express');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const puppeteer = require('puppeteer');
const { rateLimit } = require('express-rate-limit');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const SESSION_MS = 60 * 60 * 1000;

async function start(options = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PORT || 3000);
  const password = options.password ?? process.env.VIEWER_PASSWORD;
  const maxSessions = Number(process.env.MAX_SESSIONS || 4);
  const configuredOrigin = options.origin ?? process.env.APP_ORIGIN;
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new Error('Invalid MAX_SESSIONS');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (!password || !configuredOrigin)) {
    throw new Error('External hosting requires VIEWER_PASSWORD and APP_ORIGIN (HTTPS)');
  }
  if (configuredOrigin && new URL(configuredOrigin).origin !== configuredOrigin) {
    throw new Error('APP_ORIGIN must be an exact origin without a trailing slash');
  }
  if (configuredOrigin && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(configuredOrigin).hostname) &&
      (!password || !configuredOrigin.startsWith('https://'))) {
    throw new Error('Public APP_ORIGIN requires VIEWER_PASSWORD and HTTPS');
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !configuredOrigin.startsWith('https://')) {
    throw new Error('External APP_ORIGIN must use HTTPS');
  }
  const iceServers = JSON.parse(process.env.ICE_SERVERS || '[]');
  const modelPath = options.modelPath ?? process.env.MODEL_PATH;
  let model;
  if (modelPath) {
    const resolved = await fs.realpath(path.resolve(modelPath));
    const relative = path.relative(await fs.realpath(PUBLIC), resolved);
    if (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
      throw new Error('MODEL_PATH must be outside public');
    }
    const handle = await fs.open(resolved, 'r');
    const magic = Buffer.alloc(4);
    try { await handle.read(magic, 0, 4, 0); } finally { await handle.close(); }
    if (path.extname(resolved).toLowerCase() !== '.glb' || magic.toString('ascii') !== 'glTF') {
      throw new Error('MODEL_PATH must be a self-contained GLB; convert IFC first');
    }
    model = resolved;
  }
  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.CHROME_EXECUTABLE_PATH || undefined,
    args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...(process.env.CHROME_SOFTWARE_RENDERING === '1'
      ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : ['--enable-gpu'])],
  });
  const app = express();
  const server = http.createServer(app);
  const needsLoopbackServer = !['127.0.0.1', 'localhost', '::', '::1', '0.0.0.0'].includes(host);
  const modelServer = needsLoopbackServer ? http.createServer(app) : server;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  const sessions = new Map();
  const modelTokens = new Set();
  let origin;
  const assets = new Map([
    ['/index.html', [path.join(ROOT, 'renderer/index.html'), 'text/html']],
    ['/renderer.js', [path.join(ROOT, 'renderer/renderer.js'), 'text/javascript']],
    ['/navigation.mjs', [path.join(ROOT, 'renderer/navigation.mjs'), 'text/javascript']],
    ['/viewer-tools.mjs', [path.join(ROOT, 'renderer/viewer-tools.mjs'), 'text/javascript']],
    ['/three.js', [path.join(ROOT, 'node_modules/three/build/three.module.js'), 'text/javascript']],
    ['/three.core.js', [path.join(ROOT, 'node_modules/three/build/three.core.js'), 'text/javascript']],
    ['/GLTFLoader.js', [path.join(ROOT, 'node_modules/three/examples/jsm/loaders/GLTFLoader.js'), 'text/javascript']],
    ['/utils/BufferGeometryUtils.js', [path.join(ROOT, 'node_modules/three/examples/jsm/utils/BufferGeometryUtils.js'), 'text/javascript']],
    ['/utils/SkeletonUtils.js', [path.join(ROOT, 'node_modules/three/examples/jsm/utils/SkeletonUtils.js'), 'text/javascript']],
  ]);
  async function remove(id) {
    const session = sessions.get(id);
    if (!session) return;
    sessions.delete(id);
    clearTimeout(session.timer);
    clearInterval(session.syncInterval);
    clearInterval(session.rateTimer);
    modelTokens.delete(session.modelToken);
    session.ws?.close(1000, 'Session ended');
    await session.page?.close().catch(() => {});
  }
  function sessionId(req) {
    return /(?:^|;\s*)viewer=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  }
  app.disable('x-powered-by');
  app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: 'draft-8', legacyHeaders: false }));
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'");
    next();
  });
  app.post('/session', rateLimit({ windowMs: 60000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false }),
    express.json({ limit: '1kb' }), async (req, res) => {
    if (req.headers.origin !== origin) return res.sendStatus(403);
    if (password) {
      const supplied = Buffer.from(typeof req.body?.password === 'string' ? req.body.password : '');
      const expected = Buffer.from(password);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.sendStatus(401);
    }
    if (sessions.has(sessionId(req))) await remove(sessionId(req));
    if (sessions.size >= maxSessions) return res.status(503).json({ error: 'Viewer capacity reached' });
    const id = randomBytes(32).toString('hex');
    const session = { page: null, ws: null, modelToken: model ? randomBytes(32).toString('hex') : null };
    if (session.modelToken) modelTokens.add(session.modelToken);
    session.timer = setTimeout(() => void remove(id), SESSION_MS).unref();
    sessions.set(id, session);
    res.setHeader('Set-Cookie', `viewer=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${origin.startsWith('https:') ? '; Secure' : ''}`);
    res.json({ iceServers });
  });
  // Private geometry travels over HTTP, never through the DevTools control channel.
  app.get('/private-model', (req, res) => {
    const loopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    if (!model || !loopback || !modelTokens.has(token)) return res.sendStatus(404);
    res.sendFile(model, { dotfiles: 'allow', headers: { 'Content-Type': 'model/gltf-binary' } });
  });
  // Only these three client assets are public, even if a model is misplaced.
  for (const file of ['index.html', 'client.js', 'styles.css']) {
    app.get(file === 'index.html' ? '/' : `/${file}`, (req, res) => res.sendFile(path.join(PUBLIC, file)));
  }
  server.on('upgrade', (req, socket, head) => {
    const id = sessionId(req);
    const session = sessions.get(id);
    if (req.url !== '/signal' || req.headers.origin !== origin || !session || session.ws) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => {
      session.ws = ws;
      wss.emit('connection', ws, req, id);
    });
  });
  wss.on('connection', async (ws, req, id) => {
    const session = sessions.get(id);
    let ready = false;
    let chain = Promise.resolve();
    let count = 0;
    let pendingInput = null;
    let inputSyncing = false;
    let paused = true;
    let inputEpoch = 0;
    let queuedCommands = 0;
    session.rateTimer = setInterval(() => { count = 0; }, 1000);
    const send = message => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    ws.on('close', () => { ready = false; void remove(id); });
    ws.on('error', () => void remove(id));
    ws.on('message', data => {
      if (++count > 100) return ws.close(1008, 'Input rate exceeded');
      if (!ready) return;
      let message;
      try {
        message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid command');
        if (message.type === 'input') {
          if (paused) return;
          const delta = value => Number.isFinite(value) ? Math.max(-500, Math.min(500, value)) : 0;
          if (message.reset === true) pendingInput = null;
          pendingInput = {
            forward: message.forward === true, backward: message.backward === true,
            left: message.left === true, right: message.right === true,
            up: message.up === true, down: message.down === true,
            boost: message.boost === true, reset: message.reset === true || pendingInput?.reset === true,
            x: delta((pendingInput?.x || 0) + delta(message.x)),
            y: delta((pendingInput?.y || 0) + delta(message.y)),
            wheel: delta((pendingInput?.wheel || 0) + delta(message.wheel)),
          };
          return;
        }
        if (message.type === 'pause') {
          if (typeof message.paused !== 'boolean') throw new Error('Invalid pause');
          paused = message.paused;
          pendingInput = null;
          message = { type: 'pause', paused, epoch: ++inputEpoch };
        } else if (message.type === 'wireframe') {
          if (typeof message.enabled !== 'boolean') throw new Error('Invalid wireframe');
          message = { type: 'wireframe', enabled: message.enabled };
        } else if (message.type === 'measure') {
          if (!['start', 'clear', 'cancel', 'pick'].includes(message.action) ||
              !Number.isSafeInteger(message.requestId) || message.requestId < 0 ||
              (message.action === 'pick' && (!Number.isFinite(message.x) || !Number.isFinite(message.y) ||
                message.x < 0 || message.x > 1 || message.y < 0 || message.y > 1)) || !paused) {
            throw new Error('Invalid measurement');
          }
          message = { type: 'measure', action: message.action, requestId: message.requestId,
            ...(message.action === 'pick' ? { x: message.x, y: message.y } : {}) };
        } else if (!['answer', 'ice'].includes(message.type)) throw new Error('Invalid command');
      } catch {
        ws.close(1008, 'Invalid signaling message');
        return;
      }
      if (++queuedCommands > 32) return ws.close(1008, 'Command queue exceeded');
      chain = chain.then(async () => {
        if (!ready) return;
        if (message.type === 'answer' && typeof message.sdp === 'string' && message.sdp.length < 12000) {
          await session.page.evaluate(sdp => window.acceptAnswer(sdp), message.sdp);
        } else if (message.type === 'ice' && message.candidate && typeof message.candidate.candidate === 'string') {
          await session.page.evaluate(candidate => window.acceptIce(candidate), message.candidate);
        } else if (['pause', 'wireframe', 'measure'].includes(message.type)) {
          const result = await session.page.evaluate(command => {
            if (command.type === 'pause') window.inputEpoch = command.epoch;
            return window.viewerCommand(command);
          }, message);
          if (result) send(result);
        } else {
          throw new Error('Invalid signaling message');
        }
      }).catch(() => ws.close(1008, 'Invalid signaling message')).finally(() => { queuedCommands--; });
    });
    try {
      const page = await browser.newPage();
      session.page = page;
      if (!sessions.has(id)) { await page.close(); return; }
      await page.setViewport({ width: 1280, height: 720 });
      await page.setRequestInterception(true);
      page.on('request', request => {
        void (async () => {
          const url = new URL(request.url());
          if (url.origin !== rendererOrigin) return request.abort();
          if (url.pathname === '/private-model' && model) return request.continue();
          const asset = assets.get(url.pathname);
          if (!asset) return request.abort();
          await request.respond({ status: 200, contentType: asset[1], body: await fs.readFile(asset[0]) });
        })().catch(() => { void request.abort().catch(() => {}); });
      });
      await page.exposeFunction('sendSignal', send);
      await page.exposeFunction('sendVideo', base64 => {
        if (ws.readyState !== WebSocket.OPEN) return;
        if (ws.bufferedAmount > 4 * 1024 * 1024) {
          ws.close(1013, 'Video receiver too slow');
          return;
        }
        ws.send(Buffer.from(base64, 'base64'));
      });
      await page.goto(`${rendererOrigin}/index.html`);
      await page.waitForFunction(() => window.rendererReady || window.rendererError, { timeout: 60000, polling: 100 });
      const error = await page.evaluate(() => window.rendererError);
      if (error) throw new Error(error);
      const gpu = await page.evaluate(() => window.getGPUInfo());
      if (!sessions.has(id)) return;
      ready = true;
      session.syncInterval = setInterval(async () => {
        if (!ready || inputSyncing || !pendingInput) return;
        const input = pendingInput;
        const epoch = inputEpoch;
        pendingInput = null;
        inputSyncing = true;
        try {
          await page.evaluate((input, epoch) => {
            if (epoch === (window.inputEpoch || 0)) window.setInput(input);
          }, input, epoch);
        } catch {
          ws.close(1011, 'Input sync failed');
          await remove(id);
        } finally {
          inputSyncing = false;
        }
      }, 33);
      await page.evaluate(config => window.startStream(config),
        { iceServers, hasModel: !!model, modelToken: session.modelToken, gpu });
      send({ type: 'ready' });
    } catch (error) {
      console.error('Renderer session failed:', error.message);
      send({ type: 'error', message: 'Renderer failed. Check the server log.' });
      ws.close(1011, 'Renderer failed');
      await remove(id);
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, resolve);
    });
    if (needsLoopbackServer) {
      await new Promise((resolve, reject) => {
        modelServer.once('error', reject);
        modelServer.listen(0, '127.0.0.1', resolve);
      });
    }
  } catch (error) { server.close(); await browser.close(); throw error; }
  origin = configuredOrigin || `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
  const rendererHost = ['::', '::1'].includes(host) ? '[::1]' : host === 'localhost' ? 'localhost' : '127.0.0.1';
  const rendererOrigin = `http://${rendererHost}:${modelServer.address().port}`;
  console.log(`Remote viewer: ${origin} (${model ? 'private GLB' : 'demo scene'})`);
  async function close() {
    await Promise.all([...sessions.keys()].map(remove));
    wss.close();
    await new Promise(resolve => server.close(resolve));
    if (needsLoopbackServer) await new Promise(resolve => modelServer.close(resolve));
    await browser.close();
  }
  return { server, browser, sessions, origin, close };
}

if (require.main === module) {
  start().then(viewer => {
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      void viewer.close().then(() => process.exit(0));
    });
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { start };

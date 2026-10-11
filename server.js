const express = require('express');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs/promises');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');
const puppeteer = require('puppeteer');

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
    model = await fs.readFile(resolved);
    if (path.extname(resolved).toLowerCase() !== '.glb' || model.toString('ascii', 0, 4) !== 'glTF') {
      throw new Error('MODEL_PATH must be a self-contained GLB; convert IFC first');
    }
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
  const wss = new WebSocketServer({ noServer: true, maxPayload: 16384 });
  const sessions = new Map();
  let origin;
  const assets = new Map([
    ['/index.html', [path.join(ROOT, 'renderer/index.html'), 'text/html']],
    ['/renderer.js', [path.join(ROOT, 'renderer/renderer.js'), 'text/javascript']],
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
    session.ws?.close(1000, 'Session ended');
    await session.page?.close().catch(() => {});
  }
  function sessionId(req) {
    return /(?:^|;\s*)viewer=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  }
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'");
    next();
  });
  app.post('/session', express.json({ limit: '1kb' }), async (req, res) => {
    if (req.headers.origin !== origin) return res.sendStatus(403);
    if (password) {
      const supplied = Buffer.from(typeof req.body?.password === 'string' ? req.body.password : '');
      const expected = Buffer.from(password);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return res.sendStatus(401);
    }
    if (sessions.has(sessionId(req))) await remove(sessionId(req));
    if (sessions.size >= maxSessions) return res.status(503).json({ error: 'Viewer capacity reached' });
    const id = randomBytes(32).toString('hex');
    const session = { page: null, ws: null };
    session.timer = setTimeout(() => void remove(id), SESSION_MS).unref();
    sessions.set(id, session);
    res.setHeader('Set-Cookie', `viewer=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600${origin.startsWith('https:') ? '; Secure' : ''}`);
    res.json({ iceServers });
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
    const rateTimer = setInterval(() => { count = 0; }, 1000);
    const send = message => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };
    ws.on('close', () => { clearInterval(rateTimer); void remove(id); });
    ws.on('error', () => void remove(id));
    ws.on('message', data => {
      if (++count > 100) return ws.close(1008, 'Input rate exceeded');
      chain = chain.then(async () => {
        if (!ready) return;
        const message = JSON.parse(data.toString());
        if (message.type === 'answer' && typeof message.sdp === 'string' && message.sdp.length < 12000) {
          await session.page.evaluate(sdp => window.acceptAnswer(sdp), message.sdp);
        } else if (message.type === 'ice' && message.candidate && typeof message.candidate.candidate === 'string') {
          await session.page.evaluate(candidate => window.acceptIce(candidate), message.candidate);
        } else if (message.type === 'input') {
          const input = {
            forward: message.forward === true, backward: message.backward === true,
            left: message.left === true, right: message.right === true,
            x: Number.isFinite(message.x) ? Math.max(-500, Math.min(500, message.x)) : 0,
            y: Number.isFinite(message.y) ? Math.max(-500, Math.min(500, message.y)) : 0,
          };
          await session.page.evaluate(input => window.setInput(input), input);
        }
      }).catch(() => ws.close(1008, 'Invalid signaling message'));
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
          if (url.pathname === '/model.glb' && model) {
            return request.respond({ status: 200, contentType: 'model/gltf-binary', body: model });
          }
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
      ready = true;
      await page.evaluate(config => window.startStream(config), { iceServers, hasModel: !!model });
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
  } catch (error) { await browser.close(); throw error; }
  origin = configuredOrigin || `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
  const rendererOrigin = `http://127.0.0.1:${server.address().port}`;
  console.log(`Remote viewer: ${origin} (${model ? 'private GLB' : 'demo scene'})`);
  async function close() {
    await Promise.all([...sessions.keys()].map(remove));
    wss.close();
    await new Promise(resolve => server.close(resolve));
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

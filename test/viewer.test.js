const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { WebSocket } = require('ws');
const { start } = require('../server');
const { convert } = require('../convert');

test('private IFC conversion and independent video-only sessions', { timeout: 120000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'private-viewer-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const modelPath = path.join(directory, 'wall.glb');
  const fixture = path.join(__dirname, 'fixtures/wall.ifc.txt');
  assert.ok(await convert(fixture, modelPath) > 0);
  const glb = await fs.readFile(modelPath);
  assert.equal(glb.toString('ascii', 0, 4), 'glTF');
  assert.equal(glb.readUInt32LE(8), glb.length);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + glb.readUInt32LE(12)));
  assert.ok(json.meshes.length > 0);
  assert.equal(json.buffers[0].uri, undefined);
  assert.equal(json.images, undefined);
  // Pad the BIN chunk beyond the 100 MiB DevTools limit after base64 encoding.
  const modelSize = 80 * 1024 * 1024;
  const binOffset = 20 + glb.readUInt32LE(12);
  glb.writeUInt32LE(modelSize, 8);
  glb.writeUInt32LE(modelSize - binOffset - 8, binOffset);
  await fs.writeFile(modelPath, glb);
  await fs.truncate(modelPath, modelSize);
  await assert.rejects(convert(fixture, modelPath), /EEXIST/);
  await assert.rejects(convert(fixture, path.join(__dirname, '../public/private.glb')), /outside public/);
  await assert.rejects(start({ host: '0.0.0.0', password: '', port: 0 }), /External hosting requires/);
  await assert.rejects(start({ origin: 'https://viewer.example.com', password: '', port: 0 }), /requires VIEWER_PASSWORD/);
  await assert.rejects(start({ modelPath: path.join(__dirname, '../public/client.js'), port: 0 }), /outside public/);

  const viewer = await start({ port: 0, password: 'test-password', modelPath });
  const contexts = [];
  t.after(async () => {
    await Promise.all(contexts.map(context => context.close()));
    await viewer.close();
  });
  for (const route of ['/model.glb', '/private-model', '/private-model?token=invalid', '/private-model?token=a&token=b',
    '/model.ifc', '/renderer/renderer.js', '/node_modules/three/build/three.module.js', '/server.js', '/private/wall.glb']) {
    assert.equal((await fetch(viewer.origin + route)).status, 404, route);
  }
  const sessionRequest = (password, origin = viewer.origin) => fetch(`${viewer.origin}/session`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password }),
  });
  assert.equal((await sessionRequest('wrong')).status, 401);
  assert.equal((await sessionRequest('test-password', 'https://untrusted.invalid')).status, 403);
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(viewer.origin.replace('http:', 'ws:') + '/signal', { origin: viewer.origin });
    socket.on('unexpected-response', (req, response) => { assert.equal(response.statusCode, 403); response.resume(); resolve(); });
    socket.on('open', () => { socket.close(); reject(new Error('Unauthenticated WebSocket accepted')); });
    socket.on('error', reject);
  });
  const clients = [];
  for (let i = 0; i < 2; i++) {
    const context = await viewer.browser.createBrowserContext();
    contexts.push(context);
    const page = await context.newPage();
    const requests = [];
    page.on('request', req => requests.push(req.url()));
    await page.goto(viewer.origin);
    await page.type('#password', 'test-password');
    await page.click('button');
    await page.bringToFront();
    await page.waitForFunction(() => {
      const video = document.querySelector('video');
      return video.readyState >= 2 && video.videoWidth > 0 && video.getVideoPlaybackQuality().totalVideoFrames > 2;
    }, { timeout: 30000, polling: 100 }).catch(async error => {
      console.error(`Viewer ${i}:`, await page.evaluate(() => ({
        status: document.querySelector('#connectionStatus').textContent,
        connection: peer?.connectionState, ice: peer?.iceGatheringState,
        frames: video.getVideoPlaybackQuality().totalVideoFrames,
      })));
      throw error;
    });
    assert.ok(requests.every(url => ['/', '/client.js', '/styles.css', '/session', '/favicon.ico'].includes(new URL(url).pathname)), requests.join('\n'));
    clients.push(page);
  }
  assert.equal(viewer.sessions.size, 2);
  const sessions = [...viewer.sessions.values()];
  assert.match(sessions[0].modelToken, /^[a-f0-9]{64}$/);
  assert.notEqual(sessions[0].modelToken, sessions[1].modelToken);
  for (const session of sessions) {
    const result = await session.page.evaluate(async token => {
      const response = await fetch(`/private-model?token=${encodeURIComponent(token)}`, {
        headers: { Range: 'bytes=0-3' },
      });
      return { status: response.status, type: response.headers.get('Content-Type'), magic: await response.text() };
    }, session.modelToken);
    assert.deepEqual(result, { status: 206, type: 'model/gltf-binary', magic: 'glTF' });
    assert.notDeepEqual(await session.page.evaluate(() => window.camera.position.toArray()),
      [0, 2, 12], 'Model, not demo cube, loaded');
  }
  // A delayed WebRTC candidate must not tear down an already-playing fallback.
  sessions[0].ws.send(JSON.stringify({ type: 'ice', candidate: {
    candidate: 'candidate:1 1 udp 1 127.0.0.1 12345 typ host', sdpMid: '0', sdpMLineIndex: 0,
  } }));
  const positions = await Promise.all(sessions.map(session => session.page.evaluate(() => window.camera.position.toArray())));
  assert.deepEqual(positions[0], positions[1]);
  await clients[0].keyboard.down('ArrowUp');
  await new Promise(resolve => setTimeout(resolve, 600));
  await clients[0].keyboard.up('ArrowUp');
  const moved = await Promise.all(sessions.map(session => session.page.evaluate(() => window.camera.position.toArray())));
  assert.notDeepEqual(moved[0], positions[0]);
  assert.deepEqual(moved[1], positions[1]);
  await sessions[0].page.evaluate(() => window.setInput({ x: 80, y: 30 }));
  assert.notEqual(await sessions[0].page.evaluate(() => window.camera.rotation.y), await sessions[1].page.evaluate(() => window.camera.rotation.y));
  await clients[0].close();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(viewer.sessions.size, 1);
  assert.equal((await fetch(`${viewer.origin}/private-model?token=${sessions[0].modelToken}`)).status, 404);
  const activeModel = await fetch(`${viewer.origin}/private-model?token=${sessions[1].modelToken}`, {
    headers: { Range: 'bytes=0-3' },
  });
  assert.equal(activeModel.status, 206);
  assert.equal(activeModel.headers.get('Cache-Control'), 'no-store');
  assert.equal(await activeModel.text(), 'glTF');
  for (let i = 0; i < 7; i++) await sessionRequest('wrong');
  assert.equal((await sessionRequest('wrong')).status, 429);
});

test('private model rejects remote peers and revokes replaced session tokens', { timeout: 120000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'private-endpoint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const modelPath = path.join(directory, 'model.glb');
  await fs.writeFile(modelPath, 'glTF');
  const viewer = await start({ host: '0.0.0.0', port: 0, origin: 'https://viewer.example.com',
    password: 'test-password', modelPath });
  t.after(() => viewer.close());
  const localOrigin = `http://127.0.0.1:${viewer.server.address().port}`;
  const create = cookie => fetch(`${localOrigin}/session`, {
    method: 'POST', headers: { Origin: viewer.origin, 'Content-Type': 'application/json', Cookie: cookie || '' },
    body: JSON.stringify({ password: 'test-password' }),
  });
  const first = await create();
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { iceServers: [] });
  const token = [...viewer.sessions.values()][0].modelToken;
  const route = `/private-model?token=${token}`;
  assert.equal(await (await fetch(localOrigin + route)).text(), 'glTF');
  const remote = Object.values(os.networkInterfaces()).flat()
    .find(address => address.family === 'IPv4' && !address.internal);
  if (remote) {
    assert.equal((await fetch(`http://${remote.address}:${viewer.server.address().port}${route}`, {
      headers: { 'X-Forwarded-For': '127.0.0.1' },
    })).status, 404);
  } else {
    t.diagnostic('No non-loopback IPv4 interface available for remote-peer check');
  }
  assert.equal((await create(first.headers.get('set-cookie').split(';')[0])).status, 200);
  assert.equal((await fetch(localOrigin + route)).status, 404);
});

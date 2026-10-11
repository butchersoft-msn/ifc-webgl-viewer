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
  const privateDirectory = path.join(directory, '.private');
  await fs.mkdir(privateDirectory);
  const modelPath = path.join(privateDirectory, 'wall.glb');
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
    await page.click('#startViewing');
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
    await page.waitForFunction(() => document.getElementById('login').hidden);
    assert.equal(await page.$eval('#toolbar', element => element.hidden), false);
    assert.equal(await page.$eval('#diagnostics', element => element.hidden), true);
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
  await clients[0].click('#video');
  await clients[0].waitForFunction(() => document.pointerLockElement === video);
  await clients[0].keyboard.down('ArrowUp');
  await new Promise(resolve => setTimeout(resolve, 600));
  await clients[0].keyboard.up('ArrowUp');
  const moved = await Promise.all(sessions.map(session => session.page.evaluate(() => window.camera.position.toArray())));
  assert.notDeepEqual(moved[0], positions[0]);
  assert.deepEqual(moved[1], positions[1]);
  await clients[0].keyboard.press('Escape');
  await clients[0].click('#showDiagnostics');
  await clients[0].waitForFunction(() => !document.getElementById('diagnostics').hidden);
  const gpu = await sessions[0].page.evaluate(() => window.getGPUInfo());
  assert.equal(await clients[0].$eval('#gpuRenderer', element => element.textContent), gpu.renderer);
  assert.equal(await clients[0].$eval('#gpuVendor', element => element.textContent), gpu.vendor);
  assert.ok(Number(await clients[0].$eval('#fps', element => element.textContent)) > 0);
  await clients[0].evaluate(gpu => {
    socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
      type: 'stats', fps: 10, renderTime: 45, inputLatency: 12, gpu,
    }) }));
  }, gpu);
  await clients[0].waitForFunction(() => {
    const warning = document.getElementById('performanceWarning').textContent;
    return warning.includes('Low FPS') && warning.includes('Slow render');
  });
  await clients[0].click('#resume');
  await clients[0].waitForFunction(() => document.pointerLockElement === video);
  await new Promise(resolve => setTimeout(resolve, 300));
  const beforeVertical = await sessions[0].page.evaluate(() => window.camera.position.toArray());
  await clients[0].keyboard.down('e');
  await new Promise(resolve => setTimeout(resolve, 600));
  await clients[0].keyboard.up('e');
  const above = await sessions[0].page.evaluate(() => window.camera.position.toArray());
  assert.ok(above[1] > beforeVertical[1]);
  assert.equal(above[0], beforeVertical[0]);
  assert.equal(above[2], beforeVertical[2]);
  await clients[0].keyboard.down('q');
  await new Promise(resolve => setTimeout(resolve, 600));
  await clients[0].keyboard.up('q');
  assert.ok((await sessions[0].page.evaluate(() => window.camera.position.y)) < above[1]);
  await clients[0].keyboard.down('Shift');
  await clients[0].keyboard.down('ArrowUp');
  await new Promise(resolve => setTimeout(resolve, 300));
  await clients[0].keyboard.up('ArrowUp');
  await clients[0].keyboard.up('Shift');
  await new Promise(resolve => setTimeout(resolve, 300));
  const beforeWheel = await sessions[0].page.evaluate(() => window.camera.position.toArray());
  await clients[0].evaluate(() => video.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true })));
  await sessions[0].page.waitForFunction(before => window.camera.position.z < before[2], {}, beforeWheel);
  await new Promise(resolve => setTimeout(resolve, 300));
  const afterWheel = await sessions[0].page.evaluate(() => window.camera.position.toArray());
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(await sessions[0].page.evaluate(() => window.camera.position.toArray()), afterWheel);
  assert.equal(afterWheel[1], beforeWheel[1]);
  assert.deepEqual(await sessions[1].page.evaluate(() => window.camera.position.toArray()), positions[1]);
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

test('input batching stays bounded during a stalled RPC and cleans up on close', { timeout: 30000 }, async t => {
  const viewer = await start({ port: 0 });
  t.after(() => viewer.close());
  const response = await fetch(`${viewer.origin}/session`, {
    method: 'POST', headers: { Origin: viewer.origin, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const session = [...viewer.sessions.values()][0];
  const socket = new WebSocket(viewer.origin.replace('http:', 'ws:') + '/signal', {
    origin: viewer.origin, headers: { Cookie: response.headers.get('set-cookie').split(';')[0] },
  });
  t.after(() => socket.terminate());
  const messages = [];
  let firstStats;
  const diagnosticsReady = new Promise(resolve => { firstStats = resolve; });
  await new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('message', data => {
      if (typeof data !== 'object' || data[0] !== 123) return;
      const message = JSON.parse(data.toString());
      messages.push(message);
      if (message.type === 'stats') firstStats();
      if (message.type === 'error') reject(new Error(message.message));
      if (message.type === 'offer') resolve();
    });
  });
  await diagnosticsReady;
  socket.send(JSON.stringify({ type: 'pause', paused: false }));
  await session.page.waitForFunction(() => window.inputEpoch === 1);
  const evaluate = session.page.evaluate.bind(session.page);
  const calls = [];
  let release;
  const stalled = new Promise(resolve => { release = resolve; });
  let firstCall;
  const started = new Promise(resolve => { firstCall = resolve; });
  session.page.evaluate = async (fn, ...args) => {
    if (fn.toString().includes('window.setInput')) {
      calls.push(args[0]);
      if (calls.length === 1) { firstCall(); await stalled; }
    }
    return evaluate(fn, ...args);
  };
  t.after(release);
  socket.send(JSON.stringify({ type: 'input', forward: true, x: 2, y: 3 }));
  await started;
  for (let i = 0; i < 10; i++) {
    socket.send(JSON.stringify({ type: 'input', up: true, x: 1, y: -1, wheel: -2 }));
  }
  socket.send(JSON.stringify({ type: 'input', down: true, boost: true, x: 4, y: 2, wheel: -3 }));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(calls.length, 1, 'No concurrent input RPCs while renderer is stalled');
  release();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(calls.length, 2, 'Only the latest pending state is sent');
  assert.deepEqual(calls[1], {
    forward: false, backward: false, left: false, right: false, up: false, down: true,
    boost: true, reset: false, x: 14, y: -8, wheel: -23,
  });
  socket.send(JSON.stringify({ type: 'input', boost: 'true', wheel: 1e300, x: 'bad', y: null }));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(calls[2].boost, false);
  assert.equal(calls[2].wheel, 500);
  assert.equal(calls[2].x, 0);
  assert.equal(calls[2].y, 0);
  socket.send(JSON.stringify({ type: 'input', wheel: 'bad', reset: true }));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(calls[3].wheel, 0);
  assert.equal(calls[3].reset, true);
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(calls.length, 4, 'Mouse/wheel deltas are not replayed without fresh input');
  const stats = messages.find(message => message.type === 'stats' && message.inputLatency !== null);
  assert.ok(stats);
  assert.ok(Number.isFinite(stats.fps) && stats.fps > 0);
  assert.ok(Number.isFinite(stats.renderTime) && stats.renderTime >= 0);
  assert.ok(Number.isFinite(stats.inputLatency) && stats.inputLatency >= 0);
  assert.deepEqual(stats.gpu, await evaluate(() => window.getGPUInfo()));
  assert.ok(messages.some(message => message.type === 'stats' && message.inputLatency === null));
  const beforePause = await evaluate(() => window.camera.position.toArray());
  let releaseLate;
  const late = new Promise(resolve => { releaseLate = resolve; });
  let lateStarted;
  const lateReady = new Promise(resolve => { lateStarted = resolve; });
  session.page.evaluate = async (fn, ...args) => {
    if (fn.toString().includes('window.setInput')) { lateStarted(); await late; }
    return evaluate(fn, ...args);
  };
  t.after(() => releaseLate());
  socket.send(JSON.stringify({ type: 'input', forward: true, wheel: -100 }));
  await lateReady;
  socket.send(JSON.stringify({ type: 'input', forward: true, wheel: -100 }));
  socket.send(JSON.stringify({ type: 'pause', paused: true }));
  await session.page.waitForFunction(() => window.inputEpoch === 2);
  socket.send(JSON.stringify({ type: 'input', forward: true, wheel: -100 }));
  releaseLate();
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(await evaluate(() => window.camera.position.toArray()), beforePause,
    'Pause drops queued movement and rejects late in-flight input');
  session.page.evaluate = evaluate;
  socket.send(JSON.stringify({ type: 'measure', action: 'start', requestId: 1 }));
  socket.send(JSON.stringify({ type: 'measure', action: 'pick', requestId: 2, x: 0.5, y: 0.5 }));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(messages.some(message => message.type === 'measurement' && message.requestId === 2 && message.status === 'second'));
  socket.send(JSON.stringify({ type: 'measure', action: 'clear', requestId: 3 }));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.ok(messages.some(message => message.type === 'measurement' && message.requestId === 3 && message.status === 'first'));
  socket.send(JSON.stringify({ type: 'measure', action: 'pick', requestId: 4, x: 2, y: 0.5 }));
  await new Promise(resolve => socket.once('close', (code) => { assert.equal(code, 1008); resolve(); }));
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(viewer.sessions.size, 0);
  assert.ok(session.syncInterval._destroyed);
  assert.ok(session.rateTimer._destroyed);
});

test('private model rejects remote peers and revokes replaced session tokens', { timeout: 120000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'private-endpoint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const modelPath = path.join(directory, 'model.glb');
  await convert(path.join(__dirname, 'fixtures/wall.ifc.txt'), modelPath);
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
  assert.equal(await (await fetch(localOrigin + route, { headers: { Range: 'bytes=0-3' } })).text(), 'glTF');
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

test('specific network binding still gives the renderer loopback model access', { timeout: 120000 }, async t => {
  const remote = Object.values(os.networkInterfaces()).flat()
    .find(address => address.family === 'IPv4' && !address.internal);
  if (!remote) return t.skip('No non-loopback IPv4 interface available');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'private-binding-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const modelPath = path.join(directory, 'model.glb');
  await convert(path.join(__dirname, 'fixtures/wall.ifc.txt'), modelPath);
  const viewer = await start({ host: remote.address, port: 0, origin: 'https://viewer.example.com',
    password: 'test-password', modelPath });
  t.after(() => viewer.close());
  const origin = `http://${remote.address}:${viewer.server.address().port}`;
  const response = await fetch(`${origin}/session`, {
    method: 'POST', headers: { Origin: viewer.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'test-password' }),
  });
  assert.equal(response.status, 200);
  const session = [...viewer.sessions.values()][0];
  const socket = new WebSocket(origin.replace('http:', 'ws:') + '/signal', {
    origin: viewer.origin, headers: { Cookie: response.headers.get('set-cookie').split(';')[0] },
  });
  t.after(() => socket.close());
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Model load timed out')), 30000);
    t.after(() => clearTimeout(timer));
    socket.on('error', reject);
    socket.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.type === 'error') reject(new Error(message.message));
      if (message.type === 'offer') { clearTimeout(timer); resolve(); }
    });
  });
  assert.equal(new URL(session.page.url()).hostname, '127.0.0.1');
  assert.notDeepEqual(await session.page.evaluate(() => window.camera.position.toArray()), [0, 2, 12]);
  assert.equal((await fetch(`${origin}/private-model?token=${session.modelToken}`)).status, 404);
});

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
  await assert.rejects(convert(fixture, modelPath), /EEXIST/);
  await assert.rejects(convert(fixture, path.join(__dirname, '../public/private.glb')), /outside public/);
  await assert.rejects(start({ host: '0.0.0.0', password: '', port: 0 }), /External hosting requires/);
  await assert.rejects(start({ modelPath: path.join(__dirname, '../public/client.js'), port: 0 }), /outside public/);

  const viewer = await start({ port: 0, password: 'test-password', modelPath });
  const contexts = [];
  t.after(async () => {
    await Promise.all(contexts.map(context => context.close()));
    await viewer.close();
  });
  for (const route of ['/model.glb', '/model.ifc', '/renderer/renderer.js', '/node_modules/three/build/three.module.js', '/server.js', '/private/wall.glb']) {
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
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');
let THREE;
test.before(async () => { THREE = await import('three'); });

test('initial perspective fit contains all bounds with tighter framing', async () => {
  const { frameBounds } = await import('../renderer/navigation.mjs');
  for (const dimensions of [[4, 4, 4], [100, 2, 2], [2, 100, 2], [2, 2, 100],
    [1e-10, 2e-10, 1e-10], [1e-5, 2e-5, 1e-5], [1e6, 2e6, 1e6],
    [4, 4, 0], [0, 0, 4], [0, 0, 0]]) {
    for (const aspect of [16 / 9, 0.5]) {
      const camera = new THREE.PerspectiveCamera(70, aspect, 0.05, 10000);
      const center = new THREE.Vector3(3, -2, 7);
      const half = new THREE.Vector3(...dimensions).multiplyScalar(0.5);
      const box = new THREE.Box3(center.clone().sub(half), center.clone().add(half));
      const scale = frameBounds(camera, box);
      assert.ok(scale > 0 && Number.isFinite(scale));
      assert.ok(camera.position.z > box.max.z, 'Starts outside the bounds');
      camera.updateMatrixWorld();
      for (const x of [box.min.x, box.max.x]) {
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            const projected = new THREE.Vector3(x, y, z).project(camera);
            assert.ok(Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1);
            assert.ok(projected.z > -1 && projected.z < 1, 'No near/far clipping');
          }
        }
      }
      if (aspect === 16 / 9 && dimensions[0] === 4 && dimensions[1] === 4) {
        assert.ok(camera.position.distanceTo(center) < new THREE.Vector3(...dimensions).length());
      }
    }
  }
  const camera = new THREE.PerspectiveCamera(70, 16 / 9);
  assert.equal(frameBounds(camera, new THREE.Box3()), 4);
  assert.ok(camera.position.toArray().every(Number.isFinite));
});

test('time-based Shift ramp, cap, release/stop/stale/reset and independent navigation', async () => {
  const { createNavigation } = await import('../renderer/navigation.mjs');
  const run = (boost, backward = false, step = 0.05) => {
    const camera = new THREE.PerspectiveCamera();
    const nav = createNavigation(camera);
    for (let i = 0; i < Math.round(5 / step); i++) {
      const now = i * step * 1000;
      nav.setInput({ forward: !backward, backward, boost }, now);
      nav.update(now, step);
    }
    return { camera, nav };
  };
  const normal = run(false);
  const boosted = run(true);
  assert.ok(boosted.camera.position.z < normal.camera.position.z * 2);
  assert.equal(boosted.nav.boost, 8);
  assert.equal(run(true, true).camera.position.z, -boosted.camera.position.z);
  assert.ok(Math.abs(run(true, false, 0.025).camera.position.z - boosted.camera.position.z) < 0.01);
  assert.equal(normal.nav.boost, 1);
  const nav = boosted.nav;
  nav.setInput({ forward: true }, 5000);
  assert.equal(nav.boost, 1);
  nav.setInput({ forward: true, boost: true }, 5050);
  nav.update(5050, 0.1);
  assert.ok(nav.boost > 1);
  nav.setInput({ boost: true }, 5100);
  assert.equal(nav.boost, 1);
  nav.setInput({ forward: true, boost: true }, 5150);
  nav.update(5150, 0.1);
  const position = boosted.camera.position.clone();
  nav.update(5400, 0.1);
  assert.equal(nav.boost, 1);
  assert.deepEqual(boosted.camera.position, position);
  nav.setInput({ forward: true, boost: true }, 5500);
  nav.update(5500, 0.1);
  nav.setInput({ reset: true }, 5550);
  assert.equal(nav.boost, 1);
  const independent = createNavigation(new THREE.PerspectiveCamera());
  assert.equal(independent.boost, 1);
  const large = new THREE.PerspectiveCamera();
  const largeNav = createNavigation(large, 1000);
  largeNav.setInput({ forward: true }, 0);
  largeNav.update(0, 0.1);
  assert.equal(large.position.z, -50);
});

test('wheel dolly follows pitch/yaw, is bounded, coalesced, consumed once and reset', async () => {
  const { createNavigation } = await import('../renderer/navigation.mjs');
  const camera = new THREE.PerspectiveCamera();
  camera.rotation.order = 'YXZ';
  camera.rotation.set(0.4, Math.PI / 2, 0);
  const nav = createNavigation(camera);
  const facing = camera.getWorldDirection(new THREE.Vector3());
  const rotation = camera.rotation.clone();
  nav.setInput({ wheel: -40 }, 0);
  nav.setInput({ wheel: -60 }, 10);
  nav.update(10, 0.03);
  assert.ok(camera.position.distanceTo(facing.clone().multiplyScalar(0.4)) < 1e-12);
  assert.deepEqual(camera.rotation.toArray(), rotation.toArray(), 'Omitted look fields preserve orientation');
  const position = camera.position.clone();
  nav.update(50, 0.04);
  assert.deepEqual(camera.position, position);
  nav.setInput({ wheel: 100 }, 60);
  nav.update(60, 0.01);
  assert.ok(camera.position.length() < 1e-12);
  nav.setInput({ wheel: -Number.MAX_VALUE, boost: true }, 70);
  nav.update(70, 0.01);
  assert.ok(Math.abs(camera.position.length() - 2) < 1e-12, 'Extreme boosted dolly capped at half model scale');
  nav.setInput({ wheel: NaN, x: Infinity, y: NaN }, 80);
  nav.update(80, 0.01);
  assert.ok(camera.position.toArray().every(Number.isFinite));
  assert.deepEqual(camera.rotation.toArray(), rotation.toArray());
  nav.setInput({ wheel: -100 }, 90);
  nav.setInput({ reset: true }, 100);
  const cleared = camera.position.clone();
  nav.update(100, 0.01);
  assert.deepEqual(camera.position, cleared);
  nav.setInput({ wheel: -100 }, 110);
  nav.update(360, 0.1);
  assert.deepEqual(camera.position, cleared);
});

test('client maps Q/E and Shift and normalizes/clears one-shot viewer wheel input', async () => {
  const listeners = new Map();
  const target = name => ({
    hidden: false, clientHeight: 720,
    classList: { add() {}, remove() {} },
    setAttribute() {}, focus() {},
    addEventListener: (event, fn) => listeners.set(`${name}:${event}`, fn),
    removeEventListener() {},
  });
  const video = target('video');
  const form = target('login');
  const document = { getElementById: id => id === 'video' ? video : id === 'login' ? form : target(id),
    exitPointerLock() { document.pointerLockElement = null; },
    addEventListener: (event, fn) => listeners.set(`document:${event}`, fn) };
  const sent = [];
  let tick;
  class Socket {
    static OPEN = 1;
    readyState = 1;
    send(value) { sent.push(JSON.parse(value)); }
    close() {}
  }
  const context = vm.createContext({ document, window: target('window'), WebSocket: { OPEN: 1 },
    clearInterval() {}, setTimeout() {}, clearTimeout() {}, AbortController, URL, console });
  vm.runInContext(await fs.readFile(require.resolve('../public/client.js'), 'utf8'), context);
  context.sent = sent;
  vm.runInContext('socket = { readyState: 1, send: value => sent.push(JSON.parse(value)), close() {} };', context);
  const wheel = (deltaY, deltaMode = 0) => {
    let prevented = false;
    listeners.get('video:wheel')({ deltaY, deltaMode, preventDefault() { prevented = true; } });
    return prevented;
  };
  assert.equal(wheel(-100), false, 'Inactive viewer leaves page scrolling alone');
  form.hidden = true;
  document.pointerLockElement = video;
  vm.runInContext('paused = false; sessionState = "viewing"', context);
  assert.equal(wheel(-10), true);
  wheel(-2, 1);
  assert.equal(vm.runInContext('wheel', context), -42);
  wheel(1, 2);
  assert.equal(vm.runInContext('wheel', context), 458);
  wheel(10000);
  wheel(NaN);
  wheel(Infinity);
  assert.equal(vm.runInContext('wheel', context), 500);
  listeners.get('window:blur')();
  assert.equal(vm.runInContext('wheel', context), 0);
  assert.equal(JSON.stringify(sent.pop()), '{"type":"pause","paused":true}');
  assert.equal(JSON.stringify(sent.pop()), '{"type":"input","reset":true}');
  document.pointerLockElement = video;
  vm.runInContext('paused = false', context);
  for (const code of ['KeyQ', 'KeyE', 'ShiftLeft', 'ArrowUp']) {
    let prevented = false;
    listeners.get('document:keydown')({ code, preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  assert.equal(vm.runInContext('keys.size', context), 4);
  wheel(-10);
  listeners.get('document:pointerlockchange')();
  assert.equal(vm.runInContext('wheel + keys.size', context), 0);
  Object.assign(context, {
    WebSocket: Socket, RTCPeerConnection: class { close() {} },
    fetch: async () => ({ ok: true, json: async () => ({ iceServers: [] }) }),
    location: { protocol: 'http:', host: 'localhost' },
    setInterval: fn => { tick = fn; },
  });
  video.removeAttribute = () => {};
  await listeners.get('login:submit')({ preventDefault() {} });
  document.pointerLockElement = video;
  vm.runInContext('paused = false; sessionState = "viewing"', context);
  for (const code of ['ShiftLeft', 'ArrowUp', 'KeyE']) {
    listeners.get('document:keydown')({ code, preventDefault() {} });
  }
  wheel(-20);
  tick();
  const first = sent.pop();
  assert.equal(first.forward, true);
  assert.equal(first.boost, true);
  assert.equal(first.up, true);
  assert.equal(first.down, false);
  assert.equal(first.wheel, -20);
  tick();
  assert.equal(sent.pop().wheel, 0, 'Wheel sent once rather than held');
  for (const code of ['ArrowUp', 'KeyE']) listeners.get('document:keyup')({ code });
  for (const code of ['KeyS', 'KeyQ']) listeners.get('document:keydown')({ code, preventDefault() {} });
  tick();
  const backward = sent.pop();
  assert.equal(backward.backward, true);
  assert.equal(backward.boost, true);
  assert.equal(backward.down, true);
  assert.equal(backward.up, false);
  wheel(-40);
  vm.runInContext('disconnect()', context);
  assert.equal(vm.runInContext('wheel + mouseX + mouseY + keys.size', context), 0);
});

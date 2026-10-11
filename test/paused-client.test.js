const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');

async function client() {
  const listeners = new Map();
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, textContent: '', checked: false, videoWidth: 1280, videoHeight: 720,
      addEventListener: (event, fn) => listeners.set(`${id}:${event}`, fn),
      setAttribute() {}, removeAttribute() {}, focus() {}, play: async () => {},
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 1000, height: 1000 }),
    });
    return elements.get(id);
  };
  const video = element('video');
  let locks = 0;
  video.requestPointerLock = () => { locks++; };
  const document = { getElementById: element,
    addEventListener: (event, fn) => listeners.set(`document:${event}`, fn),
    exitPointerLock() { document.pointerLockElement = null; },
  };
  const sent = [];
  const context = vm.createContext({
    document, window: element('window'), URL, WebSocket: { OPEN: 1 },
    clearInterval() {},
  });
  vm.runInContext(await fs.readFile(require.resolve('../public/client.js'), 'utf8'), context);
  context.sent = sent;
  vm.runInContext('socket = { readyState: 1, send: value => sent.push(JSON.parse(value)), close() {} }; form.hidden = true; rendererReady = true;', context);
  return { context, sent, video, document, element, locks: () => locks,
    fire: (target, event, value = {}) => listeners.get(`${target}:${event}`)(value),
    run: code => vm.runInContext(code, context) };
}

test('Escape, unlock and blur neutralize input and require explicit resume', async () => {
  const c = await client();
  c.document.pointerLockElement = c.video;
  c.run('paused = false');
  c.fire('document', 'keydown', { code: 'KeyW', preventDefault() {} });
  c.fire('document', 'mousemove', { movementX: 20, movementY: 30 });
  c.fire('document', 'keydown', { code: 'Escape' });
  assert.equal(c.run('keys.size + mouseX + mouseY + wheel'), 0);
  assert.deepEqual(JSON.parse(JSON.stringify(c.sent.slice(-2))),
    [{ type: 'input', reset: true }, { type: 'pause', paused: true }]);
  c.fire('document', 'keydown', { code: 'KeyW', preventDefault() {} });
  assert.equal(c.run('keys.size'), 0);
  c.fire('resume', 'click');
  assert.equal(c.locks(), 1);
  assert.equal(c.run('paused'), true, 'Do not resume until lock succeeds');
  c.document.pointerLockElement = c.video;
  c.fire('document', 'pointerlockchange');
  assert.equal(c.run('paused'), false);
  c.fire('document', 'keydown', { code: 'KeyW', repeat: true, preventDefault() {} });
  assert.equal(c.run('keys.size'), 0, 'Held key repeat cannot restart movement');
  c.fire('window', 'blur');
  assert.equal(c.run('paused'), true);
  c.fire('document', 'pointerlockchange');
  assert.equal(c.run('paused'), true);
  c.run('disconnect()');
  assert.equal(c.element('pausePanel').hidden, true);
});

test('measurement clicks map contained video pixels and never request pointer lock', async () => {
  const c = await client();
  c.fire('measure', 'click');
  c.fire('video', 'click', { clientX: 510, clientY: 520 });
  const pick = c.sent.at(-1);
  assert.equal(pick.action, 'pick');
  assert.equal(pick.x, 0.5);
  assert.equal(pick.y, 0.5);
  assert.equal(c.locks(), 0);
  c.fire('video', 'click', { clientX: 600, clientY: 600 });
  assert.equal(c.sent.at(-1), pick, 'Only one pick in flight');
  c.fire('clearMeasurement', 'click');
  assert.ok(c.sent.at(-1).requestId > pick.requestId);
  c.fire('video', 'click', { clientX: 510, clientY: 30 });
  assert.equal(c.sent.at(-1).action, 'clear', 'Letterbox click rejected');
  c.video.getBoundingClientRect = () => ({ left: 0, top: 0, width: 640, height: 360 });
  c.fire('video', 'click', { clientX: 160, clientY: 270 });
  assert.equal(c.sent.at(-1).x, 0.25);
  assert.equal(c.sent.at(-1).y, 0.75);
  c.fire('cancelMeasurement', 'click');
  assert.equal(c.run('measuring'), false);
  assert.equal(c.run('paused'), true);
  assert.equal(c.locks(), 0);
});

test('late measurement responses cannot repopulate cleared or disconnected state', async () => {
  const c = await client();
  Object.assign(c.context, {
    fetch: async () => ({ ok: true, json: async () => ({ iceServers: [] }) }),
    RTCPeerConnection: class { close() {} },
    location: { protocol: 'http:', host: 'localhost' },
    setInterval() {},
    WebSocket: class {
      static OPEN = 1;
      readyState = 1;
      send(value) { c.sent.push(JSON.parse(value)); }
      close() {}
    },
  });
  await c.fire('login', 'submit', { preventDefault() {} });
  const socket = c.run('socket');
  async function receive(message) {
    socket.onmessage({ data: JSON.stringify(message) });
    await new Promise(resolve => setImmediate(resolve));
  }
  await receive({ type: 'ready' });
  c.fire('measure', 'click');
  c.fire('video', 'click', { clientX: 510, clientY: 520 });
  const old = c.sent.at(-1).requestId;
  c.fire('clearMeasurement', 'click');
  await receive({ type: 'measurement', requestId: old, status: 'complete', distance: 123 });
  assert.equal(c.element('measurementStatus').textContent, 'Click the first model surface point.');
  await receive({ type: 'measurement', requestId: c.sent.at(-1).requestId, status: 'first' });
  c.fire('video', 'click', { clientX: 510, clientY: 520 });
  const current = c.sent.at(-1).requestId;
  await receive({ type: 'measurement', requestId: current, status: 'no-hit' });
  assert.match(c.element('measurementStatus').textContent, /No model surface/);
  c.run('disconnect()');
  await receive({ type: 'measurement', requestId: current, status: 'complete', distance: 123 });
  assert.equal(c.element('measurementStatus').textContent, '');
});

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
      value: '', paused: false, readyState: 2, attributes: {},
      classList: { add() {}, remove() {} },
      addEventListener: (event, fn) => listeners.set(`${id}:${event}`, fn),
      removeEventListener: (event, fn) => {
        if (listeners.get(`${id}:${event}`) === fn) listeners.delete(`${id}:${event}`);
      },
      replaceChildren(...children) { this.options = children; this.value = children[0]?.value || ''; },
      setAttribute(name, value) { this.attributes[name] = value; },
      removeAttribute() {}, focus() {}, play: async () => {},
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
    clearInterval() {}, setTimeout() {}, clearTimeout() {}, AbortController,
  });
  vm.runInContext(await fs.readFile(require.resolve('../public/client.js'), 'utf8'), context);
  context.sent = sent;
  vm.runInContext('socket = { readyState: 1, send: value => sent.push(JSON.parse(value)), close() {} }; form.hidden = true; rendererReady = true; sessionState = "viewing";', context);
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

test('pointer lock failure and late lock acquisition leave navigation paused', async () => {
  const c = await client();
  c.video.requestPointerLock = () => Promise.reject(new Error('Denied'));
  c.fire('resume', 'click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.run('paused'), true);
  assert.match(c.element('connectionStatus').textContent, /Mouse lock unavailable/);
  c.video.requestPointerLock = () => {};
  c.fire('resume', 'click');
  c.fire('window', 'blur');
  c.document.pointerLockElement = c.video;
  c.fire('document', 'pointerlockchange');
  assert.equal(c.run('paused'), true);
  assert.equal(c.document.pointerLockElement, null);
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
  c.fire('video', 'playing');
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

  async function connectingClient() {
    const c = await client();
    const requests = [];
    Object.assign(c.context, {
      fetch: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return { ok: true, json: async () => ({ iceServers: [] }) };
      },
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
    c.element('model').value = 'selected-model';
    await c.fire('login', 'submit', { preventDefault() {} });
    c.requests = requests;
    c.receive = async (message, socket = c.run('socket')) => {
      socket.onmessage({ data: JSON.stringify(message) });
      await new Promise(resolve => setImmediate(resolve));
    };
    return c;
  }

  test('setup waits for renderer and decoded playback; duplicate submits and stats do not hide or reveal panels', async () => {
    const c = await connectingClient();
    assert.equal(c.requests[0].body.modelId, 'selected-model');
    assert.equal(c.element('login').hidden, false);
    assert.equal(c.element('startViewing').disabled, true);
    await c.fire('login', 'submit', { preventDefault() {} });
    assert.equal(c.requests.length, 1);
    c.video.requestVideoFrameCallback = callback => { c.frame = callback; return 1; };
    c.fire('video', 'playing');
    await c.receive({ type: 'ready' });
    assert.equal(c.element('login').hidden, false);
    c.frame();
    assert.equal(c.element('login').hidden, true);
    assert.equal(c.element('setupPanel').hidden, true);
    assert.equal(c.element('controlsHelp').hidden, true);
    assert.equal(c.element('pausePanel').hidden, true);
    assert.equal(c.element('toolbar').hidden, false);
    assert.equal(c.locks(), 0, 'Readiness must never request pointer lock');
    await c.receive({ type: 'stats', fps: 30, renderTime: 5, inputLatency: null, gpu: { vendor: 'test', renderer: 'test' } });
    assert.equal(c.element('diagnostics').hidden, true);
    c.fire('document', 'keydown', { code: 'Escape' });
    assert.equal(c.element('pausePanel').hidden, false);
    assert.equal(c.element('login').hidden, true);
    c.fire('showDiagnostics', 'click');
    assert.equal(c.element('diagnostics').hidden, false);
  });

  test('toolbar commands are mutually exclusive and measurement pauses without locking', async () => {
    const c = await client();
    c.fire('wireframeTool', 'click');
    assert.deepEqual(JSON.parse(JSON.stringify(c.sent.at(-1))), { type: 'wireframe', enabled: true });
    assert.equal(c.element('wireframeTool').attributes['aria-pressed'], 'true');
    assert.equal(c.element('solid').attributes['aria-pressed'], 'false');
    c.fire('solid', 'click');
    assert.deepEqual(JSON.parse(JSON.stringify(c.sent.at(-1))), { type: 'wireframe', enabled: false });
    assert.equal(c.element('wireframeTool').attributes['aria-pressed'], 'false');
    c.fire('measure', 'click');
    assert.equal(c.sent.at(-1).action, 'start');
    assert.equal(c.element('measure').attributes['aria-pressed'], 'true');
    assert.equal(c.locks(), 0);
    c.run('disconnect()');
    assert.equal(c.element('solid').attributes['aria-pressed'], 'true');
    assert.equal(c.element('measure').attributes['aria-pressed'], 'false');
    assert.equal(c.element('toolbar').hidden, true);
  });

  test('fallback requires playback and failures restore setup; stale transport and frame callbacks are ignored', async () => {
    const c = await connectingClient();
    const oldSocket = c.run('socket');
    const oldPeer = c.run('peer');
    c.video.requestVideoFrameCallback = callback => { c.frame = callback; return 1; };
    c.fire('video', 'playing');
    const staleFrame = c.frame;
    c.run('disconnect()');
    oldPeer.ontrack({ streams: ['stale'] });
    oldSocket.onerror();
    staleFrame();
    assert.equal(c.element('login').hidden, false);
    assert.equal(c.video.srcObject, null);
    await c.fire('login', 'submit', { preventDefault() {} });
    class MediaSource {
      static isTypeSupported() { return true; }
      addEventListener() {}
    }
    c.context.MediaSource = MediaSource;
    c.element('window').MediaSource = MediaSource;
    c.context.URL = { createObjectURL: () => 'blob:test', revokeObjectURL() {} };
    await c.receive({ type: 'fallback', mimeType: 'video/webm' });
    await c.receive({ type: 'ready' });
    assert.equal(c.element('login').hidden, false);
    c.fire('video', 'playing');
    c.frame();
    assert.equal(c.element('login').hidden, true);
    c.run('socket').onclose();
    assert.equal(c.element('login').hidden, false);
    assert.equal(c.element('startViewing').disabled, false);
    await c.fire('login', 'submit', { preventDefault() {} });
    await c.receive({ type: 'error', message: 'Invalid model' });
    assert.equal(c.element('login').hidden, false);
    assert.match(c.element('connectionStatus').textContent, /Invalid model/);
  });

  test('model discovery uses password and displays catalog or useful errors', async () => {
    const c = await client();
    c.context.Option = function(name, value) { this.text = name; this.value = value; };
    c.element('password').value = 'test-password';
    c.context.fetch = async (url, options) => {
      assert.equal(url, '/models');
      assert.equal(JSON.parse(options.body).password, 'test-password');
      return { ok: true, json: async () => ({ models: [{ id: 'default', name: 'Demo scene' }, { id: 'opaque', name: 'wall.glb' }] }) };
    };
    await c.fire('loadModels', 'click');
    assert.equal(c.element('model').options[1].value, 'opaque');
    assert.equal(c.element('model').disabled, false);
    c.context.fetch = async () => ({ ok: false, status: 401 });
    await c.fire('loadModels', 'click');
    assert.match(c.element('modelStatus').textContent, /correct password/);
  });

test('request timeout and stale session responses leave setup usable', async () => {
  const c = await connectingClient();
  c.run('disconnect()');
  let timeout;
  let resolveFetch;
  c.context.setTimeout = callback => { timeout = callback; return 1; };
  c.context.fetch = () => new Promise(resolve => { resolveFetch = resolve; });
  const submission = c.fire('login', 'submit', { preventDefault() {} });
  timeout();
  assert.equal(c.element('login').hidden, false);
  assert.equal(c.element('startViewing').disabled, false);
  assert.match(c.element('connectionStatus').textContent, /timed out/);
  resolveFetch({ ok: true, json: async () => ({ iceServers: [] }) });
  await submission;
  assert.equal(c.run('sessionState'), 'setup');
  assert.equal(c.element('toolbar').hidden, true);
});

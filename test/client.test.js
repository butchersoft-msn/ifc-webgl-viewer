const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');

async function client() {
  const listeners = new Map();
  const target = name => ({
    addEventListener(type, handler) { listeners.set(`${name}:${type}`, handler); },
  });
  const video = { ...target('video'), removeAttribute() {}, play: async () => {} };
  const form = { ...target('form'), hidden: false };
  const document = {
    ...target('document'),
    getElementById: id => ({ video, login: form, password: { value: '' }, connectionStatus: {} })[id],
  };
  const messages = [];
  let tick;
  let socket;
  const context = vm.createContext({
    document,
    window: target('window'),
    location: { protocol: 'http:', host: 'localhost' },
    fetch: async () => ({ ok: true, json: async () => ({ iceServers: [] }) }),
    RTCPeerConnection: class { close() {} },
    WebSocket: class {
      static OPEN = 1;
      readyState = 1;
      constructor() { socket = this; }
      send(message) { messages.push(JSON.parse(message)); }
      close() {}
    },
    setInterval: handler => { tick = handler; },
    clearInterval() { tick = undefined; },
  });
  vm.runInContext(await fs.readFile(path.join(__dirname, '../public/client.js'), 'utf8'), context);
  const dispatch = (name, type, code, values = {}) => listeners.get(`${name}:${type}`)({ code, preventDefault() {}, ...values });
  await dispatch('form', 'submit');
  return {
    press: code => dispatch('document', 'keydown', code),
    release: code => dispatch('document', 'keyup', code),
    dispatch,
    input: () => { tick(); return messages.at(-1); },
    disconnect: () => socket.onclose(),
    reconnect: () => dispatch('form', 'submit'),
    document,
    video,
  };
}

test('Shift remaps only vertical arrows and persists until both Shift keys are released', async () => {
  const controls = await client();
  controls.press('ArrowUp');
  assert.equal(controls.input().forward, true);
  assert.equal(controls.input().up, false);
  controls.press('ShiftLeft');
  assert.equal(controls.input().forward, false);
  assert.equal(controls.input().up, true);
  controls.press('ArrowLeft');
  controls.press('ArrowRight');
  controls.press('KeyW');
  controls.press('KeyS');
  const combined = controls.input();
  for (const flag of ['forward', 'backward', 'left', 'right', 'up']) assert.equal(combined[flag], true);
  for (const key of ['ArrowLeft', 'ArrowRight', 'KeyW', 'KeyS']) controls.release(key);
  controls.press('ShiftRight');
  controls.release('ShiftLeft');
  assert.equal(controls.input().up, true);
  controls.release('ArrowUp');
  controls.press('ArrowDown');
  assert.equal(controls.input().down, true);
  assert.equal(controls.input().backward, false);
  controls.release('ShiftRight');
  assert.equal(controls.input().down, false);
  assert.equal(controls.input().backward, true);
});

test('blur, pointer lock changes, and disconnect reset Shift and movement', async () => {
  const controls = await client();
  for (const reset of [
    () => controls.dispatch('window', 'blur'),
    () => controls.dispatch('document', 'pointerlockchange'),
    async () => { controls.disconnect(); await controls.reconnect(); },
  ]) {
    controls.press('ShiftLeft');
    controls.press('ShiftRight');
    controls.press('ArrowUp');
    assert.equal(controls.input().up, true);
    await reset();
    const stopped = controls.input();
    for (const flag of ['forward', 'backward', 'left', 'right', 'up', 'down']) assert.equal(stopped[flag], false);
    controls.press('ArrowUp');
    assert.equal(controls.input().forward, true);
    assert.equal(controls.input().up, false);
    controls.release('ArrowUp');
  }
  controls.document.pointerLockElement = controls.video;
  controls.dispatch('document', 'mousemove', undefined, { movementX: 20, movementY: -10 });
  controls.press('ShiftLeft');
  const look = controls.input();
  assert.equal(look.x, 20);
  assert.equal(look.y, -10);
  assert.equal(controls.input().x, 0);
  assert.equal(controls.input().y, 0);
});

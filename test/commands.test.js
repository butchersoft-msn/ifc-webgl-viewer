const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const puppeteer = require('puppeteer');
const { WebSocket } = require('ws');

test('authenticated commands validate payloads, isolate sessions and invalidate late input', async t => {
  const pages = [];
  const cached = require.cache[require.resolve('puppeteer')];
  t.after(() => { cached.exports = puppeteer; });
  cached.exports = { ...puppeteer, launch: async () => ({
    async newPage() {
      const calls = [];
      const input = [];
      const context = vm.createContext({ window: {
        rendererReady: true, getGPUInfo: () => ({}),
        setInput: value => input.push(value),
        viewerCommand: value => { calls.push(value); },
        startStream: () => {},
      } });
      const page = {
        calls, input, async setViewport() {}, async setRequestInterception() {}, on() {},
        async exposeFunction(name, fn) { context.window[name] = fn; },
        async goto() {}, async waitForFunction() {}, async close() {},
        async evaluate(fn, ...args) {
          context.args = args;
          return vm.runInContext(`(${fn.toString()})(...args)`, context);
        },
      };
      pages.push(page);
      return page;
    },
    async close() {},
  }) };
  const { start } = require('../server');
  const viewer = await start({ port: 0 });
  t.after(() => viewer.close());
  async function connect() {
    const response = await fetch(`${viewer.origin}/session`, {
      method: 'POST', headers: { Origin: viewer.origin, 'Content-Type': 'application/json' }, body: '{}',
    });
    const socket = new WebSocket(viewer.origin.replace('http:', 'ws:') + '/signal', {
      origin: viewer.origin, headers: { Cookie: response.headers.get('set-cookie').split(';')[0] },
    });
    t.after(() => socket.terminate());
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await new Promise(resolve => setTimeout(resolve, 30));
    return socket;
  }
  const first = await connect();
  const second = await connect();
  const send = (socket, message) => socket.send(JSON.stringify(message));
  const wait = () => new Promise(resolve => setTimeout(resolve, 80));
  send(first, { type: 'input', forward: true });
  await wait();
  assert.equal(pages[0].input.length, 0, 'Starts paused');
  send(first, { type: 'wireframe', enabled: true, geometry: 'ignored' });
  send(first, { type: 'measure', action: 'pick', requestId: 1, x: 0.2, y: 0.7, token: 'ignored' });
  await wait();
  assert.equal(JSON.stringify(pages[0].calls[0]), '{"type":"wireframe","enabled":true}');
  assert.equal(JSON.stringify(pages[0].calls[1]), '{"type":"measure","action":"pick","requestId":1,"x":0.2,"y":0.7}');
  assert.equal(pages[1].calls.length, 0);
  send(first, { type: 'pause', paused: false });
  await wait();
  const page = pages[0];
  const evaluate = page.evaluate.bind(page);
  let release;
  let began;
  const started = new Promise(resolve => { began = resolve; });
  const stalled = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  page.evaluate = async (fn, ...args) => {
    if (fn.toString().includes('window.setInput')) { began(); await stalled; }
    return evaluate(fn, ...args);
  };
  send(first, { type: 'input', forward: true, x: 40 });
  await started;
  send(first, { type: 'input', forward: true, wheel: -100 });
  send(first, { type: 'pause', paused: true });
  await wait();
  send(first, { type: 'input', forward: true });
  release();
  await wait();
  assert.equal(page.input.length, 0, 'Old in-flight and pending input discarded');
  page.evaluate = evaluate;
  send(first, { type: 'pause', paused: false });
  await wait();
  send(first, { type: 'input', up: true });
  await wait();
  assert.equal(page.input.length, 1);
  assert.equal(page.input[0].up, true);
  assert.equal(pages[1].input.length, 0);
  send(second, { type: 'wireframe', enabled: 'true' });
  await new Promise(resolve => second.once('close', code => { assert.equal(code, 1008); resolve(); }));
  for (const invalid of [
    { type: 'pause', paused: 1 },
    { type: 'measure', action: 'pick', requestId: 1, x: -0.01, y: 0.5 },
    { type: 'measure', action: 'pick', requestId: 1, x: null, y: 0.5 },
    { type: 'measure', action: 'pick', requestId: 1, x: '0.5', y: 0.5 },
    { type: 'measure', action: 'unknown', requestId: 1 },
    { type: 'measure', action: 'clear', requestId: -1 },
    { type: 'unknown' }, null,
  ]) {
    const socket = await connect();
    send(socket, invalid);
    await new Promise(resolve => socket.once('close', code => { assert.equal(code, 1008); resolve(); }));
  }
});

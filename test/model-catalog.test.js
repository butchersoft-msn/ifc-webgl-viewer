const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const os = require('node:os');
const { randomBytes } = require('node:crypto');
const { WebSocket } = require('ws');
const puppeteer = require('puppeteer');

const cached = require.cache[require.resolve('puppeteer')];
const pages = [];
cached.exports = { ...puppeteer, launch: async () => ({
  async newPage() {
    const context = vm.createContext({ window: {
      rendererReady: true, getGPUInfo: () => ({}),
      startStream: config => { page.config = config; },
    } });
    const page = {
      async setViewport() {}, async setRequestInterception() {},
      on(event, fn) { if (event === 'request') this.intercept = fn; },
      async exposeFunction() {}, async goto(url) { this.origin = new URL(url).origin; },
      async waitForFunction() {}, async close() {},
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
cached.exports = puppeteer;

async function fixture(t, options = {}) {
  const directory = path.join(__dirname, `.catalog-${randomBytes(8).toString('hex')}`);
  await fs.mkdir(directory);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const modelDirectory = path.join(directory, 'models');
  await fs.mkdir(modelDirectory);
  const viewer = await start({ port: 0, password: 'catalog-password', modelPath: '', modelDirectory, ...options });
  t.after(() => viewer.close());
  const post = (route, body = {}, headers = {}) => fetch(viewer.origin + route, {
    method: 'POST',
    headers: { Origin: viewer.origin, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ password: 'catalog-password', ...body }),
  });
  return { directory, modelDirectory, viewer, post };
}
function modelBytes(suffix = '', document = { asset: { version: '2.0' } }) {
  const json = Buffer.from(JSON.stringify(document));
  const padded = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
  const binary = Buffer.from(suffix);
  const paddedBinary = Buffer.concat([binary, Buffer.alloc((4 - binary.length % 4) % 4)]);
  const result = Buffer.alloc(28 + padded.length + paddedBinary.length);
  result.write('glTF');
  result.writeUInt32LE(2, 4);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(result, 20);
  result.writeUInt32LE(paddedBinary.length, 20 + padded.length);
  result.writeUInt32LE(0x004e4942, 24 + padded.length);
  paddedBinary.copy(result, 28 + padded.length);
  return result;
}
async function glb(file, suffix = '') { await fs.writeFile(file, modelBytes(suffix)); }
async function assertModel(response, suffix) {
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), modelBytes(suffix));
}
function cookie(response) { return response.headers.get('set-cookie').split(';')[0]; }
async function connect(t, viewer, response) {
  const socket = new WebSocket(viewer.origin.replace('http:', 'ws:') + '/signal', {
    origin: viewer.origin, headers: { Cookie: cookie(response) },
  });
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => {
    socket.on('error', reject);
    socket.on('message', data => { if (JSON.parse(data).type === 'ready') resolve(); });
  });
  return socket;
}
async function interception(page, url) {
  return new Promise(resolve => page.intercept({
    url: () => url,
    continue: async () => resolve('continue'),
    abort: async () => resolve('abort'),
    respond: async () => resolve('respond'),
  }));
}

test('catalog authenticates independently, discovers fresh opaque IDs, and exposes only display names', async t => {
  const { modelDirectory, directory, viewer, post } = await fixture(t);
  await glb(path.join(modelDirectory, 'B.glb'), 'B');
  await glb(path.join(modelDirectory, 'a.GLB'), 'A');
  await fs.writeFile(path.join(modelDirectory, 'bad.glb'), 'nope');
  await glb(path.join(modelDirectory, 'source.ifc'));
  await fs.symlink(path.join(modelDirectory, 'source.ifc'), path.join(modelDirectory, 'ifc-alias.glb'));
  await fs.mkdir(path.join(modelDirectory, 'nested.glb'));
  const outside = path.join(directory, 'outside.glb');
  await glb(outside);
  await fs.symlink(outside, path.join(modelDirectory, 'escape.glb'));
  await fs.symlink(path.join(modelDirectory, 'B.glb'), path.join(modelDirectory, 'alias.glb'));
  assert.equal((await fetch(viewer.origin + '/models')).status, 404);
  assert.equal((await post('/models', { password: 'wrong' })).status, 401);
  assert.equal((await post('/models', {}, { Origin: 'https://other.invalid' })).status, 403);
  assert.equal((await post('/models', {}, { Origin: '' })).status, 403);
  const response = await post('/models');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('set-cookie'), null);
  const list = await response.json();
  assert.equal(list.defaultModelId, 'default');
  assert.deepEqual(list.models.map(item => item.name), ['Demo scene', 'a.GLB', 'alias.glb', 'B.glb']);
  assert.equal(viewer.sessions.size, 0);
  const malformed = await fetch(viewer.origin + '/models', {
    method: 'POST', headers: { Origin: viewer.origin, 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(malformed.status, 400);
  assert.deepEqual(await malformed.json(), { error: 'Invalid request body' });
  for (const item of list.models) {
    assert.deepEqual(Object.keys(item).sort(), ['id', 'name']);
    if (item.id !== 'default') assert.match(item.id, /^[a-f0-9]{64}$/);
  }
  assert.ok(!JSON.stringify(list).includes(directory));
  await fs.unlink(path.join(modelDirectory, 'a.GLB'));
  await glb(path.join(modelDirectory, 'new.glb'));
  const refreshed = await (await post('/models')).json();
  assert.ok(!refreshed.models.some(item => item.name === 'a.GLB'));
  assert.ok(refreshed.models.some(item => item.name === 'new.glb'));
  assert.equal(refreshed.models.find(item => item.name === 'B.glb').id, list.models.find(item => item.name === 'B.glb').id);
});

test('selection isolates token-bound models and enforces exact renderer requests and revocation', async t => {
  const { modelDirectory, viewer, post } = await fixture(t);
  await glb(path.join(modelDirectory, 'one.glb'), 'one');
  await glb(path.join(modelDirectory, 'two.glb'), 'two');
  const list = await (await post('/models')).json();
  const first = await post('/session', { modelId: list.models[1].id });
  const second = await post('/session', { modelId: list.models[2].id });
  assert.deepEqual(await first.json(), { iceServers: [] });
  await connect(t, viewer, first);
  await connect(t, viewer, second);
  const [one, two] = [...viewer.sessions.values()];
  const route = token => `${viewer.origin}/private-model?token=${token}`;
  await assertModel(await fetch(route(one.modelToken)), 'one');
  await assertModel(await fetch(route(two.modelToken)), 'two');
  assert.notEqual(one.modelToken, two.modelToken);
  for (const session of [one, two]) {
    assert.equal(session.page.config.hasModel, true);
    assert.equal(session.page.config.modelToken, session.modelToken);
    const url = `${session.page.origin}/private-model?token=${session.modelToken}`;
    assert.equal(await interception(session.page, url), 'continue');
    for (const denied of [
      `${url}&extra=1`, `${url}&token=${session.modelToken}`, `${url}#fragment`,
      `${session.page.origin}/private-model?token=${session === one ? two.modelToken : one.modelToken}`,
      `${session.page.origin}/private-model`, `https://other.invalid/private-model?token=${session.modelToken}`,
    ]) assert.equal(await interception(session.page, denied), 'abort');
  }
  for (const suffix of ['&extra=1', `&token=${one.modelToken}`]) {
    assert.equal((await fetch(route(one.modelToken) + suffix)).status, 404);
  }
  const range = await fetch(route(one.modelToken), { headers: { Range: 'bytes=0-3' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-type'), 'model/gltf-binary');
  assert.equal(range.headers.get('cache-control'), 'no-store');
  assert.equal(await range.text(), 'glTF');
  const replacement = await post('/session', {}, { Cookie: cookie(first) });
  assert.equal(replacement.status, 200);
  assert.equal((await fetch(route(one.modelToken))).status, 404);
  const demo = [...viewer.sessions.values()].find(session => session.modelToken === null);
  await connect(t, viewer, replacement);
  assert.equal(demo.page.config.hasModel, false);
  assert.equal(await interception(demo.page, route(two.modelToken)), 'abort');
  assert.equal((await fetch(route(two.modelToken))).status, 200);
  two.timer._onTimeout();
  assert.equal((await fetch(route(two.modelToken))).status, 404);
});

test('malformed and unknown selections cannot replace a valid session or allocate capacity', async t => {
  const { viewer, post } = await fixture(t);
  const active = await post('/session');
  const session = [...viewer.sessions.values()][0];
  for (const modelId of [null, '', 12, [], {}, '../private.glb', 'a'.repeat(64)]) {
    const response = await post('/session', { modelId }, { Cookie: cookie(active) });
    assert.equal(response.status, 400);
    assert.equal(viewer.sessions.size, 1);
    assert.equal([...viewer.sessions.values()][0], session);
    assert.equal(response.headers.get('set-cookie'), null);
  }
  assert.equal((await post('/session', { modelId: 'default' })).status, 200);
});

test('rechecks deletion, magic, escaping symlinks and catalog directory races before replacing a session', async t => {
  const { directory, modelDirectory, viewer, post } = await fixture(t);
  const file = path.join(modelDirectory, 'race.glb');
  const outside = path.join(directory, 'outside.glb');
  await glb(file);
  await glb(outside);
  const list = await (await post('/models')).json();
  const modelId = list.models[1].id;
  const active = await post('/session', { modelId });
  const original = [...viewer.sessions.values()][0];
  await fs.unlink(file);
  assert.equal((await post('/session', { modelId }, { Cookie: cookie(active) })).status, 400);
  await fs.writeFile(file, 'bad!');
  assert.equal((await post('/session', { modelId }, { Cookie: cookie(active) })).status, 400);
  await fs.unlink(file);
  await fs.symlink(outside, file);
  assert.equal((await post('/session', { modelId }, { Cookie: cookie(active) })).status, 400);
  assert.equal((await fetch(`${viewer.origin}/private-model?token=${original.modelToken}`)).status, 404);
  await fs.unlink(file);
  await glb(file);
  assert.equal((await fetch(`${viewer.origin}/private-model?token=${original.modelToken}`)).status, 200);
  await fs.rename(modelDirectory, modelDirectory + '-old');
  await fs.symlink(path.join(__dirname, '../public'), modelDirectory);
  assert.equal((await post('/session', { modelId }, { Cookie: cookie(active) })).status, 400);
  assert.equal((await post('/models')).status, 500);
  assert.equal((await fetch(`${viewer.origin}/private-model?token=${original.modelToken}`)).status, 404);
  assert.equal([...viewer.sessions.values()][0], original);
});

test('public directories and public file symlinks are rejected; missing and broken directories are clear', async t => {
  const { directory, modelDirectory, viewer, post } = await fixture(t);
  const publicDirectory = path.join(__dirname, '../public');
  const publicModel = path.join(publicDirectory, `.catalog-${randomBytes(8).toString('hex')}.glb`);
  await glb(publicModel);
  t.after(() => fs.unlink(publicModel));
  await fs.symlink(publicModel, path.join(modelDirectory, 'public.glb'));
  assert.equal((await (await post('/models')).json()).models.length, 1);
  await assert.rejects(start({ port: 0, modelDirectory: publicDirectory }), /outside public/);
  const alias = path.join(directory, 'public-alias');
  await fs.symlink(publicDirectory, alias);
  await assert.rejects(start({ port: 0, modelDirectory: alias }), /outside public/);
  await assert.rejects(start({ port: 0, modelDirectory: path.join(alias, 'missing') }), /outside public/);
  await fs.rm(modelDirectory, { recursive: true });
  const missing = await (await post('/models')).json();
  assert.equal(missing.models.length, 1);
  assert.match(missing.message, /missing/i);
  await fs.writeFile(modelDirectory, 'not a directory');
  const failed = await post('/models');
  assert.equal(failed.status, 500);
  assert.deepEqual(await failed.json(), { error: 'Unable to discover private models. Check the model directory.' });
  assert.equal((await fetch(viewer.origin + '/private-model')).status, 404);
});

test('MODEL_PATH remains default outside catalog and is revalidated, and MODEL_DIRECTORY is configurable', async t => {
  const directory = path.join(__dirname, `.catalog-env-${randomBytes(8).toString('hex')}`);
  await fs.mkdir(directory);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const defaultPath = path.join(directory, 'legacy.glb');
  const models = path.join(directory, 'catalog');
  await fs.mkdir(models);
  await glb(defaultPath, 'legacy');
  await glb(path.join(models, 'choice.glb'), 'choice');
  const previous = { MODEL_PATH: process.env.MODEL_PATH, MODEL_DIRECTORY: process.env.MODEL_DIRECTORY };
  process.env.MODEL_PATH = defaultPath;
  process.env.MODEL_DIRECTORY = models;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const viewer = await start({ port: 0, password: '' });
  t.after(() => viewer.close());
  const post = (route, body = {}) => fetch(viewer.origin + route, {
    method: 'POST', headers: { Origin: viewer.origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const list = await (await post('/models')).json();
  assert.deepEqual(list.models[0], { id: list.defaultModelId, name: 'legacy.glb' });
  assert.equal(list.models[1].name, 'choice.glb');
  for (const body of [{}, { modelId: list.defaultModelId }]) {
    const response = await post('/session', body);
    assert.equal(response.status, 200);
    const session = [...viewer.sessions.values()].at(-1);
    await assertModel(await fetch(`${viewer.origin}/private-model?token=${session.modelToken}`), 'legacy');
  }
  const response = await post('/session', { modelId: list.models[1].id });
  const session = [...viewer.sessions.values()].at(-1);
  assert.equal(response.status, 200);
  await assertModel(await fetch(`${viewer.origin}/private-model?token=${session.modelToken}`), 'choice');
  await fs.writeFile(defaultPath, 'bad!');
  assert.equal((await post('/session')).status, 400);
});

test('private endpoint rejects non-loopback peers, even with forwarded loopback headers', async t => {
  const remote = Object.values(os.networkInterfaces()).flat()
    .find(address => address.family === 'IPv4' && !address.internal);
  if (!remote) return t.skip('No non-loopback IPv4 interface');
  const { modelDirectory, viewer } = await fixture(t, {
    host: '0.0.0.0', origin: 'https://viewer.example.com',
  });
  await glb(path.join(modelDirectory, 'private.glb'), 'private');
  const local = `http://127.0.0.1:${viewer.server.address().port}`;
  const post = (route, body = {}) => fetch(local + route, {
    method: 'POST', headers: { Origin: viewer.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'catalog-password', ...body }),
  });
  const list = await (await post('/models')).json();
  assert.equal((await post('/session', { modelId: list.models[1].id })).status, 200);
  const session = [...viewer.sessions.values()][0];
  const route = `/private-model?token=${session.modelToken}`;
  assert.equal((await fetch(local + route)).status, 200);
  assert.equal((await fetch(`http://${remote.address}:${viewer.server.address().port}${route}`, {
    headers: { 'X-Forwarded-For': '127.0.0.1' },
  })).status, 404);
});

test('catalog has its own login throttle and leaves the legacy session quota untouched', async t => {
  const { post } = await fixture(t);
  for (let index = 0; index < 10; index++) {
    assert.equal((await post('/models', { password: 'wrong' })).status, 401);
  }
  assert.equal((await post('/models')).status, 429);
  assert.equal((await post('/session')).status, 200);
});

test('discovery I/O failures are sanitized and a symlink swap during validation cannot replace the session', async t => {
  const { directory, modelDirectory, viewer, post } = await fixture(t);
  const file = path.join(modelDirectory, 'swap.glb');
  const outside = path.join(directory, 'outside.glb');
  await glb(file);
  await glb(outside, 'outside');
  const readdir = fs.readdir;
  fs.readdir = async () => { throw Object.assign(new Error(`Secret path: ${directory}`), { code: 'EACCES' }); };
  try {
    const failed = await post('/models');
    assert.equal(failed.status, 500);
    assert.ok(!(await failed.text()).includes(directory));
  } finally { fs.readdir = readdir; }
  const list = await (await post('/models')).json();
  const active = await post('/session');
  const original = [...viewer.sessions.values()][0];
  const open = fs.open;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (args[0] === file) {
      await fs.unlink(file);
      await fs.symlink(outside, file);
    }
    return handle;
  };
  try {
    assert.equal((await post('/session', { modelId: list.models[1].id }, { Cookie: cookie(active) })).status, 400);
  } finally { fs.open = open; }
  assert.equal(viewer.sessions.size, 1);
  assert.equal([...viewer.sessions.values()][0], original);
});

test('GLB validation skips malformed and external assets and rejects changed files before session replacement', async t => {
  const { modelDirectory, viewer, post } = await fixture(t);
  const valid = modelBytes();
  const badLength = Buffer.from(valid);
  badLength.writeUInt32LE(valid.length + 4, 8);
  const badVersion = Buffer.from(valid);
  badVersion.writeUInt32LE(1, 4);
  const badJson = Buffer.from(valid);
  badJson[20] = 0x21;
  const badChunk = Buffer.from(valid);
  badChunk.writeUInt32LE(valid.length, 12);
  const wrongFirst = Buffer.from(valid);
  wrongFirst.writeUInt32LE(0x004e4942, 16);
  const overCap = Buffer.alloc(20 + 16 * 1024 * 1024 + 4);
  overCap.write('glTF');
  overCap.writeUInt32LE(2, 4);
  overCap.writeUInt32LE(overCap.length, 8);
  overCap.writeUInt32LE(overCap.length - 20, 12);
  overCap.writeUInt32LE(0x4e4f534a, 16);
  const invalid = [
    Buffer.from('glTF'), valid.subarray(0, 19), badLength, badVersion, badJson, badChunk, wrongFirst, overCap,
    modelBytes('', {}), modelBytes('', { asset: { version: '1.0' } }),
    modelBytes('', { asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'https://private.invalid/model.bin' }] }),
    modelBytes('', { asset: { version: '2.0' }, images: [{ uri: '../image.png' }] }),
    modelBytes('', { asset: { version: '2.0' }, buffers: [{ byteLength: 4 }] }),
  ];
  for (const [index, bytes] of invalid.entries()) await fs.writeFile(path.join(modelDirectory, `bad-${index}.glb`), bytes);
  await fs.writeFile(path.join(modelDirectory, 'embedded.glb'), modelBytes('', {
    asset: { version: '2.0' }, buffers: [{ byteLength: 4, uri: 'data:application/octet-stream;base64,AAAAAA==' }],
    images: [{ uri: 'data:image/png;base64,AAAA' }],
  }));
  const selected = path.join(modelDirectory, 'valid.glb');
  await fs.writeFile(selected, valid);
  const list = await (await post('/models')).json();
  assert.deepEqual(list.models.map(item => item.name), ['Demo scene', 'embedded.glb', 'valid.glb']);
  const modelId = list.models.find(item => item.name === 'valid.glb').id;
  const active = await post('/session', { modelId });
  const original = [...viewer.sessions.values()][0];
  for (const bytes of [invalid[0], badLength, badJson, invalid[10], invalid[11], overCap, badChunk, invalid[12]]) {
    await fs.writeFile(selected, bytes);
    const failed = await post('/session', { modelId }, { Cookie: cookie(active) });
    assert.equal(failed.status, 400);
    assert.equal([...viewer.sessions.values()][0], original);
    assert.equal((await fetch(`${viewer.origin}/private-model?token=${original.modelToken}`)).status, 404);
  }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const vm = require('node:vm');
let THREE;
let createViewerTools;

test.before(async () => {
  THREE = await import('three');
  ({ createViewerTools } = await import('../renderer/viewer-tools.mjs'));
});

function fixture() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.z = 10;
  const model = new THREE.Group();
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(8, 8),
    new THREE.MeshBasicMaterial({ color: 0x123456 }));
  model.add(mesh);
  scene.add(model);
  const tools = createViewerTools(scene, camera);
  tools.setModel(model);
  const measure = (action, x = 0.5, y = 0.5, requestId = 3) =>
    tools.command({ type: 'measure', action, x, y, requestId });
  const helpers = scene.children.find(object => object !== model);
  return { scene, camera, model, mesh, tools, measure, helpers };
}

function disposed(object) {
  let count = 0;
  object.addEventListener('dispose', () => count++);
  return () => count;
}

test('wireframe preserves shared originals, arrays and appearance, caching/disposal is idempotent', () => {
  const { tools, model, mesh } = fixture();
  const original = mesh.material;
  const alreadyWireframe = new THREE.MeshStandardMaterial({
    wireframe: true, opacity: 0.4, transparent: true, side: THREE.DoubleSide,
  });
  const array = [original, alreadyWireframe, original];
  const other = new THREE.Mesh(mesh.geometry, array);
  model.add(other);
  const originalDisposed = disposed(original);
  const otherDisposed = disposed(alreadyWireframe);
  tools.command({ type: 'wireframe', enabled: true });
  const copy = mesh.material;
  const copies = other.material;
  const copyDisposed = disposed(copy);
  const secondDisposed = disposed(copies[1]);
  assert.notEqual(copy, original);
  assert.notEqual(copies, array);
  assert.equal(copies[0], copy);
  assert.equal(copies[2], copy);
  assert.equal(copy.wireframe, true);
  assert.equal(copy.color.getHex(), original.color.getHex());
  assert.equal(copies[1].opacity, 0.4);
  assert.equal(copies[1].side, THREE.DoubleSide);
  assert.equal(original.wireframe, false);
  assert.equal(alreadyWireframe.wireframe, true);
  tools.command({ type: 'wireframe', enabled: true });
  assert.equal(mesh.material, copy);
  assert.equal(other.material, copies);
  tools.command({ type: 'wireframe', enabled: false });
  tools.command({ type: 'wireframe', enabled: false });
  assert.equal(mesh.material, original);
  assert.equal(other.material, array);
  assert.equal(original.wireframe, false);
  assert.equal(alreadyWireframe.wireframe, true);
  assert.equal(copyDisposed(), 1);
  assert.equal(secondDisposed(), 1);
  assert.equal(originalDisposed(), 0);
  assert.equal(otherDisposed(), 0);
});

test('measuring raycasts transformed surfaces in wireframe, updates matrices and returns only distance', () => {
  const { tools, model, camera, measure, helpers } = fixture();
  model.position.set(3, 2, -2);
  model.scale.set(1.5, 0.5, 2);
  camera.position.set(3, 2, 10);
  tools.command({ type: 'wireframe', enabled: true });
  assert.deepEqual(measure('start'), { type: 'measurement', requestId: 3, status: 'first' });
  assert.equal(measure('pick', 0.25).status, 'second');
  assert.equal(helpers.children.length, 1);
  assert.equal(measure('pick', 1, 0).status, 'no-hit');
  assert.equal(helpers.children.length, 1, 'A miss keeps the first endpoint');
  const result = measure('pick', 0.75);
  assert.deepEqual(Object.keys(result).sort(), ['distance', 'requestId', 'status', 'type']);
  assert.equal(result.status, 'complete');
  assert.ok(Math.abs(result.distance - 12 * Math.tan(Math.PI / 6)) < 1e-10);
  assert.equal(helpers.children.length, 3);
  assert.ok(helpers.children.every(object => object.visible && object.material.visible));
  const line = helpers.children.find(object => object.isLine);
  assert.equal(line.geometry.attributes.position.count, 2);
  assert.ok(line.material.depthTest === false);
  assert.equal(measure('pick', 0.5).status, 'second', 'A subsequent pick starts a new pair');
  assert.equal(helpers.children.length, 1);
  assert.equal(measure('pick', 0.5).distance, 0);
});

test('only visible model meshes are picked; scene helpers and material-hidden faces are excluded', () => {
  const { scene, model, mesh, measure, tools, helpers } = fixture();
  const helper = new THREE.Mesh(new THREE.PlaneGeometry(8, 8), new THREE.MeshBasicMaterial());
  helper.position.z = 5;
  scene.add(helper);
  const material = helper.material;
  tools.command({ type: 'wireframe', enabled: true });
  assert.equal(helper.material, material, 'Scene helpers do not receive wireframe clones');
  measure('start');
  mesh.visible = false;
  assert.equal(measure('pick').status, 'no-hit');
  mesh.visible = true;
  model.visible = false;
  assert.equal(measure('pick').status, 'no-hit');
  model.visible = true;
  mesh.material.visible = false;
  assert.equal(measure('pick').status, 'no-hit');
  mesh.material.visible = true;
  assert.equal(measure('pick').status, 'second');
  assert.ok(Math.abs(helpers.children[0].position.z) < 1e-10);
  mesh.visible = false;
  assert.equal(measure('pick').status, 'no-hit', 'Endpoint markers are not pick targets');
});

test('picks exclude camera-clipped surfaces using depth, including off-center rays', () => {
  const { camera, model, mesh, measure, helpers } = fixture();
  camera.near = 2;
  camera.far = 12;
  camera.position.set(3, 2, 10);
  model.position.set(3, 2, 0);
  const clipped = new THREE.Mesh(new THREE.PlaneGeometry(30, 30), mesh.material);
  clipped.position.z = 9;
  model.add(clipped);
  measure('start');
  assert.equal(measure('pick', 0.75).status, 'second');
  assert.ok(Math.abs(helpers.children[0].position.z) < 1e-10,
    'Near-clipped surface is skipped in favor of the visible surface behind it');

  measure('clear');
  mesh.position.z = -3;
  assert.equal(measure('pick', 0.75).status, 'no-hit', 'Surface beyond far clip is excluded');
  assert.equal(helpers.children.length, 0);

  mesh.position.z = -1.9;
  assert.equal(measure('pick', 0.75).status, 'second',
    'Visible off-center surface remains pickable even when ray distance exceeds far');
  assert.ok(Math.abs(helpers.children[0].position.z + 1.9) < 1e-10);
});

test('clear, cancel, model replacement and repeated commands dispose all helper resources once', () => {
  const { scene, model, mesh, tools, measure, helpers } = fixture();
  for (const action of ['clear', 'cancel', 'start', 'replace']) {
    measure('start');
    measure('pick', 0.4);
    measure('pick', 0.6);
    const counts = helpers.children.flatMap(object =>
      [disposed(object.geometry), disposed(object.material)]);
    if (action === 'replace') {
      tools.command({ type: 'wireframe', enabled: true });
      const original = mesh.material;
      const count = disposed(original);
      const replacement = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial());
      const replacementOriginal = replacement.material;
      scene.add(replacement);
      tools.setModel(replacement);
      assert.equal(count(), 1);
      assert.notEqual(mesh.material, original, 'Old model original restored');
      assert.notEqual(replacement.material, replacementOriginal, 'Wireframe applied to replacement');
      tools.command({ type: 'wireframe', enabled: false });
      assert.equal(replacement.material, replacementOriginal);
      tools.setModel(null);
    } else {
      assert.equal(measure(action).status, action === 'cancel' ? 'inactive' : 'first');
      measure(action);
    }
    assert.equal(helpers.children.length, 0);
    assert.ok(counts.every(count => count() === 1));
    if (action === 'cancel') assert.equal(measure('pick').status, 'inactive');
  }
  assert.equal(model.children.length, 1);
  assert.equal(measure('pick').status, 'no-hit');
});

test('tools are independent; wireframe before a model loads is retained', () => {
  const first = fixture();
  const second = fixture();
  first.measure('start');
  first.measure('pick');
  first.tools.command({ type: 'wireframe', enabled: true });
  assert.equal(second.measure('pick').status, 'inactive');
  assert.equal(second.mesh.material.wireframe, false);
  second.measure('clear');
  assert.equal(first.helpers.children.length, 1);
  first.tools.setModel(null);
  const original = second.mesh.material;
  first.tools.setModel(second.mesh);
  assert.notEqual(second.mesh.material, original);
  first.tools.command({ type: 'wireframe', enabled: false });
  assert.equal(second.mesh.material, original);
});

test('invalid messages do not mutate measurement or wireframe state', () => {
  const { tools, mesh, measure, helpers } = fixture();
  measure('start');
  measure('pick');
  const material = mesh.material;
  const invalid = [null, undefined, [], 'measure', 3, {}, { type: 'unknown' },
    { type: 'wireframe', enabled: 1 }, { type: 'pause', paused: 'false' },
    ...[-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2', undefined]
      .map(requestId => ({ type: 'measure', action: 'clear', requestId })),
    { type: 'measure', action: 'unknown', requestId: 1 },
    ...[-0.01, 1.01, NaN, Infinity, '0.5', undefined]
      .flatMap(value => ['x', 'y'].map(key =>
        ({ type: 'measure', action: 'pick', requestId: 1, x: 0.5, y: 0.5, [key]: value })))];
  for (const message of invalid) assert.equal(tools.command(message), undefined);
  assert.equal(helpers.children.length, 1);
  assert.equal(mesh.material, material);
  assert.equal(measure('pick', 0.5, 0.5, Number.MAX_SAFE_INTEGER).status, 'complete');
  assert.equal(tools.command({ type: 'pause', paused: false }), undefined);
});

test('renderer starts paused, resets navigation on pause/measure, and ignores invalid commands', async () => {
  const { createNavigation, frameBounds } = await import('../renderer/navigation.mjs');
  const intervals = [];
  let now = 0;
  const context = vm.createContext({
    THREE: { ...THREE, WebGLRenderer: class {
      domElement = {};
      setSize() {}
      render() {}
    } },
    createNavigation, frameBounds, createViewerTools,
    window: {}, document: { body: { appendChild() {} } },
    performance: { now: () => now },
    setInterval: fn => intervals.push(fn),
  });
  const source = await fs.readFile(require.resolve('../renderer/renderer.js'), 'utf8');
  vm.runInContext(source.replace(/^import .*;\n/gm, ''), context);
  const { window } = context;
  assert.equal(window.rendererReady, true);
  const initial = window.camera.position.clone();
  const tick = () => { now += 100; intervals[0](); };
  window.setInput({ forward: true, wheel: 10, x: 100 });
  tick();
  assert.deepEqual(window.camera.position, initial);
  assert.equal(window.camera.rotation.y, 0);
  window.viewerCommand({ type: 'pause', paused: false });
  window.setInput({ forward: true, wheel: -10 });
  tick();
  assert.notDeepEqual(window.camera.position, initial);
  window.setInput({ forward: true, wheel: -100 });
  window.viewerCommand({ type: 'pause', paused: true });
  const paused = window.camera.position.clone();
  window.setInput({ forward: true, x: 100 });
  tick();
  assert.deepEqual(window.camera.position, paused);
  assert.equal(window.camera.rotation.y, 0);
  for (const action of ['start', 'clear', 'cancel', 'pick']) {
    window.viewerCommand({ type: 'pause', paused: false });
    window.setInput({ forward: true, wheel: -100 });
    const result = window.viewerCommand({ type: 'measure', action, requestId: 0, x: 0.5, y: 0.5 });
    assert.equal(result.type, 'measurement');
    window.setInput({ forward: true });
    tick();
    assert.deepEqual(window.camera.position, paused);
  }
  window.viewerCommand({ type: 'pause', paused: false });
  window.viewerCommand({ type: 'measure', action: 'clear', requestId: -1 });
  window.viewerCommand({ type: 'pause', paused: 'true' });
  window.setInput({ forward: true });
  tick();
  assert.notDeepEqual(window.camera.position, paused);
});

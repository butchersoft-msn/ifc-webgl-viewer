import * as THREE from 'three';

export function createViewerTools(scene, camera) {
  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const originals = new Map();
  const clones = new Map();
  const helpers = new THREE.Group();
  scene.add(helpers);
  let model = null;
  let wireframe = false;
  let measuring = false;
  let points = [];

  function clear() {
    const geometries = new Set();
    const materials = new Set();
    helpers.traverse(object => {
      if (object.geometry) geometries.add(object.geometry);
      if (object.material) materials.add(object.material);
    });
    helpers.clear();
    for (const geometry of geometries) geometry.dispose();
    for (const material of materials) material.dispose();
    points = [];
  }

  function restoreMaterials() {
    for (const [mesh, material] of originals) mesh.material = material;
    originals.clear();
    for (const material of clones.values()) material.dispose();
    clones.clear();
  }

  function enableWireframe() {
    if (!model) return;
    const clone = material => {
      if (!material?.isMaterial) return material;
      if (!clones.has(material)) {
        const copy = material.clone();
        copy.wireframe = true;
        clones.set(material, copy);
      }
      return clones.get(material);
    };
    model.traverse(object => {
      if (!object.isMesh || originals.has(object)) return;
      originals.set(object, object.material);
      object.material = Array.isArray(object.material)
        ? object.material.map(clone) : clone(object.material);
    });
  }

  function visible(object) {
    for (let ancestor = object; ancestor; ancestor = ancestor.parent) {
      if (!ancestor.visible) return false;
    }
    return true;
  }

  function pick(x, y) {
    if (!model) return null;
    model.updateWorldMatrix(true, true);
    camera.updateProjectionMatrix();
    camera.updateWorldMatrix(true, false);
    pointer.set(x * 2 - 1, 1 - y * 2);
    raycaster.setFromCamera(pointer, camera);
    const meshes = [];
    model.traverse(object => {
      if (object.isMesh && visible(object)) meshes.push(object);
    });
    const hit = raycaster.intersectObjects(meshes, false).find(intersection => {
      const depth = -intersection.point.clone().applyMatrix4(camera.matrixWorldInverse).z;
      const material = Array.isArray(intersection.object.material)
        ? intersection.object.material[intersection.face.materialIndex]
        : intersection.object.material;
      return depth >= camera.near && depth <= camera.far && material?.visible !== false &&
        intersection.point.toArray().every(Number.isFinite);
    });
    return hit?.point.clone() ?? null;
  }

  function showPoint(point) {
    const scale = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3()).length();
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(scale * 0.005, 1e-6), 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffcc00, depthTest: false }),
    );
    marker.position.copy(point);
    marker.renderOrder = 1;
    helpers.add(marker);
    if (points.length === 2) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(points),
        new THREE.LineBasicMaterial({ color: 0xffcc00, depthTest: false }),
      );
      line.renderOrder = 1;
      helpers.add(line);
    }
  }

  return {
    setModel(value) {
      if (value !== null && !value?.isObject3D) return;
      clear();
      restoreMaterials();
      model = value;
      if (wireframe) enableWireframe();
    },
    command(message) {
      if (!message || typeof message !== 'object' || Array.isArray(message)) return;
      if (message.type === 'pause') return;
      if (message.type === 'wireframe') {
        if (typeof message.enabled !== 'boolean') return;
        wireframe = message.enabled;
        if (wireframe) enableWireframe();
        else restoreMaterials();
        return;
      }
      if (message.type !== 'measure' || !Number.isSafeInteger(message.requestId) ||
          message.requestId < 0 || !['start', 'clear', 'cancel', 'pick'].includes(message.action)) return;
      if (message.action === 'pick' &&
          (![message.x, message.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1))) return;
      const response = status => ({ type: 'measurement', requestId: message.requestId, status });
      if (message.action !== 'pick') {
        clear();
        measuring = message.action !== 'cancel';
        return response(measuring ? 'first' : 'inactive');
      }
      if (!measuring) return response('inactive');
      const point = pick(message.x, message.y);
      if (!point) return response('no-hit');
      if (points.length === 2) clear();
      points.push(point);
      showPoint(point);
      if (points.length === 1) return response('second');
      return { ...response('complete'), distance: points[0].distanceTo(points[1]) };
    },
  };
}

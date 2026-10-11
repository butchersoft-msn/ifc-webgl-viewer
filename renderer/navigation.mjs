import * as THREE from 'three';

export function frameBounds(camera, box) {
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  if (box.isEmpty() || ![...center, ...size].every(Number.isFinite)) {
    center.set(0, 0, 0);
    size.set(4, 4, 4);
  }
  const scale = Math.max(size.x, size.y, size.z) || 1;
  const tanV = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
  const distance = size.z / 2 + Math.max(size.y / (2 * tanV),
    size.x / (2 * tanV * camera.aspect), scale * 0.05) * 1.1;
  camera.position.copy(center).add(new THREE.Vector3(0, 0, distance));
  camera.lookAt(center);
  camera.near = Math.min(0.05, scale * 0.001);
  camera.far = Math.max(10000, distance + scale * 20);
  camera.updateProjectionMatrix();
  return scale;
}

export function createNavigation(camera, scale = 4) {
  let input = {};
  let updated = null;
  let wheel = 0;
  let boost = 1;
  const direction = new THREE.Vector3();
  const yawAxis = new THREE.Vector3(0, 1, 0);
  const delta = value => Number.isFinite(value) ? THREE.MathUtils.clamp(value, -500, 500) : 0;
  const moving = () => input.right !== input.left || input.up !== input.down ||
    input.forward !== input.backward;
  return {
    get boost() { return boost; },
    setScale(value) { scale = value; },
    setInput(value = {}, now) {
      if (value.reset === true || updated === null || now - updated >= 250) {
        boost = 1;
        wheel = 0;
      }
      input = Object.fromEntries(['forward', 'backward', 'left', 'right', 'up', 'down', 'boost']
        .map(key => [key, value[key] === true]));
      updated = now;
      if (!input.boost || !moving()) boost = 1;
      wheel = delta(wheel + delta(value.wheel));
      camera.rotation.y -= delta(value.x) * 0.002;
      camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - delta(value.y) * 0.002, -1.5, 1.5);
    },
    update(now, elapsed) {
      if (updated === null || now - updated >= 250) {
        boost = 1;
        wheel = 0;
        return;
      }
      const dt = Math.max(0, Math.min(elapsed, 0.1));
      if (moving()) {
        const previousBoost = boost;
        boost = input.boost ? Math.min(8, boost + Math.max(0, elapsed) * 2) : 1;
        direction.set(Number(input.right) - Number(input.left), Number(input.up) - Number(input.down),
          Number(input.backward) - Number(input.forward));
        direction.normalize().applyAxisAngle(yawAxis, camera.rotation.y);
        camera.position.addScaledVector(direction, dt * scale * 0.5 *
          ((previousBoost + boost) / 2));
      } else boost = 1;
      if (wheel) {
        camera.getWorldDirection(direction);
        const distance = THREE.MathUtils.clamp(-wheel * scale * 0.001 *
          (input.boost ? Math.max(1.5, boost) : 1), -scale * 0.5, scale * 0.5);
        camera.position.addScaledVector(direction, distance);
        wheel = 0;
      }
    },
  };
}

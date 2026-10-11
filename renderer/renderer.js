import * as THREE from 'three';
import { GLTFLoader } from './GLTFLoader.js';

try {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(1280, 720);
  document.body.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x87ceeb);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 3));
  const light = new THREE.DirectionalLight(0xffffff, 3);
  light.position.set(20, 40, 10);
  scene.add(light);
  const camera = new THREE.PerspectiveCamera(70, 1280 / 720, 0.05, 10000);
  camera.rotation.order = 'YXZ';
  camera.position.set(0, 2, 12);
  let input = {};
  let updated = 0;
  let lastTime = performance.now();
  let peer;
  let fallback = false;
  const pendingIce = [];
  window.setInput = value => {
    input = value;
    updated = performance.now();
    camera.rotation.y -= value.x * 0.002;
    camera.rotation.x = THREE.MathUtils.clamp(camera.rotation.x - value.y * 0.002, -1.5, 1.5);
  };
  window.acceptAnswer = async sdp => {
    if (fallback) return;
    await peer.setRemoteDescription({ type: 'answer', sdp });
    for (const candidate of pendingIce.splice(0)) await peer.addIceCandidate(candidate);
  };
  window.acceptIce = async candidate => {
    if (fallback) return;
    if (peer.remoteDescription) await peer.addIceCandidate(candidate);
    else pendingIce.push(candidate);
  };
  window.startStream = async ({ iceServers, hasModel }) => {
    if (hasModel) {
      const gltf = await new GLTFLoader().loadAsync('/model.glb');
      scene.add(gltf.scene);
      const box = new THREE.Box3().setFromObject(gltf.scene);
      if (!box.isEmpty()) {
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3()).length();
        camera.position.copy(center).add(new THREE.Vector3(0, size * 0.15, Math.max(size, 5)));
        camera.lookAt(center);
        camera.far = Math.max(10000, size * 10);
        camera.updateProjectionMatrix();
      }
    } else {
      const cube = new THREE.Mesh(new THREE.BoxGeometry(4, 4, 4), new THREE.MeshStandardMaterial({ color: 0x22bb66 }));
      cube.position.y = 2;
      scene.add(cube, new THREE.GridHelper(100, 50));
    }
    peer = new RTCPeerConnection({ iceServers });
    window.peer = peer;
    peer.onicecandidate = event => {
      if (event.candidate) void window.sendSignal({ type: 'ice', candidate: event.candidate.toJSON() });
    };
    const stream = renderer.domElement.captureStream(30);
    for (const track of stream.getTracks()) peer.addTrack(track, stream);
    await peer.setLocalDescription(await peer.createOffer());
    await window.sendSignal({ type: 'offer', sdp: peer.localDescription.sdp });
    setTimeout(() => {
      if (peer.connectionState === 'connected') return;
      fallback = true;
      peer.onicecandidate = null;
      peer.close();
      const mimeType = 'video/webm;codecs=vp8';
      if (!MediaRecorder.isTypeSupported(mimeType)) {
        void window.sendSignal({ type: 'error', message: 'WebRTC failed and WebM fallback is unavailable' });
        return;
      }
      const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 2000000 });
      let chain = Promise.resolve();
      recorder.ondataavailable = event => {
        if (!event.data.size) return;
        chain = chain.then(async () => {
          const bytes = new Uint8Array(await event.data.arrayBuffer());
          let binary = '';
          for (let i = 0; i < bytes.length; i += 8192) {
            binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
          }
          await window.sendVideo(btoa(binary));
        });
      };
      void window.sendSignal({ type: 'fallback', mimeType });
      recorder.start(200);
    }, 5000);
  };
  setInterval(() => {
    const now = performance.now();
    const dt = Math.min((now - lastTime) / 1000, 0.1);
    lastTime = now;
    if (now - updated < 250) {
      const move = new THREE.Vector3(Number(!!input.right) - Number(!!input.left), 0,
        Number(!!input.backward) - Number(!!input.forward));
      if (move.lengthSq()) {
        move.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), camera.rotation.y);
        camera.position.addScaledVector(move, dt * 5);
      }
    }
    renderer.render(scene, camera);
  }, 1000 / 30);
  // Expose diagnostic state only within the private Puppeteer page.
  window.camera = camera;
  window.rendererReady = true;
} catch (error) {
  window.rendererError = error.message;
}

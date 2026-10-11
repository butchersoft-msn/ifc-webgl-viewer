const fs = require('node:fs/promises');
const path = require('node:path');
const { IfcAPI } = require('web-ifc');

async function convert(inputPath, outputPath) {
  const THREE = await import('three');
  const publicPath = await fs.realpath(path.join(__dirname, 'public'));
  const input = await fs.realpath(path.resolve(inputPath));
  const output = path.resolve(outputPath);
  const outputDirectory = await fs.realpath(path.dirname(output));
  for (const target of [input, path.join(outputDirectory, path.basename(output))]) {
    const relative = path.relative(publicPath, target);
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) {
      throw new Error('Source and converted models must be outside public');
    }
  }
  const api = new IfcAPI();
  await api.Init();
  let modelId;
  try {
    modelId = api.OpenModel(new Uint8Array(await fs.readFile(input)), { COORDINATE_TO_ORIGIN: true });
    if (modelId < 0) throw new Error('Cannot open IFC model');
    const chunks = [];
    let offset = 0;
    const document = {
      asset: { version: '2.0', generator: 'Private IFC geometry converter' },
      scene: 0, scenes: [{ nodes: [] }], nodes: [], meshes: [],
      materials: [], buffers: [{ byteLength: 0 }], bufferViews: [], accessors: [],
    };
    function accessor(array, componentType, type, target, bounds) {
      const bytes = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
      const padding = (4 - bytes.length % 4) % 4;
      const view = document.bufferViews.length;
      document.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length, target });
      chunks.push(bytes, Buffer.alloc(padding));
      offset += bytes.length + padding;
      const index = document.accessors.length;
      document.accessors.push({ bufferView: view, componentType, count: array.length / (type === 'VEC3' ? 3 : 1), type, ...bounds });
      return index;
    }
    api.StreamAllMeshes(modelId, mesh => {
      for (let i = 0; i < mesh.geometries.size(); i++) {
        const placed = mesh.geometries.get(i);
        const geometry = api.GetGeometry(modelId, placed.geometryExpressID);
        try {
          const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
          const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize()).slice();
          if (!indices.length || !vertices.length) continue;
          const positions = new Float32Array(vertices.length / 2);
          const normals = new Float32Array(vertices.length / 2);
          const transform = new THREE.Matrix4().fromArray(placed.flatTransformation);
          const normalTransform = new THREE.Matrix3().getNormalMatrix(transform);
          const vector = new THREE.Vector3();
          const min = [Infinity, Infinity, Infinity];
          const max = [-Infinity, -Infinity, -Infinity];
          for (let v = 0; v < vertices.length / 6; v++) {
            vector.fromArray(vertices, v * 6).applyMatrix4(transform).toArray(positions, v * 3);
            vector.fromArray(vertices, v * 6 + 3).applyMatrix3(normalTransform).normalize().toArray(normals, v * 3);
            for (let axis = 0; axis < 3; axis++) {
              min[axis] = Math.min(min[axis], positions[v * 3 + axis]);
              max[axis] = Math.max(max[axis], positions[v * 3 + axis]);
            }
          }
          if (transform.determinant() < 0) {
            for (let j = 0; j < indices.length; j += 3) [indices[j + 1], indices[j + 2]] = [indices[j + 2], indices[j + 1]];
          }
          const position = accessor(positions, 5126, 'VEC3', 34962, { min, max });
          const normal = accessor(normals, 5126, 'VEC3', 34962);
          const index = accessor(indices, 5125, 'SCALAR', 34963);
          const material = document.materials.length;
          const color = placed.color;
          document.materials.push({
            pbrMetallicRoughness: { baseColorFactor: [color.x, color.y, color.z, color.w], metallicFactor: 0, roughnessFactor: 1 },
            doubleSided: true, alphaMode: color.w < 1 ? 'BLEND' : 'OPAQUE',
          });
          const meshIndex = document.meshes.length;
          document.meshes.push({ primitives: [{ attributes: { POSITION: position, NORMAL: normal }, indices: index, material }] });
          document.scenes[0].nodes.push(document.nodes.length);
          document.nodes.push({ mesh: meshIndex });
        } finally { geometry.delete(); }
      }
    });
    if (!document.meshes.length) throw new Error('IFC contains no renderable geometry');
    document.buffers[0].byteLength = offset;
    const json = Buffer.from(JSON.stringify(document));
    const paddedJson = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 0x20)]);
    const binary = Buffer.concat(chunks);
    const header = Buffer.alloc(12);
    header.write('glTF');
    header.writeUInt32LE(2, 4);
    header.writeUInt32LE(12 + 8 + paddedJson.length + 8 + binary.length, 8);
    function chunkHeader(length, type) {
      const buffer = Buffer.alloc(8);
      buffer.writeUInt32LE(length);
      buffer.writeUInt32LE(type, 4);
      return buffer;
    }
    // Exclusive creation prevents overwriting source files or following an output symlink.
    await fs.writeFile(output, Buffer.concat([header, chunkHeader(paddedJson.length, 0x4e4f534a),
      paddedJson, chunkHeader(binary.length, 0x004e4942), binary]), { flag: 'wx', mode: 0o600 });
    return document.meshes.length;
  } finally {
    if (modelId !== undefined && modelId >= 0) api.CloseModel(modelId);
    api.Dispose();
  }
}
if (require.main === module) {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) {
    console.error('Usage: npm run convert -- <private.ifc> <private.glb>');
    process.exitCode = 1;
  } else {
    convert(input, output).then(count => console.log(`Converted ${count} mesh parts to private GLB`))
      .catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
module.exports = { convert };

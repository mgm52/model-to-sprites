import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (id) => document.getElementById(id);

// --- scene ---------------------------------------------------------------

const viewport = $('viewport');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.outputColorSpace = THREE.SRGBColorSpace;
viewport.appendChild(renderer.domElement);

const scene = new THREE.Scene();

// Lights — keyed for a cartoon/3D-pixel-art readable look.
const hemi = new THREE.HemisphereLight(0xffffff, 0x404060, 0.7);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(3, 5, 3);
scene.add(key);
const fill = new THREE.DirectionalLight(0x88aaff, 0.4);
fill.position.set(-3, 2, -2);
scene.add(fill);

// Two cameras; we swap based on UI.
let camera = makeOrtho();
function makeOrtho() {
  const c = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  return c;
}
function makePersp() {
  const c = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
  return c;
}

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.5, 0);
controls.enableDamping = true;

// Pivot we put the model under — we rotate this for the 8 directions.
const pivot = new THREE.Group();
scene.add(pivot);

// --- state ---------------------------------------------------------------

let model = null;            // loaded scene/object
let mixer = null;            // AnimationMixer for current model
let clips = [];              // available AnimationClip[]
let action = null;           // currently playing AnimationAction
let modelBox = new THREE.Box3();
let modelRadius = 1;
let modelCenter = new THREE.Vector3();
let lastModelName = '';
let isRendering = false;
let lastSheetBlob = null;
let lastMeta = null;
let previewState = null; // { dirs, frames, size, layout, fps, scale }

const clock = new THREE.Clock();

// --- loading -------------------------------------------------------------

const gltfLoader = new GLTFLoader();
const fbxLoader = new FBXLoader();

async function loadFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const url = URL.createObjectURL(file);
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const gltf = await gltfLoader.loadAsync(url);
      return { object: gltf.scene, animations: gltf.animations || [] };
    } else if (ext === 'fbx') {
      const obj = await fbxLoader.loadAsync(url);
      return { object: obj, animations: obj.animations || [] };
    } else {
      throw new Error(`Unsupported extension: .${ext}`);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function setModelFromFile(file) {
  if (model) {
    pivot.remove(model);
    model.traverse?.((o) => {
      if (o.geometry) o.geometry.dispose?.();
      if (o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        mats.forEach((m) => m.dispose?.());
      }
    });
    model = null;
    mixer = null;
    action = null;
    clips = [];
    loadedPresets.clear();
  }

  const { object, animations } = await loadFile(file);

  // FBX models often come in centimeter scale; normalize so the longest dim ≈ 1.
  const tmpBox = new THREE.Box3().setFromObject(object);
  const tmpSize = tmpBox.getSize(new THREE.Vector3());
  const longest = Math.max(tmpSize.x, tmpSize.y, tmpSize.z) || 1;
  const norm = 1 / longest;
  object.scale.multiplyScalar(norm);

  // Recompute bounds & center on origin (XZ), keeping feet on the ground (Y).
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= box.min.y; // feet at y=0

  pivot.add(object);
  model = object;

  modelBox = new THREE.Box3().setFromObject(object);
  modelBox.getCenter(modelCenter);
  modelRadius = modelBox.getSize(new THREE.Vector3()).length() * 0.5;

  lastModelName = file.name.replace(/\.[^.]+$/, '');
  clips = animations.slice();
  renameGenericClips(clips, lastModelName);
  if (clips.length) {
    mixer = new THREE.AnimationMixer(model);
    playClip(clips[0]);
  }
  $('model-info').textContent = `${file.name} — ${clips.length} clip(s)`;
  refreshClipDropdown();
  updateCameraFromUI();
  $('render').disabled = false;
}

async function addClipsFromFile(file) {
  if (!model || !mixer) {
    alert('Load a rigged model first, then add clips.');
    return;
  }
  const { object, animations } = await loadFile(file);
  if (!animations.length) {
    alert('No animations found in that file.');
    return;
  }
  const baseName = file.name.replace(/\.[^.]+$/, '');
  renameGenericClips(animations, baseName);
  for (const c of animations) clips.push(c);
  refreshClipDropdown();
  // Auto-select the newly added first clip.
  const idx = clips.length - animations.length;
  $('clip-select').value = String(idx);
  playClip(clips[idx]);
}

function refreshClipDropdown() {
  const sel = $('clip-select');
  sel.innerHTML = '';
  if (!model) {
    const o = document.createElement('option');
    o.textContent = '— no model —';
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  clips.forEach((c, i) => {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = `${c.name || '(unnamed)'} · ${c.duration.toFixed(2)}s`;
    sel.appendChild(o);
  });
  // Lazy preset entries — fetch on selection.
  for (let i = 0; i < presetFilenames.length; i++) {
    const name = presetFilenames[i];
    if (loadedPresets.has(name)) continue;
    const o = document.createElement('option');
    o.value = `preset:${i}`;
    o.textContent = `+ load: ${name.replace(/\.[^.]+$/, '')}`;
    sel.appendChild(o);
  }
  if (!clips.length && presetFilenames.length === 0) {
    const o = document.createElement('option');
    o.textContent = '— no clips —';
    sel.appendChild(o);
    sel.disabled = true;
  }
}

function playClip(clip) {
  if (!mixer || !clip) return;
  if (action) action.stop();
  action = mixer.clipAction(clip);
  action.reset().play();
  liveTime = 0;
}

$('clip-select').addEventListener('change', async (e) => {
  const v = e.target.value;
  if (v.startsWith('preset:')) {
    const idx = parseInt(v.slice(7), 10);
    const name = presetFilenames[idx];
    e.target.disabled = true;
    const before = clips.length;
    try {
      await applyPreset(name);
      loadedPresets.add(name);
      refreshClipDropdown();
      e.target.value = String(before);
    } catch (err) {
      showErr(err);
    } finally {
      e.target.disabled = false;
    }
    return;
  }
  const i = parseInt(v, 10);
  if (!isNaN(i) && clips[i]) playClip(clips[i]);
});

// --- camera framing ------------------------------------------------------

function updateCameraFromUI() {
  const projection = $('projection').value;
  const wantPersp = projection === 'persp';
  const isPersp = camera.isPerspectiveCamera;
  if (wantPersp !== isPersp) {
    camera = wantPersp ? makePersp() : makeOrtho();
    controls.object = camera;
  }

  const pitchDeg = parseFloat($('pitch').value);
  const distMul = parseFloat($('distance').value);
  const vshift = parseFloat($('vshift').value);

  const radius = Math.max(0.001, modelRadius);
  const target = new THREE.Vector3(0, modelCenter.y + vshift, 0);
  controls.target.copy(target);

  const pitch = THREE.MathUtils.degToRad(pitchDeg);
  // Place camera initially "in front" (−Z) — we rotate the pivot for direction.
  const dist = radius * 4 * distMul;
  const camPos = new THREE.Vector3(
    0,
    target.y + Math.sin(pitch) * dist,
    -Math.cos(pitch) * dist
  );
  camera.position.copy(camPos);
  camera.lookAt(target);

  const w = renderer.domElement.clientWidth;
  const h = Math.max(1, renderer.domElement.clientHeight);
  const aspect = w / h;

  if (camera.isOrthographicCamera) {
    const m = radius * 1.15 * distMul;
    camera.left = -m * aspect; camera.right = m * aspect;
    camera.top = m;            camera.bottom = -m;
    camera.near = 0.01;
    camera.far = dist * 4;
    camera.updateProjectionMatrix();
  } else {
    camera.aspect = aspect;
    camera.near = Math.max(0.01, dist - radius * 2);
    camera.far = dist + radius * 4;
    camera.updateProjectionMatrix();
  }
}

['pitch', 'distance', 'vshift', 'projection'].forEach((id) =>
  $(id).addEventListener('input', updateCameraFromUI)
);

// --- live preview --------------------------------------------------------

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h, false);
  if (model) updateCameraFromUI();
}
new ResizeObserver(resize).observe(viewport);
resize();

let liveTime = 0; // manual playhead so we can honor trim range in the live preview
function tick() {
  requestAnimationFrame(tick);
  if (isRendering) return; // render loop owns the frame
  const dt = clock.getDelta();
  if (mixer && action) {
    const clip = action.getClip();
    const [tStart, tEnd] = trimRange(clip.duration);
    const span = Math.max(0.0001, tEnd - tStart);
    liveTime += dt;
    const t = tStart + (liveTime % span);
    mixer.setTime(t);
  } else if (mixer) {
    mixer.update(dt);
  }
  controls.update();
  renderer.render(scene, camera);
}
tick();

function trimRange(duration) {
  const sPct = clamp(parseFloat($('trim-start').value) || 0, 0, 100);
  const ePct = clamp(parseFloat($('trim-end').value) || 100, 0, 100);
  const lo = Math.min(sPct, ePct);
  const hi = Math.max(sPct, ePct);
  return [duration * (lo / 100), duration * (hi / 100)];
}

['trim-start', 'trim-end'].forEach((id) =>
  $(id).addEventListener('input', () => { liveTime = 0; })
);

// --- file picking & dnd --------------------------------------------------

$('pick-model').addEventListener('click', () => $('model-input').click());
$('pick-anim').addEventListener('click', () => $('anim-input').click());
$('model-input').addEventListener('change', (e) => {
  if (e.target.files[0]) setModelFromFile(e.target.files[0]).catch(showErr);
});
$('anim-input').addEventListener('change', (e) => {
  if (e.target.files[0]) addClipsFromFile(e.target.files[0]).catch(showErr);
});

const overlay = $('drop-overlay');
['dragenter', 'dragover'].forEach((ev) =>
  viewport.addEventListener(ev, (e) => {
    e.preventDefault();
    overlay.classList.add('active');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  viewport.addEventListener(ev, (e) => {
    e.preventDefault();
    overlay.classList.remove('active');
  })
);
viewport.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (!f) return;
  // First drop becomes the model; subsequent drops add animation clips.
  if (!model) setModelFromFile(f).catch(showErr);
  else addClipsFromFile(f).catch(showErr);
});

function showErr(err) {
  console.error(err);
  alert(`Error: ${err.message || err}`);
}

// --- spritesheet rendering ----------------------------------------------

$('render').addEventListener('click', () => renderSheet().catch(showErr));
$('download').addEventListener('click', () => {
  if (!lastSheetBlob) return;
  triggerDownload(lastSheetBlob, `${exportBaseName()}.png`);
});
$('download-meta').addEventListener('click', () => {
  if (!lastMeta) return;
  const blob = new Blob([JSON.stringify(lastMeta, null, 2)], { type: 'application/json' });
  triggerDownload(blob, `${exportBaseName()}.json`);
});

function slugify(s) {
  return (s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
function exportBaseName() {
  const model = slugify(lastModelName) || 'sprites';
  const anim = slugify(lastMeta?.clip);
  return anim ? `${model}_${anim}` : model;
}

function triggerDownload(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

async function renderSheet() {
  if (!model) return;
  const clipIdx = parseInt($('clip-select').value, 10);
  const clip = clips[clipIdx];

  const size = clamp(parseInt($('size').value, 10), 8, 512);
  const dirs = clamp(parseInt($('dirs').value, 10), 1, 32);
  const frames = clamp(parseInt($('frames').value, 10), 1, 64);
  const angle0 = THREE.MathUtils.degToRad(parseFloat($('angle0').value) || 0);
  const cw = $('cw').checked;
  const layout = $('layout').value;
  const useBg = $('bg-on').checked;
  const bgColor = $('bg').value;
  const autoCrop = $('autocrop').checked;
  const cropPad = clamp(parseInt($('cropPad').value, 10) || 0, 0, 32);

  // Render at higher internal resolution so the post-crop downscale stays sharp.
  const internalSize = clamp(Math.max(256, size * 4), 64, 1024);

  // Offscreen renderer always uses transparent bg — we composite the bg color
  // when drawing to the final sheet, so alpha can be used for crop detection.
  const off = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  off.setPixelRatio(1);
  off.setSize(internalSize, internalSize, false);
  off.outputColorSpace = THREE.SRGBColorSpace;
  off.setClearColor(0x000000, 0);

  const renderCam = buildRenderCamera();

  const wasRendering = isRendering;
  isRendering = true;
  const prevAction = action;
  if (mixer) mixer.stopAllAction();
  let renderMixer = null;
  if (clip) {
    renderMixer = new THREE.AnimationMixer(model);
    renderMixer.clipAction(clip).play();
  }

  const startRot = pivot.rotation.y;

  const dirAngles = [];
  for (let d = 0; d < dirs; d++) {
    const step = (Math.PI * 2) / dirs;
    dirAngles.push(angle0 + (cw ? -1 : 1) * step * d);
  }

  const duration = clip ? clip.duration : 0;
  const [tStart, tEnd] = trimRange(duration);
  const tSpan = Math.max(0, tEnd - tStart);

  // Pass 1: render every frame to a per-frame canvas at internalSize, scanning
  // alpha as we go to build the union bounding box.
  const buffers = new Array(dirs * frames);
  let minX = internalSize, minY = internalSize, maxX = 0, maxY = 0;
  let foundContent = false;

  for (let d = 0; d < dirs; d++) {
    pivot.rotation.y = dirAngles[d];
    for (let f = 0; f < frames; f++) {
      const t = tStart + tSpan * (f / frames);
      if (renderMixer) renderMixer.setTime(t);
      off.render(scene, renderCam);

      const buf = document.createElement('canvas');
      buf.width = internalSize;
      buf.height = internalSize;
      const bctx = buf.getContext('2d');
      bctx.drawImage(off.domElement, 0, 0);
      buffers[d * frames + f] = buf;

      if (autoCrop) {
        const data = bctx.getImageData(0, 0, internalSize, internalSize).data;
        // Step the scan to keep it fast on bigger internal sizes.
        const step = internalSize > 256 ? 2 : 1;
        for (let y = 0; y < internalSize; y += step) {
          for (let x = 0; x < internalSize; x += step) {
            if (data[(y * internalSize + x) * 4 + 3] > 8) {
              if (x < minX) minX = x;
              if (y < minY) minY = y;
              if (x > maxX) maxX = x;
              if (y > maxY) maxY = y;
              foundContent = true;
            }
          }
        }
      }

      if ((d * frames + f) % 4 === 3) await new Promise((r) => setTimeout(r));
    }
  }

  // Compute the source rect for cropping. Square it so we don't distort.
  let srcX, srcY, srcSide;
  if (autoCrop && foundContent) {
    // Inflate slightly to recover any pixels missed by the step scan.
    minX = Math.max(0, minX - 1);
    minY = Math.max(0, minY - 1);
    maxX = Math.min(internalSize - 1, maxX + 1);
    maxY = Math.min(internalSize - 1, maxY + 1);
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    srcSide = Math.max(w, h);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    srcX = cx - srcSide / 2;
    srcY = cy - srcSide / 2;
  } else {
    srcX = 0; srcY = 0; srcSide = internalSize;
  }

  // Pass 2: compose the spritesheet with optional bg fill + cropped+scaled draws.
  const cols = layout === 'dir-rows' ? frames : dirs;
  const rows = layout === 'dir-rows' ? dirs : frames;
  const sheet = $('sheet');
  sheet.width = cols * size;
  sheet.height = rows * size;
  const ctx = sheet.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, sheet.width, sheet.height);

  // Map the source rect into a (size - 2*pad) inner box centered in the cell.
  const inner = Math.max(1, size - 2 * cropPad);

  for (let d = 0; d < dirs; d++) {
    for (let f = 0; f < frames; f++) {
      const cellX = (layout === 'dir-rows' ? f : d) * size;
      const cellY = (layout === 'dir-rows' ? d : f) * size;
      if (useBg) {
        ctx.fillStyle = bgColor;
        ctx.fillRect(cellX, cellY, size, size);
      }
      ctx.drawImage(
        buffers[d * frames + f],
        srcX, srcY, srcSide, srcSide,
        cellX + cropPad, cellY + cropPad, inner, inner
      );
    }
  }

  pivot.rotation.y = startRot;
  if (renderMixer) renderMixer.stopAllAction();
  off.dispose();
  isRendering = wasRendering;

  if (clip && mixer) {
    action = mixer.clipAction(clip);
    action.reset().play();
  } else if (prevAction) {
    prevAction.reset().play();
  }

  // Export blob.
  await new Promise((resolve) => sheet.toBlob((b) => { lastSheetBlob = b; resolve(); }, 'image/png'));
  const restForward = $('rest-forward').value;
  const REST_PHI = { '+Z': 180, '-Z': 0, '+X': 90, '-X': 270 };
  const restPhi = REST_PHI[restForward] ?? 180;
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  const headings = dirAngles.map((rad, d) => {
    const thetaDeg = THREE.MathUtils.radToDeg(rad);
    let phi = (restPhi - thetaDeg) % 360;
    if (phi < 0) phi += 360;
    return {
      index: d,
      pivotRotationDeg: ((thetaDeg % 360) + 360) % 360,
      headingDeg: Math.round(phi),
      compass: COMPASS[Math.round(phi / 45) % 8],
    };
  });

  lastMeta = {
    source: lastModelName,
    clip: clip?.name || null,
    clipDuration: duration,
    trimStartPct: parseFloat($('trim-start').value) || 0,
    trimEndPct: parseFloat($('trim-end').value) || 100,
    spriteSize: size,
    directions: dirs,
    framesPerDirection: frames,
    layout,
    startAngleDeg: parseFloat($('angle0').value) || 0,
    clockwise: cw,
    restForward,
    headings,
    cameraPitchDeg: parseFloat($('pitch').value) || 30,
    projection: $('projection').value,
    cols, rows,
    sheetWidth: sheet.width,
    sheetHeight: sheet.height,
    autoCrop,
    cropPadding: cropPad,
  };

  $('output-label').textContent =
    `Spritesheet — ${sheet.width}×${sheet.height} (${dirs} dir × ${frames} frames @ ${size}px)`;
  $('download').disabled = false;
  $('download-meta').disabled = false;

  // Auto-scale preview so all directions fit in a reasonable width.
  const targetWidth = 720;
  const scale = Math.max(1, Math.floor(targetWidth / (dirs * size)));
  previewState = { dirs, frames, size, layout, fps: clamp(parseInt($('fps').value, 10) || 10, 1, 60), scale, dirAngles };
  previewStart = performance.now();
  buildPreviewLabels(dirAngles, size * scale);
}

function buildPreviewLabels(dirAngles, cellW) {
  const labels = $('preview-labels');
  labels.innerHTML = '';
  const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  // Phi value when the model is in its rest pose, by which axis = forward.
  const REST_PHI = { '+Z': 180, '-Z': 0, '+X': 90, '-X': 270 };
  const restPhi = REST_PHI[$('rest-forward').value] ?? 180;
  for (let d = 0; d < dirAngles.length; d++) {
    const thetaDeg = THREE.MathUtils.radToDeg(dirAngles[d]);
    let phi = (restPhi - thetaDeg) % 360;
    if (phi < 0) phi += 360;
    const compass = COMPASS[Math.round(phi / 45) % 8];
    const cell = document.createElement('div');
    cell.style.width = cellW + 'px';
    cell.innerHTML =
      `<div class="arrow" style="transform: rotate(${phi}deg)">↑</div>` +
      `<div>${compass} · ${Math.round(phi)}°</div>`;
    labels.appendChild(cell);
  }
}

$('rest-forward').addEventListener('change', () => {
  if (previewState && previewState.dirAngles) {
    buildPreviewLabels(previewState.dirAngles, previewState.size * previewState.scale);
  }
});

// --- continuous preview --------------------------------------------------

const previewCanvas = $('preview');
const previewCtx = previewCanvas.getContext('2d');
let previewStart = performance.now();

$('fps').addEventListener('input', () => {
  if (previewState) previewState.fps = clamp(parseInt($('fps').value, 10) || 10, 1, 60);
});

function previewTick() {
  requestAnimationFrame(previewTick);
  if (!previewState) return;
  const { dirs, frames, size, layout, fps, scale } = previewState;
  const sheet = $('sheet');

  const w = dirs * size * scale;
  const h = size * scale;
  if (previewCanvas.width !== w || previewCanvas.height !== h) {
    previewCanvas.width = w;
    previewCanvas.height = h;
    previewCanvas.style.width = w + 'px';
    previewCanvas.style.height = h + 'px';
  }

  const elapsed = (performance.now() - previewStart) / 1000;
  const f = Math.floor(elapsed * fps) % frames;

  previewCtx.clearRect(0, 0, w, h);
  previewCtx.imageSmoothingEnabled = false;
  for (let d = 0; d < dirs; d++) {
    const sx = (layout === 'dir-rows' ? f : d) * size;
    const sy = (layout === 'dir-rows' ? d : f) * size;
    previewCtx.drawImage(sheet, sx, sy, size, size, d * size * scale, 0, size * scale, size * scale);
  }

  $('preview-label').textContent = `Preview — ${dirs} directions @ ${fps} fps (frame ${f + 1}/${frames})`;
}
previewTick();

function buildRenderCamera() {
  // Mirror updateCameraFromUI but produce a camera sized for square output.
  const projection = $('projection').value;
  const pitchDeg = parseFloat($('pitch').value);
  const distMul = parseFloat($('distance').value);
  const vshift = parseFloat($('vshift').value);

  const radius = Math.max(0.001, modelRadius);
  const target = new THREE.Vector3(0, modelCenter.y + vshift, 0);
  const pitch = THREE.MathUtils.degToRad(pitchDeg);
  const dist = radius * 4 * distMul;
  const camPos = new THREE.Vector3(
    0,
    target.y + Math.sin(pitch) * dist,
    -Math.cos(pitch) * dist
  );

  let cam;
  if (projection === 'persp') {
    cam = new THREE.PerspectiveCamera(35, 1, Math.max(0.01, dist - radius * 2), dist + radius * 4);
  } else {
    const m = radius * 1.15 * distMul;
    cam = new THREE.OrthographicCamera(-m, m, m, -m, 0.01, dist * 4);
  }
  cam.position.copy(camPos);
  cam.lookAt(target);
  return cam;
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function renameGenericClips(arr, baseName) {
  // Mixamo always names exported clips "mixamo.com"; replace those (and empty names)
  // with the source file's basename so the dropdown and exported filenames are useful.
  const isGeneric = (n) => !n || /^mixamo\.com$/i.test(n) || /^take\s*\d*$/i.test(n);
  arr.forEach((c, i) => {
    if (isGeneric(c.name)) {
      c.name = arr.length > 1 ? `${baseName} ${i + 1}` : baseName;
    }
  });
}

// --- preset animations ---------------------------------------------------

const PRESET_DIR = './maximo_animations/';
let presetFilenames = [];
let loadedPresets = new Set();

async function discoverPresets() {
  try {
    const res = await fetch(PRESET_DIR);
    if (!res.ok) return [];
    const html = await res.text();
    const matches = [...html.matchAll(/href="([^"?]+\.(?:fbx|glb|gltf))"/gi)];
    return matches.map((m) => decodeURIComponent(m[1])).filter((n) => !n.startsWith('/'));
  } catch {
    return [];
  }
}

async function applyPreset(filename) {
  if (!model) {
    alert('Load a rigged model first, then apply a preset walk.');
    return;
  }
  const url = PRESET_DIR + encodeURIComponent(filename);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch ${filename}: HTTP ${res.status}`);
  const blob = await res.blob();
  const file = new File([blob], filename, { type: 'application/octet-stream' });
  await addClipsFromFile(file);
}

(async () => {
  presetFilenames = await discoverPresets();
  refreshClipDropdown();
})();

// --- resizable gutters ---------------------------------------------------

function makeGutter(el, axis, applyPx) {
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    el.classList.add('dragging');
    const start = axis === 'x' ? e.clientX : e.clientY;
    const startPx = applyPx();
    const onMove = (ev) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      applyPx(startPx + delta);
    };
    const onUp = () => {
      el.classList.remove('dragging');
      el.releasePointerCapture(e.pointerId);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
}

makeGutter($('gutter-x'), 'x', (px) => {
  if (px === undefined) return parseInt(getComputedStyle(document.body).getPropertyValue('--sidebar-w')) || 280;
  const v = clamp(px, 180, Math.max(220, window.innerWidth - 200));
  document.body.style.setProperty('--sidebar-w', v + 'px');
  return v;
});

makeGutter($('gutter-y'), 'y', (px) => {
  if (px === undefined) return parseInt(getComputedStyle(document.body).getPropertyValue('--viewport-h')) || 340;
  const v = clamp(px, 120, Math.max(160, window.innerHeight - 120));
  document.body.style.setProperty('--viewport-h', v + 'px');
  return v;
});

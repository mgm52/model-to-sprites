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
// Key + fill live under a rig so they can optionally spin around the model
// (hemisphere light is omnidirectional, so it stays outside).
const hemi = new THREE.HemisphereLight(0xffffff, 0x404060, 0.7);
scene.add(hemi);
const lightRig = new THREE.Group();
scene.add(lightRig);
const key = new THREE.DirectionalLight(0xffffff, 1.2);
key.position.set(3, 5, 3);
lightRig.add(key);
const fill = new THREE.DirectionalLight(0x88aaff, 0.4);
fill.position.set(-3, 2, -2);
lightRig.add(fill);

function lightSpinTurns() {
  return $('light-spin').checked ? (parseFloat($('light-spin-turns').value) || 0) : 0;
}

$('light-spin').addEventListener('change', () => {
  liveTime = 0; // restart the spin cycle so the preview starts from the key pose
  // Static models get frames clamped to 1 on load; spinning the light makes
  // extra frames meaningful again.
  if ($('light-spin').checked && model && !clips.length && parseInt($('frames').value, 10) === 1) {
    $('frames').value = 8;
    toast('Light spin on — frames per direction restored to 8 (frames vary by lighting)');
  }
});

// Brightness slider scales all lights — helps assets with dark textures.
const BASE_LIGHTS = [[hemi, 0.7], [key, 1.2], [fill, 0.4]];
$('brightness').addEventListener('input', () => {
  const v = parseFloat($('brightness').value) || 1;
  for (const [light, base] of BASE_LIGHTS) light.intensity = base * v;
});

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

// Textures supplied alongside the model (separate-folder assets). Keyed by
// lowercased basename; loader texture requests are redirected here.
const textureFiles = new Map(); // basename -> object URL

function registerTextureFile(file) {
  const url = URL.createObjectURL(file);
  const old = textureFiles.get(file.name.toLowerCase());
  if (old) URL.revokeObjectURL(old);
  textureFiles.set(file.name.toLowerCase(), url);
}

function resolveTextureURL(url) {
  if (textureFiles.size === 0 || url.startsWith('blob:') || url.startsWith('data:')) return url;
  const base = decodeURIComponent(url.split(/[/\\]/).pop()).toLowerCase();
  // Exact basename, then jpg/jpeg swap, then same stem with any extension.
  if (textureFiles.has(base)) return textureFiles.get(base);
  const swapped = base.endsWith('.jpg') ? base.replace(/\.jpg$/, '.jpeg')
    : base.endsWith('.jpeg') ? base.replace(/\.jpeg$/, '.jpg') : null;
  if (swapped && textureFiles.has(swapped)) return textureFiles.get(swapped);
  const stem = base.replace(/\.[^.]+$/, '.');
  for (const [name, blobURL] of textureFiles) {
    if (name.startsWith(stem)) return blobURL;
  }
  console.warn(`No dropped texture matches "${base}" — have: ${[...textureFiles.keys()].join(', ')}`);
  return url;
}

// Most color-looking registered texture, for the rescue pass below.
function pickColorTextureURL() {
  const score = (n) => /color|diffuse|albedo|base/.test(n) ? 0
    : /normal|rough|metal|occlu|spec|bump|height|ao\b/.test(n) ? 2 : 1;
  const names = [...textureFiles.keys()].sort((a, b) => score(a) - score(b));
  return names.length && score(names[0]) < 2 ? textureFiles.get(names[0]) : null;
}

// If the model's texture requests all failed (e.g. the FBX references names
// that don't match the dropped files, or never requested them at all),
// manually apply the dropped color map.
function textureRescue(object) {
  if (model !== object) return true; // replaced in the meantime — stop checking
  const all = [];
  object.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    all.push(...mats);
  });
  if (all.some((m) => m.map?.image)) return true; // at least one map works — leave it be
  const url = pickColorTextureURL();
  if (!url) return true;
  const tex = new THREE.TextureLoader().load(url, downsizeTexture);
  tex.colorSpace = THREE.SRGBColorSpace;
  for (const m of all) {
    m.map = tex;
    if (m.color) m.color.setHex(0xffffff);
    m.needsUpdate = true;
  }
  console.warn(`Texture rescue: applied dropped color texture to ${all.length} material(s)`);
  toast('Model textures failed to resolve — applied the dropped color texture as a fallback');
  return true;
}

// Huge textures (8K scans) can silently fail to upload on VRAM-constrained
// GPUs — WebGL then samples them as black. Downscale to something sane.
const MAX_TEX_DIM = 2048;
const TEX_SLOTS = ['map', 'aoMap', 'normalMap', 'roughnessMap', 'metalnessMap', 'specularMap', 'emissiveMap', 'bumpMap'];

function downsizeTexture(tex) {
  const img = tex?.image;
  if (!img || !(img.width > MAX_TEX_DIM || img.height > MAX_TEX_DIM)) return;
  const scale = MAX_TEX_DIM / Math.max(img.width, img.height);
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale);
  c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  tex.image = c;
  tex.needsUpdate = true;
  console.warn(`Downscaled ${img.width}×${img.height} texture to ${c.width}×${c.height} for reliable GPU upload`);
}

function downsizeModelTextures(object) {
  object.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) for (const slot of TEX_SLOTS) downsizeTexture(m[slot]);
  });
}

function dumpDiagnostics(object, tag) {
  const lines = [];
  object.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    mats.forEach((m, i) => {
      const map = m.map ? (m.map.image ? `${m.map.image.width}x${m.map.image.height}` : 'NO-IMAGE') : 'none';
      const normals = o.geometry ? String(!!o.geometry.attributes.normal) : '—';
      lines.push(`${m.type} color=#${m.color?.getHexString?.() ?? '?'} map=${map} normals=${normals}`);
    });
  });
  console.log(`[diag ${tag}] lights=${[hemi, key, fill].map((l) => l.intensity.toFixed(2)).join('/')} :: ${lines.join(' | ')}`);
}

function scheduleTextureRescue(object) {
  // Texture images arrive asynchronously — re-check a few times.
  for (const ms of [500, 1500, 3000, 6000, 10000]) {
    setTimeout(() => { if (model === object) downsizeModelTextures(object); }, ms);
  }
  setTimeout(() => dumpDiagnostics(object, '+2s'), 2000);
  setTimeout(() => dumpDiagnostics(object, '+8s'), 8000);
  if (!textureFiles.size) return;
  setTimeout(() => textureRescue(object), 4000);
  setTimeout(() => textureRescue(object), 9000);
}

const loadingManager = new THREE.LoadingManager();
loadingManager.setURLModifier(resolveTextureURL);
// Missing textures (e.g. maps the asset didn't ship) shouldn't be fatal.
loadingManager.onError = (url) => console.warn(`Texture not found: ${url}`);

const gltfLoader = new GLTFLoader(loadingManager);
const fbxLoader = new FBXLoader(loadingManager);

const IMAGE_RE = /\.(png|jpe?g|webp|gif|bmp|avif)$/i;
const MODEL_RE = /\.(glb|gltf|fbx)$/i;

async function loadFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const url = URL.createObjectURL(file);
  try {
    if (ext === 'glb' || ext === 'gltf') {
      const gltf = await gltfLoader.loadAsync(url);
      return { object: gltf.scene, animations: gltf.animations || [] };
    } else if (ext === 'fbx') {
      const obj = await fbxLoader.loadAsync(url);
      fixBlackDiffuse(obj);
      return { object: obj, animations: obj.animations || [] };
    } else {
      throw new Error(`Unsupported extension: .${ext}`);
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}

// Some FBX exports (e.g. Sketchfab conversions) set a black diffuse color
// alongside a diffuse map, and/or ship geometry without normals; either way
// lit materials render the model solid black.
function fixBlackDiffuse(object) {
  object.traverse((o) => {
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      if (m.map && m.color?.getHex() === 0x000000) m.color.setHex(0xffffff);
    }
    if (o.geometry && !o.geometry.attributes.normal) o.geometry.computeVertexNormals();
  });
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
  const texNote = textureFiles.size ? ` · ${textureFiles.size} texture(s)` : '';
  $('model-info').textContent = `${file.name} — ${clips.length} clip(s)${texNote}`;
  refreshClipDropdown();
  updateCameraFromUI();
  $('render').disabled = false;
  document.body.classList.add('has-model');
  scheduleTextureRescue(object);
  if (clips.length) {
    toast(`Loaded ${file.name} — ${clips.length} clip(s)`);
  } else if (lightSpinTurns()) {
    // Light spin makes frames differ even without animation.
    toast(`Loaded ${file.name} — no animation (static); frames will vary by light spin`);
  } else {
    $('frames').value = 1; // static model: extra frames would be identical
    toast(`Loaded ${file.name} — no animation (static); frames per direction set to 1`);
  }
}

async function addClipsFromFile(file) {
  if (!model) {
    toast('Load a model first, then add clips.', true);
    return;
  }
  const { animations } = await loadFile(file);
  if (!animations.length) {
    // Not a clip file — treat it as a replacement model instead of erroring.
    toast(`No animation clips in ${file.name} — loading it as the model`);
    await setModelFromFile(file);
    return;
  }
  if (!mixer) mixer = new THREE.AnimationMixer(model);
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
  if (!clips.length) {
    // Selected by default so a preset entry isn't misleadingly shown as active.
    const o = document.createElement('option');
    o.value = '-1';
    o.textContent = '(static — no animation)';
    sel.appendChild(o);
  }
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
  liveTime += dt;
  let cycleSpan; // seconds per loop — drives the light spin below
  if (mixer && action) {
    const clip = action.getClip();
    const [tStart, tEnd] = trimRange(clip.duration);
    cycleSpan = Math.max(0.0001, tEnd - tStart);
    const t = tStart + (liveTime % cycleSpan);
    mixer.setTime(t);
  } else {
    if (mixer) mixer.update(dt);
    // No clip playing: mirror what the render produces — `frames` frames
    // played back at the preview FPS make one cycle.
    const frames = clamp(parseInt($('frames').value, 10) || 1, 1, 64);
    const fps = clamp(parseInt($('fps').value, 10) || 10, 1, 60);
    cycleSpan = frames / fps;
  }
  const turns = lightSpinTurns();
  lightRig.rotation.y = turns
    ? ((liveTime % cycleSpan) / cycleSpan) * turns * Math.PI * 2
    : 0;
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
  if (e.target.files.length) handleFiles([...e.target.files]).catch(showErr);
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
  collectDroppedFiles(e.dataTransfer).then(handleFiles).catch(showErr);
});

// Walks dropped items, descending into directories so a whole asset folder
// (model + separate textures/) can be dropped at once.
async function collectDroppedFiles(dt) {
  const entries = [...(dt?.items || [])]
    .map((it) => it.webkitGetAsEntry?.())
    .filter(Boolean);
  if (entries.length === 0) return [...(dt?.files || [])];
  const files = [];
  async function walk(entry) {
    if (entry.isFile) {
      files.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const child of batch) await walk(child);
      } while (batch.length > 0);
    }
  }
  for (const entry of entries) await walk(entry);
  return files;
}

async function handleFiles(files) {
  // Register textures first so they're resolvable when the model loads.
  const images = files.filter((f) => IMAGE_RE.test(f.name));
  images.forEach(registerTextureFile);
  const models = files.filter((f) => MODEL_RE.test(f.name));
  if (!models.length) {
    if (images.length) toast(`Registered ${images.length} texture(s) — now drop the model that uses them`);
    else toast('No .glb / .gltf / .fbx or texture files found in that drop', true);
    return;
  }
  try {
    for (const f of models) {
      setBusy(`Loading ${f.name}`);
      // First model becomes the model; subsequent ones add animation clips.
      if (!model) await setModelFromFile(f);
      else await addClipsFromFile(f);
    }
  } finally {
    setBusy(null);
  }
}

let toastTimer;
function toast(msg, isError = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, isError ? 6000 : 3500);
}

function setBusy(msg) {
  const b = $('busy');
  b.hidden = !msg;
  if (msg) b.textContent = msg;
}

function showErr(err) {
  console.error(err);
  toast(`Error: ${err.message || err}`, true);
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

  const renderBtn = $('render');
  renderBtn.disabled = true;

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
  const startLightRot = lightRig.rotation.y;
  // Light spin: `turns` full revolutions spread across each direction's frames.
  // Works without a clip too — frames then differ only by lighting.
  const spinTurns = lightSpinTurns();

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

  const cols = layout === 'dir-rows' ? frames : dirs;
  const rows = layout === 'dir-rows' ? dirs : frames;
  const sheet = $('sheet');

  try {
  for (let d = 0; d < dirs; d++) {
    pivot.rotation.y = dirAngles[d];
    for (let f = 0; f < frames; f++) {
      renderBtn.textContent = `Rendering ${d * frames + f + 1}/${dirs * frames}…`;
      const t = tStart + tSpan * (f / frames);
      if (renderMixer) renderMixer.setTime(t);
      lightRig.rotation.y = spinTurns ? spinTurns * Math.PI * 2 * (f / frames) : startLightRot;
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

  } finally {
    pivot.rotation.y = startRot;
    lightRig.rotation.y = startLightRot;
    if (renderMixer) renderMixer.stopAllAction();
    off.dispose();
    isRendering = wasRendering;
    renderBtn.disabled = false;
    renderBtn.textContent = 'Render spritesheet';

    if (clip && mixer) {
      action = mixer.clipAction(clip);
      action.reset().play();
    } else if (prevAction) {
      prevAction.reset().play();
    }
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
    lightSpinTurns: spinTurns,
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
  document.body.classList.add('has-sheet');
  toast(`Rendered ${dirs} × ${frames} spritesheet — download below`);
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
    toast('Load a rigged model first, then apply a preset animation.', true);
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

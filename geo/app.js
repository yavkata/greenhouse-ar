import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import * as G from './geomath.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const state = {
  siteId: params.get('site') || 'greenhouse', site: null, ref: null,
  fixes: [], compass: null, offSamples: [], offFallback: null, startHeading: null,
  xr: null, refSpace: null, hitSource: null, lastHit: null, cam: { x: 0, y: 0, z: 0 }, camTheta: 0,
  placed: false, phi: 0, t: { x: 0, z: 0 }, y: 0, fixed: [], ghost: false, how: '',
};

/* ---------------- storage (per site, best effort) ---------------- */
const key = () => 'geoar:' + state.siteId;
function loadRef() {
  let o = null;
  try { o = JSON.parse(localStorage.getItem(key()) || 'null'); } catch (e) { o = null; }
  const s = state.site;
  const base = { lat: s.geo?.lat ?? null, lon: s.geo?.lon ?? null, point: s.geo?.point || s.points[0].id,
    approx: !!s.geo?.approx, azimuth: s.azimuth ?? 0, declination: s.declination ?? 0, source: 'файл' };
  state.ref = o ? { ...base, ...o, source: 'запазено на телефона' } : base;
}
function saveRef(patch) {
  state.ref = { ...state.ref, ...patch, source: 'запазено на телефона' };
  try { localStorage.setItem(key(), JSON.stringify(state.ref)); } catch (e) { /* storage blocked */ }
  fillGeoForm();
}
const pointById = id => state.site.points.find(p => p.id === id);

/* ---------------- sensors ---------------- */
function startGPS() {
  if (!navigator.geolocation) return;
  navigator.geolocation.watchPosition(p => {
    state.fixes.push({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, t: Date.now() });
    if (state.fixes.length > 200) state.fixes.splice(0, 100);
  }, err => { state.gpsError = err.message; }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}
const gps = () => G.gpsAverage(state.fixes, Date.now());
function onOrient(e, absolute) {
  if (e.alpha == null) return;
  if (!absolute && !e.absolute && e.webkitCompassHeading == null) return;
  state.compass = { alpha: e.alpha, beta: e.beta, gamma: e.gamma, ios: e.webkitCompassHeading, t: performance.now(), seq: (state.compass?.seq || 0) + 1 };
}
window.addEventListener('deviceorientationabsolute', e => onOrient(e, true));
window.addEventListener('deviceorientation', e => { if (!('ondeviceorientationabsolute' in window)) onOrient(e, false); });
function trueCameraHeading() {
  const c = state.compass; if (!c || performance.now() - c.t > 300) return null;
  const h = G.cameraHeading(c.alpha, c.beta, c.gamma);
  return { heading: G.wrap360(h.heading + Number(state.ref.declination || 0)), elevation: h.elevation };
}
function offset() {
  if (state.offSamples.length >= 30) {
    const m = G.circMean(state.offSamples.slice(-600).map(s => s.v));
    return { deg: m.mean, spread: m.spread, n: m.n };
  }
  if (state.offFallback != null) return { deg: state.offFallback, spread: 15, n: 0 };
  return null;
}

/* ---------------- three.js scene ---------------- */
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(2, devicePixelRatio));
renderer.xr.enabled = true;
$('preview').appendChild(renderer.domElement);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 400);
camera.position.set(10, 8, 12);
scene.add(new THREE.HemisphereLight(0xffffff, 0x88806f, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(5, 10, 7); scene.add(sun);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const modelRoot = new THREE.Group(); scene.add(modelRoot);
const content = new THREE.Group(); modelRoot.add(content);
const labels = new THREE.Group(); modelRoot.add(labels);
const fixedMarks = new THREE.Group(); scene.add(fixedMarks);
const reticle = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.12, 32).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff }));
reticle.visible = false; scene.add(reticle);

function label(text, color = '#2f8f86') {
  const c = document.createElement('canvas'); c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = color; g.beginPath(); g.roundRect(8, 8, 240, 112, 24); g.fill();
  g.fillStyle = '#fff'; g.font = 'bold 64px system-ui,sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 66);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  s.scale.set(0.5, 0.25, 1); s.renderOrder = 10; return s;
}
function pin(color) {
  const g = new THREE.Group();
  const m = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.6, 12), new THREE.MeshBasicMaterial({ color }));
  m.position.y = 0.3; g.add(m); return g;
}
function buildLabels() {
  labels.clear();
  for (const p of state.site.points) {
    const s = label(p.id); s.position.set(p.x, 0.75, p.z); labels.add(s);
    const k = pin(0x2f8f86); k.position.set(p.x, 0, p.z); labels.add(k);
  }
}
const loader = new GLTFLoader();
function loadModel() {
  content.clear();
  return new Promise((res, rej) => loader.load(state.site.model, g => {
    g.scene.traverse(o => { if (o.isMesh) { o.material.userData.op = o.material.opacity; } });
    content.add(g.scene); res();
  }, undefined, rej));
}
function setGhost(on) {
  state.ghost = on;
  content.traverse(o => {
    if (!o.isMesh) return;
    const m = o.material, base = m.userData.op ?? 1;
    m.transparent = on || base < 1; m.opacity = on ? Math.min(base, 0.45) : base; m.depthWrite = !on && base >= 1; m.needsUpdate = true;
  });
  $('ghost').textContent = on ? 'Плътно' : 'Прозрачно';
}
function resize() {
  if (renderer.xr.isPresenting) return;
  const el = $('preview'), w = el.clientWidth, h = el.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe($('preview'));

/* ---------------- placement ---------------- */
function applyPose() {
  modelRoot.position.set(state.t.x, state.y, state.t.z);
  modelRoot.rotation.set(0, state.phi, 0);
  modelRoot.visible = state.placed;
}
function solve() {
  const off = offset(), F = state.fixed;
  if (F.length >= 2) {
    const f = G.rigidFit(F.map(q => pointById(q.id)), F.map(q => q.p));
    state.phi = f.phi; state.t = f.t; state.fit = f; state.how = F.length + ' точки';
  } else if (F.length === 1) {
    state.fit = null;
    if (!off) { say('С една точка посоката идва от компаса, а той още не е калибриран. Завърти се бавно или фиксирай втора точка.'); }
    state.phi = off ? G.yawFor(Number(state.ref.azimuth), off.deg) : state.phi;
    state.t = G.translationFor(state.phi, pointById(F[0].id), F[0].p);
    state.how = '1 точка + компас';
  } else return;
  state.y = F.reduce((s, q) => s + q.p.y, 0) / F.length;
  state.placed = true; applyPose(); updateBar();
}
function placeByGPS() {
  const r = state.ref, off = offset(), g = gps();
  if (r.lat == null || r.lon == null) return say('Няма въведени координати за обекта. Въведи ги на началния екран или стой на точка и натисни „GPS тук“.');
  if (!g) return say('Още няма GPS. Изчакай няколко секунди на открито.');
  if (!off) return say('Компасът още не е калибриран. Дръж телефона изправен и се завърти бавно на 360°.');
  const P = G.xrOfGeo(state.cam, g, { lat: r.lat, lon: r.lon }, off.deg);
  state.fixed = []; fixedMarks.clear(); state.fit = null;
  state.phi = G.yawFor(Number(r.azimuth), off.deg);
  state.t = G.translationFor(state.phi, pointById(r.point), P);
  state.y = state.lastHit ? state.lastHit.y : 0;
  state.placed = true; state.how = 'GPS + компас'; applyPose(); updateBar();
  say(`Поставен по GPS. Точката ${r.point} е на ${P.dist.toFixed(1)} m от теб. Грешка около ±${Math.max(3, g.acc).toFixed(0)} m и ±${off.spread.toFixed(0)}°. Фиксирай колчета за точност.`);
}
function fixPoint() {
  if (!state.lastHit) return say('Насочи кръгчето към земята, докато се появи бял пръстен.');
  const id = $('fpoint').value;
  state.fixed = state.fixed.filter(q => q.id !== id);
  state.fixed.push({ id, p: { ...state.lastHit } });
  drawFixed(); solve();
  const n = state.fixed.length;
  say(n === 1 ? `${id} е фиксирана. Фиксирай още една точка за точна посока.` : `${n} точки фиксирани.`);
  const sel = $('fpoint'), i = sel.selectedIndex; if (i < sel.options.length - 1) sel.selectedIndex = i + 1;
}
function drawFixed() {
  fixedMarks.clear();
  for (const q of state.fixed) { const k = pin(0xffc04d); k.position.set(q.p.x, q.p.y, q.p.z); fixedMarks.add(k); }
}
function rotateBy(deg) {
  if (!state.placed) return;
  const pv = state.fixed.length ? pointById(state.fixed[0].id) : { x: 0, z: 0 };
  const P = G.rot(state.phi, pv.x, pv.z); const W = { x: P.x + state.t.x, z: P.z + state.t.z };
  state.phi += deg * G.D2R; state.t = G.translationFor(state.phi, pv, W); applyPose(); updateBar();
}
function moveBy(mx, mz) {
  if (!state.placed) return;
  const d = G.rot(state.phi, mx, mz); state.t.x += d.x; state.t.z += d.z; applyPose(); updateBar();
}
function gpsHere() {
  const g = gps(); const id = $('fpoint').value, off = offset();
  if (!g) return say('Още няма GPS.');
  let geo = { lat: g.lat, lon: g.lon }, how = 'стоиш върху точката';
  if (state.placed && off && state.fixed.length >= 1) {
    const m = pointById(id), r = G.rot(state.phi, m.x, m.z);
    geo = G.geoOfXr(state.cam, g, { x: r.x + state.t.x, z: r.z + state.t.z }, off.deg); how = 'от поставения модел';
  }
  saveRef({ lat: +geo.lat.toFixed(7), lon: +geo.lon.toFixed(7), point: id, approx: false });
  say(`Записах ${id}: ${geo.lat.toFixed(6)}, ${geo.lon.toFixed(6)} (${how}, GPS ±${g.acc.toFixed(0)} m).`);
}
function saveAzimuth() {
  const off = offset();
  if (state.fixed.length < 2) return say('Азимутът се записва след поне две фиксирани точки.');
  if (!off) return say('Компасът още не е калибриран.');
  const A = G.azimuthOf(state.phi, off.deg);
  saveRef({ azimuth: +G.wrap180(A).toFixed(1) });
  say(`Записах азимут ${G.wrap180(A).toFixed(1)}° (компас ±${off.spread.toFixed(0)}°).`);
}

/* ---------------- AR session ---------------- */
async function startAR() {
  const ov = $('overlay'); ov.hidden = false;
  const h = trueCameraHeading(); state.startHeading = h ? h.heading : null;
  let session;
  try {
    session = await navigator.xr.requestSession('immersive-ar', {
      requiredFeatures: ['hit-test', 'local-floor'], optionalFeatures: ['dom-overlay'], domOverlay: { root: ov } });
  } catch (e) { ov.hidden = true; $('startnote').textContent = 'AR не стартира: ' + e.message; return; }
  state.xr = session; state.offSamples = []; state.offFallback = null; state.fixed = []; fixedMarks.clear();
  state.placed = false; modelRoot.visible = false; labels.visible = true;
  renderer.xr.setReferenceSpaceType('local-floor');
  await renderer.xr.setSession(session);
  state.refSpace = renderer.xr.getReferenceSpace();
  const viewer = await session.requestReferenceSpace('viewer');
  state.hitSource = await session.requestHitTestSource({ space: viewer });
  session.addEventListener('end', () => { state.xr = null; state.hitSource = null; ov.hidden = true; reticle.visible = false;
    modelRoot.position.set(0, 0, 0); modelRoot.rotation.set(0, 0, 0); modelRoot.visible = true; fixedMarks.clear(); resize(); });
  ov.addEventListener('beforexrselect', e => e.preventDefault());
  say('Дръж телефона изправен и се завърти бавно около себе си, за да се калибрира компасът.');
}
let lastSeq = -1, frames = 0;
function xrFrame(frame) {
  const pose = frame.getViewerPose(state.refSpace); if (!pose) return;
  const p = pose.transform.position, q = pose.transform.orientation;
  const f = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
  state.cam = { x: p.x, y: p.y, z: p.z }; state.camTheta = G.xrTheta(f.x, f.z);
  const xrElev = Math.asin(Math.max(-1, Math.min(1, f.y))) * G.R2D;
  if (frames++ === 0 && state.startHeading != null) state.offFallback = G.wrap360(state.startHeading - state.camTheta);
  const c = state.compass;
  if (c && c.seq !== lastSeq) {
    lastSeq = c.seq; const h = trueCameraHeading();
    if (h && Math.abs(h.elevation) < 40 && Math.abs(xrElev) < 40 && Math.abs(h.elevation - xrElev) < 12) {
      state.offSamples.push({ v: G.wrap360(h.heading - state.camTheta), t: performance.now() });
      if (state.offSamples.length > 1200) state.offSamples.splice(0, 600);
    }
  }
  const hits = state.hitSource ? frame.getHitTestResults(state.hitSource) : [];
  if (hits.length) {
    const hp = hits[0].getPose(state.refSpace).transform.position;
    state.lastHit = { x: hp.x, y: hp.y, z: hp.z, t: performance.now() };
    reticle.position.set(hp.x, hp.y, hp.z); reticle.visible = true;
  } else { reticle.visible = false; if (state.lastHit && performance.now() - state.lastHit.t > 400) state.lastHit = { ...state.lastHit, stale: true }; }
  if (frames % 15 === 0) updateBar();
}
function updateBar() {
  const g = gps(), off = offset(), parts = [];
  parts.push(g ? `GPS <b>±${g.acc.toFixed(0)} m</b>` : 'GPS <b>—</b>');
  parts.push(off ? `компас <b>${off.n ? '±' + off.spread.toFixed(0) + '°' : 'старт'}</b>` : 'компас <b>калибрира се</b>');
  parts.push(`точки <b>${state.fixed.length}</b>`);
  if (state.fit) parts.push(`отклонение <b>${(state.fit.rms * 100).toFixed(0)} cm</b>`);
  if (state.placed && off && state.fixed.length >= 2) parts.push(`азимут <b>${G.wrap180(G.azimuthOf(state.phi, off.deg)).toFixed(1)}°</b>`);
  if (state.placed) parts.push(`режим <b>${state.how}</b>`);
  $('bar').innerHTML = parts.map(s => `<span class="chip">${s}</span>`).join('');
}
const say = t => { $('msg').textContent = t; };

renderer.setAnimationLoop((t, frame) => {
  if (frame && state.xr) xrFrame(frame); else controls.update();
  renderer.render(scene, camera);
});

/* ---------------- landing page ---------------- */
function fillGeoForm() {
  const r = state.ref;
  $('lat').value = r.lat ?? ''; $('lon').value = r.lon ?? '';
  $('az').value = r.azimuth; $('decl').value = r.declination;
  $('gpoint').value = r.point;
  const p = pointById(r.point);
  $('geonote').textContent = r.lat == null
    ? 'Няма координати. Въведи ги (напр. от кадастъра или Google Maps) или застани на колче и натисни „GPS тук → точката“.'
    : `Координатите са на точка ${r.point} (${p ? p.name : ''}). Източник: ${r.source}${r.approx ? ', приблизителни' : ''}. Азимут 0° = северната страна на модела гледа точно на север.`;
  $('map').href = r.lat != null ? `https://www.google.com/maps?q=${r.lat},${r.lon}` : '#';
}
function readGeoForm() {
  const num = v => (v === '' || isNaN(+v) ? null : +v);
  return { lat: num($('lat').value), lon: num($('lon').value), point: $('gpoint').value,
    azimuth: num($('az').value) ?? 0, declination: num($('decl').value) ?? 0, approx: false };
}
function fillPointSelects() {
  for (const sel of [$('gpoint'), $('fpoint')]) {
    sel.innerHTML = state.site.points.map(p => `<option value="${p.id}">${p.id} · ${p.name}</option>`).join('');
  }
}
async function openSite(id) {
  state.siteId = id;
  state.site = await (await fetch(`sites/${id}.json`)).json();
  $('title').textContent = state.site.name + ' · Гео AR';
  $('subtitle').textContent = `${state.site.place}, ${state.site.size}. Отпред: ${state.site.front}.`;
  document.title = state.site.name + ' · Гео AR';
  loadRef(); fillPointSelects(); fillGeoForm(); buildLabels();
  await loadModel(); setGhost(false);
  const box = new THREE.Box3().setFromObject(content), size = box.getSize(new THREE.Vector3());
  const d = Math.max(size.x, size.z) * 1.15 + 2;
  camera.position.set(d * 0.55, d * 0.55, d * 0.85); controls.target.set(0, size.y / 3, 0); controls.update();
}
async function init() {
  const list = await (await fetch('sites/index.json')).json();
  $('site').innerHTML = list.map(s => `<option value="${s.id}">${s.name}</option>`).join('');
  if (!list.find(s => s.id === state.siteId)) state.siteId = list[0].id;
  $('site').value = state.siteId;
  $('site').addEventListener('change', e => { history.replaceState(null, '', '?site=' + e.target.value); openSite(e.target.value); });
  await openSite(state.siteId);
  startGPS();
  const xrOk = !!(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar').catch(() => false));
  $('start').disabled = !xrOk;
  $('startnote').textContent = xrOk ? 'Разреши достъп до камерата и местоположението, когато телефонът попита.'
    : 'Този браузър не поддържа WebXR AR. Отвори страницата в Chrome на Android с ARCore.';
  setInterval(() => {
    const g = gps(), h = trueCameraHeading();
    $('support').innerHTML = [
      `WebXR AR: <span class="${xrOk ? 'ok' : 'bad'}">${xrOk ? 'да' : 'не'}</span>`,
      `GPS: ${g ? `<span class="ok">±${g.acc.toFixed(0)} m</span> · ${g.lat.toFixed(6)}, ${g.lon.toFixed(6)}` : `<span class="warn">${state.gpsError || 'чака сигнал'}</span>`}`,
      `Компас: ${h ? `<span class="ok">${h.heading.toFixed(0)}° (истински север)</span>` : '<span class="warn">няма данни</span>'}`,
    ].map(x => `<div>${x}</div>`).join('');
  }, 700);
}

$('start').addEventListener('click', startAR);
$('save').addEventListener('click', () => { saveRef(readGeoForm()); $('savemsg').textContent = 'Запазено на този телефон.'; });
$('reset').addEventListener('click', () => { try { localStorage.removeItem(key()); } catch (e) {} loadRef(); fillGeoForm(); $('savemsg').textContent = 'Върнато към стойностите от файла.'; });
$('here').addEventListener('click', () => {
  const g = gps(); if (!g) { $('savemsg').textContent = 'Още няма GPS сигнал.'; return; }
  saveRef({ ...readGeoForm(), lat: +g.lat.toFixed(7), lon: +g.lon.toFixed(7) });
  $('savemsg').textContent = `Записах GPS (±${g.acc.toFixed(0)} m) за точка ${$('gpoint').value}. За по-точно стой на място 20–30 s и натисни пак.`;
});
$('copy').addEventListener('click', async () => {
  const r = state.ref, txt = JSON.stringify({ geo: { lat: r.lat, lon: r.lon, point: r.point }, azimuth: r.azimuth, declination: r.declination });
  try { await navigator.clipboard.writeText(txt); $('savemsg').textContent = 'Копирано: ' + txt; }
  catch (e) { $('savemsg').textContent = txt; }
});
$('fix').addEventListener('click', fixPoint);
$('undo').addEventListener('click', () => { state.fixed.pop(); drawFixed(); if (state.fixed.length) solve(); else { state.placed = false; state.fit = null; applyPose(); updateBar(); } });
$('bygps').addEventListener('click', placeByGPS);
$('rl').addEventListener('click', () => rotateBy(0.5));
$('rr').addEventListener('click', () => rotateBy(-0.5));
$('mn').addEventListener('click', () => moveBy(0, -0.05));
$('ms').addEventListener('click', () => moveBy(0, 0.05));
$('mw').addEventListener('click', () => moveBy(-0.05, 0));
$('me').addEventListener('click', () => moveBy(0.05, 0));
$('ghost').addEventListener('click', () => setGhost(!state.ghost));
$('gpshere').addEventListener('click', gpsHere);
$('saveaz').addEventListener('click', saveAzimuth);
$('exit').addEventListener('click', () => state.xr && state.xr.end());
init().catch(e => { $('startnote').textContent = 'Грешка при зареждане: ' + e.message; console.error(e); });

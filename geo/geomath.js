// Pure geometry helpers for geo-anchored WebXR placement. No DOM, no three.js.
// Conventions
//   Earth (ENU): e = east, n = north, metres. Headings: degrees from true north, clockwise.
//   XR (local-floor): x right, y up, -z = initial forward. theta = atan2(f.x, -f.z) grows clockwise seen from above.
//   Model (glTF): x = model east, y = up, -z = model north, metres.
export const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const wrap360 = a => ((a % 360) + 360) % 360;
export const wrap180 = a => { a = wrap360(a); return a > 180 ? a - 360 : a; };

// metres of point 1 relative to point 0 (equirectangular, fine for < 10 km)
export function enuOffset(lat0, lon0, lat1, lon1) {
  const R = 6378137, lat = ((lat0 + lat1) / 2) * D2R;
  return { e: (lon1 - lon0) * D2R * R * Math.cos(lat), n: (lat1 - lat0) * D2R * R };
}
export function enuToLatLon(lat0, lon0, e, n) {
  const R = 6378137;
  return { lat: lat0 + (n / R) * R2D, lon: lon0 + (e / (R * Math.cos(lat0 * D2R))) * R2D };
}

// W3C DeviceOrientation (Z-X'-Y'') -> where the rear camera (device -Z) points.
// Returns compass heading (deg, relative to the frame alpha is measured in) and elevation (deg, + = up).
export function cameraHeading(alpha, beta, gamma) {
  const a = alpha * D2R, b = beta * D2R, g = gamma * D2R;
  const cA = Math.cos(a), sA = Math.sin(a), cB = Math.cos(b), sB = Math.sin(b), cG = Math.cos(g), sG = Math.sin(g);
  const vx = -cA * sG - sA * sB * cG, vy = -sA * sG + cA * sB * cG, vz = -cB * cG;
  return { heading: wrap360(Math.atan2(vx, vy) * R2D), elevation: Math.asin(Math.max(-1, Math.min(1, vz))) * R2D };
}

// XR yaw of a forward vector
export const xrTheta = (fx, fz) => wrap360(Math.atan2(fx, -fz) * R2D);
// XR horizontal unit vector for a true heading, given offset (true heading = theta + offset)
export function xrDir(headingDeg, offsetDeg) {
  const t = (headingDeg - offsetDeg) * D2R;
  return { x: Math.sin(t), z: -Math.cos(t) };
}

// circular mean / spread of angles in degrees
export function circMean(arr) {
  let s = 0, c = 0;
  for (const a of arr) { s += Math.sin(a * D2R); c += Math.cos(a * D2R); }
  const n = arr.length || 1, r = Math.hypot(s, c) / n;
  return { mean: wrap360(Math.atan2(s, c) * R2D), spread: r > 0 ? Math.sqrt(-2 * Math.log(Math.min(1, r))) * R2D : 180, n: arr.length };
}

// three.js-style yaw: model (x,z) -> XR (x,z)
export function rot(phi, x, z) { const c = Math.cos(phi), s = Math.sin(phi); return { x: c * x + s * z, z: -s * x + c * z }; }
// model yaw that points model north (-z) along true azimuth A
export const yawFor = (azimuthDeg, offsetDeg) => (offsetDeg - azimuthDeg) * D2R;
export const azimuthOf = (phi, offsetDeg) => wrap360(offsetDeg - phi * R2D);

// Place model so that model point m lands on XR point P with yaw phi -> translation t
export function translationFor(phi, m, P) { const r = rot(phi, m.x, m.z); return { x: P.x - r.x, z: P.z - r.z }; }

// Best rigid 2D fit (rotation about y + translation, no scale) of model points onto XR points.
export function rigidFit(model, xr) {
  const n = model.length; let mx = 0, mz = 0, px = 0, pz = 0;
  for (let i = 0; i < n; i++) { mx += model[i].x; mz += model[i].z; px += xr[i].x; pz += xr[i].z; }
  mx /= n; mz /= n; px /= n; pz /= n;
  let sd = 0, sc = 0;
  for (let i = 0; i < n; i++) {
    const ax = model[i].x - mx, az = model[i].z - mz, bx = xr[i].x - px, bz = xr[i].z - pz;
    sd += ax * bx + az * bz; sc += az * bx - ax * bz;
  }
  const phi = Math.atan2(sc, sd), t = translationFor(phi, { x: mx, z: mz }, { x: px, z: pz });
  const residuals = model.map((m, i) => { const r = rot(phi, m.x, m.z); return Math.hypot(r.x + t.x - xr[i].x, r.z + t.z - xr[i].z); });
  return { phi, t, residuals, rms: Math.sqrt(residuals.reduce((s, r) => s + r * r, 0) / n) };
}

// GPS placement: XR position of a geo point seen from a camera at XR (cx,cz) standing at GPS (lat,lon)
export function xrOfGeo(cam, user, target, offsetDeg) {
  const d = enuOffset(user.lat, user.lon, target.lat, target.lon);
  const E = xrDir(90, offsetDeg), N = xrDir(0, offsetDeg);
  return { x: cam.x + d.e * E.x + d.n * N.x, z: cam.z + d.e * E.z + d.n * N.z, dist: Math.hypot(d.e, d.n) };
}
// Inverse: geo of an XR point, given camera XR pos + its GPS
export function geoOfXr(cam, user, P, offsetDeg) {
  const dx = P.x - cam.x, dz = P.z - cam.z;
  // XR dir for heading h: (sin(h-off), -cos(h-off)); so ENU e = proj on E, n = proj on N
  const E = xrDir(90, offsetDeg), N = xrDir(0, offsetDeg);
  return enuToLatLon(user.lat, user.lon, dx * E.x + dz * E.z, dx * N.x + dz * N.z);
}

// weighted GPS average of recent fixes {lat,lon,acc,t}
export function gpsAverage(fixes, now, windowMs = 15000) {
  const use = fixes.filter(f => now - f.t <= windowMs && f.acc > 0 && f.acc < 50);
  if (!use.length) return null;
  let w = 0, la = 0, lo = 0;
  for (const f of use) { const k = 1 / (f.acc * f.acc); w += k; la += f.lat * k; lo += f.lon * k; }
  const best = Math.min(...use.map(f => f.acc));
  return { lat: la / w, lon: lo / w, acc: best, n: use.length };
}

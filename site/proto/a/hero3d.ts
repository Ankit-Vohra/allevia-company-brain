// Prototype A's hero: the company brain as a real 3D object (three.js), a warm translucent brain on warm paper with orbits around it
// like electrons around a nucleus. On the orbits ride the founder's tools (their logos) and the AI team (their portraits), as HTML
// chips moved by `transform` so they stay sharp. Every few seconds one of the team steps up, a speech bubble asks a real founder
// question, its light path enters the brain, the signal spreads across the folds to the regions the answer lives in, the tools it reads
// pulse in, and a short answer resolves. Everything that moves is transform, opacity or a shader uniform; the page's scroll is native.
//
// Still frames for QA: add ?still=1 (a frame at ?t= seconds, question ?q=). Reduced motion shows one still frame and a "Next question"
// button. The loop pauses off-screen and in a hidden tab. Phones get fewer orbits, fewer sparks and no antialiasing.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import brainUrl from "../shared/3d/brain.glb?url";
import { isPhone, reduceMotion, saveData } from "../shared/chrome.ts";

THREE.ColorManagement.enabled = false; // colours below are plain sRGB values; nothing is converted

interface Q { id: string; agent: string; agentName: string; q: string; tools: string[]; toolNames: string[]; regions: string[]; path: string[]; answer: string; waits: boolean }
interface ChipState {
  el: HTMLElement; kind: "agent" | "tool"; id: string; orbit: number; angle: number; speedMul: number; targetMul: number;
  introAt: number; introP: number; x: number; y: number; behind: boolean; glow: number; scale: number;
}
interface OrbitDef { rx: number; rz: number; rotX: number; rotY: number; rotZ: number; speed: number; dir: 1 | -1 }

// Eight orbits at different tilts: four close for the team, four wide for the tools. Radii are in brain radii.
const ORBITS: OrbitDef[] = [
  { rx: 2.0, rz: 1.75, rotX: 0.35, rotY: 0.2, rotZ: 0.25, speed: 0.2, dir: 1 },
  { rx: 2.15, rz: 1.9, rotX: -0.55, rotY: 1.2, rotZ: -0.2, speed: 0.17, dir: -1 },
  { rx: 2.3, rz: 2.0, rotX: 0.9, rotY: -0.6, rotZ: 0.3, speed: 0.15, dir: 1 },
  { rx: 2.45, rz: 2.15, rotX: -0.25, rotY: 2.2, rotZ: 0.9, speed: 0.13, dir: -1 },
  { rx: 2.7, rz: 2.2, rotX: 0.15, rotY: 0.8, rotZ: -0.4, speed: 0.11, dir: 1 },
  { rx: 2.9, rz: 2.4, rotX: -0.75, rotY: -1.1, rotZ: 0.5, speed: 0.095, dir: -1 },
  { rx: 3.05, rz: 2.55, rotX: 0.6, rotY: 2.0, rotZ: -0.9, speed: 0.085, dir: 1 },
  { rx: 3.2, rz: 2.7, rotX: -0.3, rotY: -2.3, rotZ: 0.2, speed: 0.075, dir: -1 },
];

// Where on the brain each cluster of the company graph lives (a direction in the brain's own frame: +x front, +y up, +z the viewer's side)
const REGION_DIR: Record<string, [number, number, number]> = {
  people: [0.85, 0.35, 0.3], signups: [-0.1, 0.95, 0.2], app: [-0.9, 0.2, 0.2], reach: [0.2, -0.45, 0.85], customers: [-0.55, -0.7, 0.3],
};

const BRAIN_SCALE = 1.3;
const EASE = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const rng = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };

function glowTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d")!; const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,244,214,1)"); grad.addColorStop(0.18, "rgba(255,214,120,0.95)"); grad.addColorStop(0.5, "rgba(224,150,40,0.35)"); grad.addColorStop(1, "rgba(224,150,40,0)");
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

// ---------- the shaders ----------
const REGION_GLSL = /* glsl */ `
uniform vec4 uRegs[4];
float regionGlow(vec3 d) { float s = 0.0; for (int i = 0; i < 4; i++) { vec4 r = uRegs[i]; float a = acos(clamp(dot(d, r.xyz), -1.0, 1.0)); s += r.w * exp(-a * a * 4.2); } return s; }
`;

const BRAIN_VERT = /* glsl */ `
attribute float aCavity;
varying vec3 vN; varying vec3 vV; varying vec3 vObj; varying float vCav;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal); vV = -mv.xyz; vObj = position; vCav = aCavity;
  gl_Position = projectionMatrix * mv;
}`;
const BRAIN_FRAG = /* glsl */ `
precision highp float;
uniform float uTime; uniform float uBreath; uniform float uOpacity;
uniform vec3 uTint1; uniform vec3 uTint2; uniform vec3 uDeep; uniform vec3 uGold; uniform vec3 uRim;
varying vec3 vN; varying vec3 vV; varying vec3 vObj; varying float vCav;
${REGION_GLSL}
void main() {
  vec3 N = normalize(vN); vec3 V = normalize(vV);
  float nv = clamp(dot(N, V), 0.0, 1.0);
  float fres = pow(1.0 - nv, 2.4);
  vec3 L = normalize(vec3(-0.45, 0.75, 0.55));
  float diff = dot(N, L) * 0.5 + 0.5;
  float cav = vCav;
  vec3 col = mix(uTint1, uTint2, clamp(cav * 0.8 + (1.0 - diff) * 0.5, 0.0, 1.0));
  col = mix(col, uDeep, smoothstep(0.52, 1.0, cav) * 0.62);
  col = mix(col, uRim, fres * (0.62 + 0.22 * uBreath));
  float g = regionGlow(normalize(vObj));
  col = mix(col, uGold, clamp(g, 0.0, 1.0) * 0.8) + vec3(1.0, 0.86, 0.5) * g * 0.16;
  float a = mix(0.66, 0.98, fres) * uOpacity;
  a = min(1.0, a + g * 0.22);
  gl_FragColor = vec4(col, a);
}`;

const NEURAL_VERT = /* glsl */ `
attribute float aT; attribute float aPhase; attribute float aSpeed;
uniform float uTime;
varying float vT; varying float vPhase; varying float vSpeed; varying vec3 vObj; varying float vFacing;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFacing = clamp(dot(n, normalize(-mv.xyz)), 0.0, 1.0);
  vT = aT; vPhase = aPhase; vSpeed = aSpeed; vObj = position;
  gl_Position = projectionMatrix * mv;
}`;
const NEURAL_FRAG = /* glsl */ `
precision highp float;
uniform float uTime; uniform float uOpacity; uniform vec3 uBase; uniform vec3 uPulse;
varying float vT; varying float vPhase; varying float vSpeed; varying vec3 vObj; varying float vFacing;
${REGION_GLSL}
void main() {
  float head = fract(uTime * vSpeed + vPhase);
  float behind = fract(head - vT);
  float gate = step(0.42, fract(vPhase * 7.31 + uTime * 0.045));
  float pulse = smoothstep(0.22, 0.0, behind) * gate;
  float g = regionGlow(normalize(vObj));
  float face = smoothstep(0.05, 0.5, vFacing);
  float a = (0.4 + pulse * 0.6 + clamp(g, 0.0, 1.0) * 0.7) * face * uOpacity;
  vec3 col = mix(uBase, uPulse, clamp(pulse + g * 0.8, 0.0, 1.0));
  gl_FragColor = vec4(col, a);
}`;

const SPARK_VERT = /* glsl */ `
attribute float aBirth; attribute float aLife; attribute float aSize;
uniform float uTime; uniform float uPx;
varying float vA; varying float vFacing;
void main() {
  float age = (uTime - aBirth) / aLife;
  vA = (age > 0.0 && age < 1.0) ? sin(age * 3.14159) : 0.0;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vec3 n = normalize(normalMatrix * normal);
  vFacing = clamp(dot(n, normalize(-mv.xyz)), 0.0, 1.0);
  gl_PointSize = aSize * uPx * (0.5 + 0.9 * vA);
  gl_Position = projectionMatrix * mv;
}`;
const SPARK_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D uMap; varying float vA; varying float vFacing;
void main() { vec4 t = texture2D(uMap, gl_PointCoord); float a = t.a * vA * smoothstep(0.05, 0.45, vFacing); gl_FragColor = vec4(t.rgb, a); }`;

const ORBIT_VERT = /* glsl */ `
attribute float aT; varying float vT;
void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const ORBIT_FRAG = /* glsl */ `
precision highp float;
uniform float uHead; uniform float uDir; uniform float uEnergy; uniform float uOpacity; uniform vec3 uBase; uniform vec3 uTrail;
varying float vT;
void main() {
  float d = fract((uHead - vT) * uDir);
  float trail = smoothstep(0.34 + 0.18 * uEnergy, 0.0, d);
  float a = (0.15 + 0.2 * uEnergy + trail * (0.62 + 0.25 * uEnergy)) * uOpacity;
  gl_FragColor = vec4(mix(uBase, uTrail, trail), a);
}`;

const PULSE_VERT = /* glsl */ `
attribute float aT; varying float vT;
void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const PULSE_FRAG = /* glsl */ `
precision highp float;
uniform float uHead; uniform vec3 uColor; uniform float uFade; varying float vT;
void main() { float d = uHead - vT; float a = (d >= 0.0 ? smoothstep(0.42, 0.0, d) : 0.0) * uFade; gl_FragColor = vec4(uColor, a); }`;

interface Pulse { line: THREE.Line; head: THREE.Points; active: boolean; t0: number; dur: number; from: () => THREE.Vector3; toObj: THREE.Vector3; reverse: boolean; after?: () => void; positions: Float32Array }

export async function startHero(root: HTMLElement): Promise<void> {
  const stage = root.querySelector<HTMLElement>("[data-stage]")!;
  const canvas = root.querySelector<HTMLCanvasElement>("[data-canvas]")!;
  const still = root.querySelector<HTMLImageElement>("[data-still]");
  const bubble = root.querySelector<HTMLElement>("[data-bubble]")!;
  const bubbleName = root.querySelector<HTMLElement>("[data-bubble-name]")!;
  const bubbleText = root.querySelector<HTMLElement>("[data-bubble-text]")!;
  const answer = root.querySelector<HTMLElement>("[data-answer]")!;
  const answerText = root.querySelector<HTMLElement>("[data-answer-text]")!;
  const answerHow = root.querySelector<HTMLElement>("[data-answer-how]")!;
  const answerWho = root.querySelector<HTMLElement>("[data-answer-who]")!;
  const answerFace = root.querySelector<HTMLElement>("[data-answer-face]")!;
  const answerOk = root.querySelector<HTMLElement>("[data-answer-ok]")!;
  const nextBtn = root.querySelector<HTMLButtonElement>("[data-next]");
  const data = JSON.parse(root.querySelector("#hero-data")!.textContent!) as { questions: Q[]; counts: { nodes: number; edges: number } };
  const params = new URLSearchParams(location.search);
  const stillMode = params.get("still") === "1";
  const reduced = reduceMotion();
  const phone = isPhone();
  const light = phone || saveData();
  const chipsAll = [...root.querySelectorAll<HTMLElement>("[data-chip]")];

  // ---------- renderer, camera ----------
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: !light, powerPreference: "high-performance" });
  } catch {
    root.classList.add("hero--nogl"); // the cut-out orb picture stays as the brain
    return;
  }
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  const dprCap = light ? 1.5 : 2;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, dprCap));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 60);
  const CAM_DIST = 12.5;
  camera.position.set(0, 0.35, CAM_DIST);
  camera.lookAt(0, 0, 0);
  const world = new THREE.Group(); scene.add(world);
  const brainRoot = new THREE.Group(); world.add(brainRoot);
  const atom = new THREE.Group(); world.add(atom);
  let W = 1, H = 1, copyRight = 0;
  const resize = () => {
    const r = stage.getBoundingClientRect(); W = Math.max(1, r.width); H = Math.max(1, r.height);
    renderer.setSize(W, H, false);
    camera.aspect = W / H;
    const wide = W / H > 1.25 && W > 820;
    const h1 = root.querySelector<HTMLElement>(".hero__h1"); copyRight = wide && h1 ? h1.getBoundingClientRect().right - r.left : 0;
    const shift = wide ? W * 0.17 : 0;
    camera.setViewOffset(W, H, -shift, 0, W, H);
    const fit = wide ? 1 : Math.min(1, (W / H) * 0.95) * (phone ? 0.92 : 1);
    world.scale.setScalar(Math.max(0.5, fit));
    camera.updateProjectionMatrix();
  };
  new ResizeObserver(resize).observe(stage); resize();

  // ---------- the brain ----------
  const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(brainUrl);
  let srcMesh: THREE.Mesh | null = null;
  gltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh && !srcMesh) srcMesh = o as THREE.Mesh; });
  const src = srcMesh as unknown as THREE.Mesh;
  src.updateWorldMatrix(true, false);
  const sGeo = src.geometry;
  const nV = sGeo.getAttribute("position").count;
  const pos = new Float32Array(nV * 3), cav = new Float32Array(nV);
  const tmp = new THREE.Vector3();
  const cavAttr = sGeo.getAttribute("_cavity") ?? sGeo.getAttribute("_CAVITY");
  for (let i = 0; i < nV; i++) {
    tmp.fromBufferAttribute(sGeo.getAttribute("position"), i).applyMatrix4(src.matrixWorld);
    pos[i * 3] = tmp.x; pos[i * 3 + 1] = tmp.y; pos[i * 3 + 2] = tmp.z;
    cav[i] = cavAttr ? cavAttr.getX(i) : 0.4;
  }
  const idxSrc = sGeo.getIndex()!;
  const idx = new Uint32Array(idxSrc.count);
  for (let i = 0; i < idx.length; i++) idx[i] = idxSrc.getX(i);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aCavity", new THREE.BufferAttribute(cav, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  // centre and scale to a unit half-extent, then turn it into the brain's own frame (+x front, +y up, +z the viewer's side)
  const bb = geo.boundingBox!; const centre = bb.getCenter(new THREE.Vector3()); const half = Math.max(...bb.getSize(new THREE.Vector3()).toArray()) / 2;
  const BRAIN_FIX = new THREE.Euler(Number(params.get("fx") ?? 0), Number(params.get("fy") ?? 0), Number(params.get("fz") ?? 0));
  geo.translate(-centre.x, -centre.y, -centre.z); geo.scale(1 / half, 1 / half, 1 / half);
  geo.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(BRAIN_FIX));
  geo.computeVertexNormals();
  const P = geo.getAttribute("position") as THREE.BufferAttribute; const NRM = geo.getAttribute("normal") as THREE.BufferAttribute;

  const regs = Array.from({ length: 4 }, () => new THREE.Vector4(0, 0, 0, 0));
  const brainUniforms = {
    uTime: { value: 0 }, uBreath: { value: 0 }, uOpacity: { value: 0 }, uRegs: { value: regs },
    uTint1: { value: new THREE.Color(0xf8e6b8) }, uTint2: { value: new THREE.Color(0xe6ad48) }, uDeep: { value: new THREE.Color(0xa7651a) },
    uGold: { value: new THREE.Color(0xe49a1c) }, uRim: { value: new THREE.Color(0xbb7c1c) },
  };
  const brainMat = new THREE.ShaderMaterial({ vertexShader: BRAIN_VERT, fragmentShader: BRAIN_FRAG, uniforms: brainUniforms, transparent: true, depthWrite: true });
  const brainMesh = new THREE.Mesh(geo, brainMat); brainMesh.renderOrder = 1; brainRoot.add(brainMesh);
  brainRoot.scale.setScalar(BRAIN_SCALE);

  // surface point nearest to a direction (object space)
  const nrmDirs = new Float32Array(nV * 3);
  for (let i = 0; i < nV; i++) { tmp.fromBufferAttribute(P, i).normalize(); nrmDirs[i * 3] = tmp.x; nrmDirs[i * 3 + 1] = tmp.y; nrmDirs[i * 3 + 2] = tmp.z; }
  const surfacePoint = (d: THREE.Vector3, out = new THREE.Vector3()): THREE.Vector3 => {
    let best = -2, bi = 0;
    for (let i = 0; i < nV; i++) { const s = nrmDirs[i * 3]! * d.x + nrmDirs[i * 3 + 1]! * d.y + nrmDirs[i * 3 + 2]! * d.z; if (s > best) { best = s; bi = i; } }
    return out.fromBufferAttribute(P, bi);
  };
  const regionDir = Object.fromEntries(Object.entries(REGION_DIR).map(([k, v]) => [k, new THREE.Vector3(...v).normalize()]));

  // ---------- the neural paths: lines that follow the valleys of the folds ----------
  const rand = rng(7);
  const adjStart = new Uint32Array(nV + 1); const deg = new Uint32Array(nV);
  for (let t = 0; t < idx.length; t += 3) { deg[idx[t]!]!++; deg[idx[t + 1]!]!++; deg[idx[t + 2]!]!++; }
  for (let i = 0; i < nV; i++) adjStart[i + 1] = adjStart[i]! + deg[i]! * 2; // two entries per triangle corner (duplicates are dropped when read)
  const adj = new Int32Array(adjStart[nV]!).fill(-1); const fill = new Uint32Array(nV);
  const addAdj = (a: number, b: number) => { adj[adjStart[a]! + fill[a]!++] = b; };
  for (let t = 0; t < idx.length; t += 3) { const a = idx[t]!, b = idx[t + 1]!, c = idx[t + 2]!; addAdj(a, b); addAdj(a, c); addAdj(b, a); addAdj(b, c); addAdj(c, a); addAdj(c, b); }
  // (the adjacency arrays above are sized by degree; the loop writes two entries per triangle corner, so grow if needed)
  const nbrs = (v: number): number[] => { const out: number[] = []; for (let k = adjStart[v]!; k < adjStart[v + 1]!; k++) { const n = adj[k]!; if (n >= 0 && !out.includes(n)) out.push(n); } return out; };

  const PATHS = light ? 34 : 70, STEPS = 54;
  const lp: number[] = [], ln: number[] = [], lt: number[] = [], lph: number[] = [], lsp: number[] = [];
  const sparkSites: number[] = [];
  const v0 = new THREE.Vector3(), v1 = new THREE.Vector3(), dirv = new THREE.Vector3();
  let made = 0, tries = 0;
  while (made < PATHS && tries++ < PATHS * 40) {
    const s = Math.floor(rand() * nV);
    if (cav[s]! < 0.62) continue;
    const visited = [s]; let prev = s; let cur = -1; let best = -9;
    for (const n of nbrs(s)) { const sc = cav[n]! + rand() * 0.2; if (sc > best) { best = sc; cur = n; } }
    if (cur < 0) continue;
    dirv.set(P.getX(cur) - P.getX(prev), P.getY(cur) - P.getY(prev), P.getZ(cur) - P.getZ(prev)).normalize();
    const pts = [prev, cur];
    for (let k = 0; k < STEPS; k++) {
      let nb = -1; best = -9;
      for (const n of nbrs(cur)) {
        if (visited.includes(n)) continue;
        v1.set(P.getX(n) - P.getX(cur), P.getY(n) - P.getY(cur), P.getZ(n) - P.getZ(cur)).normalize();
        const sc = cav[n]! * 1.0 + dirv.dot(v1) * 0.9 + rand() * 0.18;
        if (sc > best) { best = sc; nb = n; }
      }
      if (nb < 0 || cav[nb]! < 0.3) break;
      v1.set(P.getX(nb) - P.getX(cur), P.getY(nb) - P.getY(cur), P.getZ(nb) - P.getZ(cur)).normalize();
      if (dirv.dot(v1) < -0.2) break;
      dirv.lerp(v1, 0.5).normalize();
      visited.push(nb); if (visited.length > 8) visited.shift();
      pts.push(nb); prev = cur; cur = nb;
    }
    if (pts.length < 14) continue;
    made++;
    const phase = rand(), speed = 0.05 + rand() * 0.09;
    const take = pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1);
    for (let i = 0; i < take.length - 1; i++) {
      for (const [vi, tt] of [[take[i]!, i / (take.length - 1)], [take[i + 1]!, (i + 1) / (take.length - 1)]] as [number, number][]) {
        v0.fromBufferAttribute(P, vi); tmp.fromBufferAttribute(NRM, vi);
        lp.push(v0.x + tmp.x * 0.006, v0.y + tmp.y * 0.006, v0.z + tmp.z * 0.006); ln.push(tmp.x, tmp.y, tmp.z); lt.push(tt); lph.push(phase); lsp.push(speed);
      }
    }
    for (let i = 0; i < take.length; i += 5) sparkSites.push(take[i]!);
  }
  const neuralGeo = new THREE.BufferGeometry();
  neuralGeo.setAttribute("position", new THREE.Float32BufferAttribute(lp, 3)); neuralGeo.setAttribute("normal", new THREE.Float32BufferAttribute(ln, 3));
  neuralGeo.setAttribute("aT", new THREE.Float32BufferAttribute(lt, 1)); neuralGeo.setAttribute("aPhase", new THREE.Float32BufferAttribute(lph, 1)); neuralGeo.setAttribute("aSpeed", new THREE.Float32BufferAttribute(lsp, 1));
  const neuralUniforms = { uTime: brainUniforms.uTime, uOpacity: { value: 0 }, uRegs: { value: regs }, uBase: { value: new THREE.Color(0xb06a16) }, uPulse: { value: new THREE.Color(0xe8590a) } };
  const neural = new THREE.LineSegments(neuralGeo, new THREE.ShaderMaterial({ vertexShader: NEURAL_VERT, fragmentShader: NEURAL_FRAG, uniforms: neuralUniforms, transparent: true, depthWrite: false }));
  neural.renderOrder = 2; brainRoot.add(neural);

  // synapse sparks: small flashes that appear on the paths and fade
  const SPARKS = light ? 14 : 36;
  const sGeoP = new Float32Array(SPARKS * 3), sGeoN = new Float32Array(SPARKS * 3), sBirth = new Float32Array(SPARKS), sLife = new Float32Array(SPARKS), sSize = new Float32Array(SPARKS);
  const respawn = (i: number, now: number) => {
    const vi = sparkSites[Math.floor(rand() * sparkSites.length)] ?? 0;
    sGeoP[i * 3] = P.getX(vi) * 1.004; sGeoP[i * 3 + 1] = P.getY(vi) * 1.004; sGeoP[i * 3 + 2] = P.getZ(vi) * 1.004;
    sGeoN[i * 3] = NRM.getX(vi); sGeoN[i * 3 + 1] = NRM.getY(vi); sGeoN[i * 3 + 2] = NRM.getZ(vi);
    sBirth[i] = now + rand() * 3.2; sLife[i] = 0.5 + rand() * 0.6; sSize[i] = 11 + rand() * 11;
  };
  for (let i = 0; i < SPARKS; i++) respawn(i, -4 + rand() * 4);
  const sparkGeo = new THREE.BufferGeometry();
  const sPosAttr = new THREE.BufferAttribute(sGeoP, 3), sNrmAttr = new THREE.BufferAttribute(sGeoN, 3), sBirthAttr = new THREE.BufferAttribute(sBirth, 1), sLifeAttr = new THREE.BufferAttribute(sLife, 1), sSizeAttr = new THREE.BufferAttribute(sSize, 1);
  sparkGeo.setAttribute("position", sPosAttr); sparkGeo.setAttribute("normal", sNrmAttr); sparkGeo.setAttribute("aBirth", sBirthAttr); sparkGeo.setAttribute("aLife", sLifeAttr); sparkGeo.setAttribute("aSize", sSizeAttr);
  const glowTex = glowTexture();
  const sparkUniforms = { uTime: brainUniforms.uTime, uPx: { value: renderer.getPixelRatio() }, uMap: { value: glowTex } };
  const sparks = new THREE.Points(sparkGeo, new THREE.ShaderMaterial({ vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG, uniforms: sparkUniforms, transparent: true, depthWrite: false }));
  sparks.renderOrder = 3; brainRoot.add(sparks);

  // ---------- the orbits ----------
  const orbitCount = phone ? 6 : ORBITS.length;
  const orbitObjs = ORBITS.slice(0, orbitCount).map((o, i) => {
    const g = new THREE.Group(); g.rotation.set(o.rotX, o.rotY, o.rotZ, "YXZ"); atom.add(g);
    const N = 220; const p = new Float32Array((N + 1) * 3), t = new Float32Array(N + 1);
    for (let k = 0; k <= N; k++) { const a = (k / N) * Math.PI * 2; p[k * 3] = Math.cos(a) * o.rx; p[k * 3 + 1] = 0; p[k * 3 + 2] = Math.sin(a) * o.rz; t[k] = k / N; }
    const lg = new THREE.BufferGeometry(); lg.setAttribute("position", new THREE.BufferAttribute(p, 3)); lg.setAttribute("aT", new THREE.BufferAttribute(t, 1));
    const u = { uHead: { value: 0 }, uDir: { value: o.dir }, uEnergy: { value: 0 }, uOpacity: { value: 0 }, uBase: { value: new THREE.Color(0x5c4e3d) }, uTrail: { value: new THREE.Color(0xd08a1a) } };
    const line = new THREE.Line(lg, new THREE.ShaderMaterial({ vertexShader: ORBIT_VERT, fragmentShader: ORBIT_FRAG, uniforms: u, transparent: true, depthWrite: false }));
    line.renderOrder = 4; g.add(line);
    return { def: o, group: g, uniforms: u, head: (i * 0.37) % 1, energy: 0, energyTarget: 0 };
  });

  // electrons: small glowing beads riding the orbits
  const electrons: { orbit: number; angle: number; speedMul: number }[] = [];
  orbitObjs.forEach((_, i) => { electrons.push({ orbit: i, angle: i * 1.9, speedMul: 1.35 }); if (i >= 4) electrons.push({ orbit: i, angle: i * 1.9 + Math.PI, speedMul: 0.9 }); });
  const ePos = new Float32Array(electrons.length * 3);
  const eGeo = new THREE.BufferGeometry(); eGeo.setAttribute("position", new THREE.BufferAttribute(ePos, 3));
  const eMat = new THREE.PointsMaterial({ map: glowTex, size: phone ? 0.5 : 0.42, sizeAttenuation: true, transparent: true, depthWrite: false, color: 0xffffff, opacity: 0 });
  const ePoints = new THREE.Points(eGeo, eMat); ePoints.renderOrder = 5; ePoints.frustumCulled = false; scene.add(ePoints);

  // ---------- light pulses (a tool or a person to the brain, and back out) ----------
  const PULSES = 10, PN = 40;
  const pulses: Pulse[] = [];
  for (let i = 0; i < PULSES; i++) {
    const positions = new Float32Array(PN * 3), tt = new Float32Array(PN);
    for (let k = 0; k < PN; k++) tt[k] = k / (PN - 1);
    const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.BufferAttribute(positions, 3)); g.setAttribute("aT", new THREE.BufferAttribute(tt, 1));
    const u = { uHead: { value: 0 }, uColor: { value: new THREE.Color(0xe07a14) }, uFade: { value: 1 } };
    const line = new THREE.Line(g, new THREE.ShaderMaterial({ vertexShader: PULSE_VERT, fragmentShader: PULSE_FRAG, uniforms: u, transparent: true, depthWrite: false }));
    line.visible = false; line.frustumCulled = false; line.renderOrder = 6; scene.add(line);
    const hp = new Float32Array(3); const hg = new THREE.BufferGeometry(); hg.setAttribute("position", new THREE.BufferAttribute(hp, 3));
    const head = new THREE.Points(hg, new THREE.PointsMaterial({ map: glowTex, size: 0.62, sizeAttenuation: true, transparent: true, depthWrite: false, opacity: 1 }));
    head.visible = false; head.frustumCulled = false; head.renderOrder = 7; scene.add(head);
    pulses.push({ line, head, active: false, t0: 0, dur: 1, from: () => tmp, toObj: new THREE.Vector3(), reverse: false, positions });
  }
  const inv = new THREE.Matrix4();
  const bez = (a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, t: number, out: THREE.Vector3) => { const u = 1 - t; return out.set(u * u * a.x + 2 * u * t * c.x + t * t * b.x, u * u * a.y + 2 * u * t * c.y + t * t * b.y, u * u * a.z + 2 * u * t * c.z + t * t * b.z); };
  let now = 0;
  const startPulse = (from: () => THREE.Vector3, dur: number, reverse = false, after?: () => void, toDir?: THREE.Vector3) => {
    const p = pulses.find((x) => !x.active); if (!p) return;
    brainRoot.updateWorldMatrix(true, false); inv.copy(brainRoot.matrixWorld).invert();
    const f = from();
    const d = toDir ?? f.clone().applyMatrix4(inv).normalize();
    p.toObj.copy(surfacePoint(d));
    p.active = true; p.t0 = now; p.dur = dur; p.from = from; p.reverse = reverse; p.after = after; p.line.visible = true; p.head.visible = true;
  };
  const a0 = new THREE.Vector3(), c0 = new THREE.Vector3(), b0 = new THREE.Vector3(), q0 = new THREE.Vector3(), mid = new THREE.Vector3();
  const updatePulses = () => {
    for (const p of pulses) {
      if (!p.active) continue;
      const k = (now - p.t0) / p.dur;
      if (k >= 1.15) { p.active = false; p.line.visible = false; p.head.visible = false; p.after?.(); continue; }
      a0.copy(p.from()); b0.copy(p.toObj).applyMatrix4(brainRoot.matrixWorld);
      if (p.reverse) { q0.copy(a0); a0.copy(b0); b0.copy(q0); }
      mid.copy(a0).add(b0).multiplyScalar(0.5); c0.copy(mid).add(q0.copy(mid).normalize().multiplyScalar(0.55)); c0.y += 0.35;
      for (let i = 0; i < PN; i++) { bez(a0, c0, b0, i / (PN - 1), q0); p.positions[i * 3] = q0.x; p.positions[i * 3 + 1] = q0.y; p.positions[i * 3 + 2] = q0.z; }
      (p.line.geometry.getAttribute("position") as THREE.BufferAttribute).needsUpdate = true;
      const h = EASE(clamp01(k)); (p.line.material as THREE.ShaderMaterial).uniforms.uHead!.value = h;
      (p.line.material as THREE.ShaderMaterial).uniforms.uFade!.value = k > 1 ? Math.max(0, 1 - (k - 1) / 0.15) : 1;
      bez(a0, c0, b0, h, q0); const hp = p.head.geometry.getAttribute("position") as THREE.BufferAttribute; hp.setXYZ(0, q0.x, q0.y, q0.z); hp.needsUpdate = true;
      (p.head.material as THREE.PointsMaterial).opacity = k > 1 ? Math.max(0, 1 - (k - 1) / 0.15) : 1;
    }
  };

  // ---------- chips ----------
  const chips: ChipState[] = chipsAll.map((el, i) => {
    const orbit = Number(el.dataset.orbit); const inOrbit = chipsAll.filter((c) => Number(c.dataset.orbit) === orbit); const k = inOrbit.indexOf(el);
    return { el, kind: el.dataset.kind as "agent" | "tool", id: el.dataset.id!, orbit, angle: (k / inOrbit.length) * Math.PI * 2 + orbit * 0.9, speedMul: 1, targetMul: 1, introAt: 0.25 + i * 0.1, introP: 0, x: 0, y: 0, behind: false, glow: 0, scale: 1 };
  }).filter((c) => c.orbit < orbitCount);
  chipsAll.forEach((el) => { if (Number(el.dataset.orbit) >= orbitCount) el.hidden = true; });
  const chipById = (id: string) => chips.find((c) => c.id === id);

  const chipWorld = (c: ChipState, out: THREE.Vector3): THREE.Vector3 => {
    const o = orbitObjs[c.orbit]!; out.set(Math.cos(c.angle) * o.def.rx, 0, Math.sin(c.angle) * o.def.rz);
    o.group.updateWorldMatrix(true, false); return out.applyMatrix4(o.group.matrixWorld);
  };

  // ---------- the questions ----------
  let qi = Number(params.get("q") ?? 0) % data.questions.length;
  let cycleT = 0; let cycleOn = false; let speaker: ChipState | null = null;
  const fired = new Set<string>();
  let signal: { dirs: THREE.Vector3[]; t0: number; leg: number } | null = null;
  const regEnergy = [0, 0, 0];
  const setText = (el: HTMLElement, s: string) => { el.textContent = s; };
  const wordsIn = (el: HTMLElement, text: string) => {
    el.textContent = "";
    text.split(" ").forEach((w, i) => { const s = document.createElement("span"); s.className = "w"; s.textContent = w + " "; s.style.transitionDelay = `${i * 28}ms`; el.append(s); });
    void el.offsetWidth; el.classList.add("is-in");
  };
  const showBubble = (q: Q) => {
    setText(bubbleName, q.agentName); setText(bubbleText, q.q);
    bubble.classList.add("is-on");
  };
  const showAnswer = (q: Q, instant = false) => {
    setText(answerWho, `${q.agentName} answers`);
    const a = AGENT_FACE.get(q.agent); answerFace.innerHTML = a ?? "";
    answerOk.hidden = !q.waits;
    answerHow.innerHTML = `<span class="how__lab">How we know</span>${q.path.map((p) => `<span class="how__pill">${p}</span>`).join('<span class="how__arrow" aria-hidden="true"></span>')}`;
    answerText.classList.remove("is-in");
    if (instant) { answerText.textContent = q.answer; answerText.classList.add("is-in"); } else wordsIn(answerText, q.answer);
    answer.classList.add("is-on");
  };
  const AGENT_FACE = new Map<string, string>();
  chipsAll.filter((c) => c.dataset.kind === "agent").forEach((c) => AGENT_FACE.set(c.dataset.id!, c.querySelector(".orb-chip__face")?.innerHTML ?? ""));

  // A question starts when its asker is in a good place: in front of the brain, in view and clear of the headline.
  let waiting = false, waitT = 0;
  const startCycle = (i: number) => {
    qi = i % data.questions.length; cycleT = 0; fired.clear();
    speaker = chipById(data.questions[qi]!.agent) ?? null;
    cycleOn = false; waiting = true; waitT = 0;
  };
  const speakerReady = (): boolean => !!speaker && !speaker.behind && speaker.introP >= 1 && speaker.x > copyRight + 250 && speaker.x < W - 90 && speaker.y > 130 && speaker.y < H - 280
    && !chips.some((c) => c !== speaker && Math.hypot(c.x - speaker!.x, c.y - speaker!.y) < 64);
  const at = (name: string, t: number, fn: () => void) => { if (cycleT >= t && !fired.has(name)) { fired.add(name); fn(); } };
  const SCHEDULE_END = 10.6;
  const stepCycle = () => {
    const q = data.questions[qi]!;
    at("bubble", 0.7, () => { showBubble(q); if (speaker) speaker.glow = 1; });
    at("ask", 1.9, () => {
      const o = speaker ? orbitObjs[speaker.orbit] : undefined; if (o) o.energyTarget = 1;
      if (speaker) startPulse(() => chipWorld(speaker!, a1), 0.95, false, () => beginSignal(q));
    });
    q.tools.forEach((tid, k) => at(`tool${k}`, 3.1 + k * 0.5, () => {
      const c = chipById(tid); if (!c) return; c.glow = 1; const o = orbitObjs[c.orbit]; if (o) o.energyTarget = 1;
      startPulse(() => chipWorld(c, a2), 1.0, false);
    }));
    at("answer", 4.6, () => showAnswer(q));
    at("end", 9.4, () => { bubble.classList.remove("is-on"); answer.classList.remove("is-on"); if (speaker) { speaker.targetMul = 1; speaker.glow = 0; } orbitObjs.forEach((o) => (o.energyTarget = 0)); chips.forEach((c) => (c.glow = 0)); });
    if (cycleT >= SCHEDULE_END) startCycle(qi + 1);
  };
  const a1 = new THREE.Vector3(), a2 = new THREE.Vector3();
  const beginSignal = (q: Q) => {
    brainRoot.updateWorldMatrix(true, false); inv.copy(brainRoot.matrixWorld).invert();
    const entry = (speaker ? chipWorld(speaker, a1).clone() : new THREE.Vector3(1, 0, 0)).applyMatrix4(inv).normalize();
    const dirs = [entry, ...q.regions.map((r) => regionDir[r]!).filter(Boolean)];
    signal = { dirs, t0: now, leg: 0.85 };
    regEnergy[0] = regEnergy[1] = regEnergy[2] = 0;
  };
  const updateSignal = (dt: number) => {
    // the front point travels from the entry across the surface to each region in turn; each region then glows and fades
    for (let i = 0; i < 3; i++) regs[i]!.w = Math.max(0, (regs[i]!.w - dt * 0.34));
    if (!signal) { regs[3]!.w = Math.max(0, regs[3]!.w - dt * 2); return; }
    const k = (now - signal.t0) / signal.leg; const legs = signal.dirs.length - 1;
    if (legs <= 0) { signal = null; return; }
    const li = Math.min(legs - 1, Math.floor(k)); const f = clamp01(k - li);
    const a = signal.dirs[li]!, b = signal.dirs[li + 1]!;
    tmp.copy(a).lerp(b, EASE(f)).normalize(); regs[3]!.set(tmp.x, tmp.y, tmp.z, 0.9);
    if (f > 0.6 && li < 3) { const r = regs[li]!; r.set(b.x, b.y, b.z, Math.max(r.w, 1)); }
    if (k >= legs + 0.2) { signal = null; }
  };

  // ---------- the frame ----------
  const mouse = { x: 0, y: 0, tx: 0, ty: 0 };
  if (!reduced && !stillMode) window.addEventListener("pointermove", (e) => { const r = stage.getBoundingClientRect(); mouse.tx = ((e.clientX - r.left) / r.width - 0.5) * 2; mouse.ty = ((e.clientY - r.top) / r.height - 0.5) * 2; }, { passive: true });
  const v = new THREE.Vector3(), vp = new THREE.Vector3(), centreNdc = new THREE.Vector3();
  let intro = 0;
  const frame = (dt: number) => {
    now += dt; intro += dt;
    brainUniforms.uTime.value = now; brainUniforms.uBreath.value = 0.5 + 0.5 * Math.sin(now * 0.95);
    const fade = clamp01((intro - 0.1) / 1.2);
    brainUniforms.uOpacity.value = EASE(fade); neuralUniforms.uOpacity.value = EASE(clamp01((intro - 0.6) / 1.2));
    mouse.x += (mouse.tx - mouse.x) * (1 - Math.exp(-dt * 3)); mouse.y += (mouse.ty - mouse.y) * (1 - Math.exp(-dt * 3));
    brainRoot.rotation.y += dt * 0.13; world.rotation.y = mouse.x * 0.16; world.rotation.x = mouse.y * 0.09;
    brainRoot.position.y = Math.sin(now * 0.8) * 0.025; brainRoot.scale.setScalar(BRAIN_SCALE * (1 + Math.sin(now * 0.95) * 0.008));
    atom.rotation.y += dt * 0.035;
    updateSignal(dt);
    // orbits and electrons
    orbitObjs.forEach((o, i) => { o.head = (o.head + dt * o.def.speed * 1.35 * o.def.dir * (1 + o.energy * 0.6) / (Math.PI * 2) + 1) % 1; o.energy += (o.energyTarget - o.energy) * (1 - Math.exp(-dt * 3));
      o.uniforms.uHead.value = o.def.dir === 1 ? o.head : 1 - o.head; o.uniforms.uEnergy.value = o.energy; o.uniforms.uOpacity.value = EASE(clamp01((intro - 0.25 - i * 0.1) / 0.9)); });
    eMat.opacity = EASE(clamp01((intro - 1) / 1));
    electrons.forEach((e, i) => { const o = orbitObjs[e.orbit]!; e.angle += dt * o.def.speed * o.def.dir * e.speedMul * 1.35; if (i === electrons.findIndex((x) => x.orbit === e.orbit)) o.head = ((e.angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2) / (Math.PI * 2);
      v.set(Math.cos(e.angle) * o.def.rx, 0, Math.sin(e.angle) * o.def.rz); o.group.updateWorldMatrix(true, false); v.applyMatrix4(o.group.matrixWorld); ePos[i * 3] = v.x; ePos[i * 3 + 1] = v.y; ePos[i * 3 + 2] = v.z; });
    eGeo.getAttribute("position").needsUpdate = true;
    // sparks
    for (let i = 0; i < SPARKS; i++) if (now - sBirth[i]! > sLife[i]! + 0.1) { respawn(i, now); sPosAttr.needsUpdate = sNrmAttr.needsUpdate = sBirthAttr.needsUpdate = sLifeAttr.needsUpdate = sSizeAttr.needsUpdate = true; }
    // the questions
    if (waiting) { waitT += dt; if (speakerReady() || waitT > 8) { waiting = false; cycleOn = true; if (speaker) speaker.targetMul = 0; } }
    else if (cycleOn) { cycleT += dt; stepCycle(); }
    else if (intro > 2.4 && !stillMode) startCycle(qi);
    updatePulses();
    world.updateMatrixWorld(true);
    // chips follow their orbits; behind the brain they dim; the speaker comes to a stop
    centreNdc.set(0, 0, 0).applyMatrix4(world.matrixWorld).project(camera);
    const cx = (centreNdc.x * 0.5 + 0.5) * W, cy = (1 - (centreNdc.y * 0.5 + 0.5)) * H;
    vp.set(1.05 * BRAIN_SCALE * world.scale.x, 0, 0).add(v.set(0, 0, 0).applyMatrix4(world.matrixWorld)).project(camera); const brainPx = Math.abs((vp.x * 0.5 + 0.5) * W - cx);
    const camPos = camera.position;
    const brainDist = camPos.distanceTo(v.set(0, 0, 0).applyMatrix4(world.matrixWorld));
    for (const c of chips) {
      const o = orbitObjs[c.orbit]!;
      c.speedMul += (c.targetMul - c.speedMul) * (1 - Math.exp(-dt * 4)); c.angle += dt * o.def.speed * o.def.dir * c.speedMul * 1.35;
      c.introP = clamp01((intro - c.introAt) / 1.1);
      chipWorld(c, v); const dist = camPos.distanceTo(v);
      const p0 = v.clone(); const out = p0.clone().sub(v.set(0, 0, 0).applyMatrix4(world.matrixWorld)).multiplyScalar(1.5 * (1 - EASE(c.introP)));
      p0.add(out); p0.project(camera);
      const x = (p0.x * 0.5 + 0.5) * W, y = (1 - (p0.y * 0.5 + 0.5)) * H;
      const depthK = clamp01((brainDist + 3.3 - dist) / 6.6); // 1 nearest, 0 farthest
      c.scale = (0.74 + 0.46 * depthK) * (0.6 + 0.4 * EASE(c.introP)) * (1 + c.glow * 0.12);
      const behind = dist > brainDist && Math.hypot(x - cx, y - cy) < brainPx * 0.98;
      if (behind !== c.behind) { c.behind = behind; c.el.classList.toggle("is-behind", behind); }
      c.el.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%) scale(${c.scale.toFixed(3)})`;
      c.el.style.opacity = String((behind ? 0.32 : 0.55 + 0.45 * depthK) * EASE(c.introP));
      c.el.style.zIndex = String(c === speaker && cycleOn ? 26 : c.glow > 0.5 ? 24 : behind ? 1 : 3 + Math.round(depthK * 10));
      c.x = x; c.y = y;
      const on = c.glow > 0.5; if (on !== c.el.classList.contains("is-on")) c.el.classList.toggle("is-on", on);
    }
    // the speech bubble stays by its speaker; the answer sits under the brain
    if (speaker && bubble.classList.contains("is-on")) {
      const bw = bubble.offsetWidth || 220;
      const left = speaker.x - 18 - bw > copyRight + 12 && speaker.x > cx - brainPx * 0.2; bubble.classList.toggle("is-left", left);
      bubble.style.transform = `translate3d(${(speaker.x + (left ? -18 : 18)).toFixed(1)}px, ${(speaker.y - 30).toFixed(1)}px, 0) translate(${left ? "-100%" : "0"}, -100%)`;
    }
    answer.style.setProperty("--cx", `${cx.toFixed(0)}px`);
    stage.style.setProperty("--bx", `${cx.toFixed(1)}px`); stage.style.setProperty("--by", `${cy.toFixed(1)}px`); stage.style.setProperty("--br", `${brainPx.toFixed(1)}px`);
    renderer.render(scene, camera);
  };

  // ---------- run ----------
  if (params.get("bare") === "1") { // QA and the first-paint picture: the brain alone on a transparent page
    orbitObjs.forEach((o) => (o.group.visible = false)); ePoints.visible = false; sparks.visible = false; document.documentElement.classList.add("is-bare");
  }
  root.classList.add("is-ready");
  stage.classList.add("is-live");
  const advance = (seconds: number, step = 1 / 30) => { let t = 0; while (t < seconds) { const d = Math.min(step, seconds - t); frame(d); t += d; } };
  (window as unknown as { __hero: unknown }).__hero = { advance, ask: (i: number) => { startCycle(i); }, frame, get now() { return now; } };
  if (stillMode || reduced) {
    // one calm frame: everything in place, the first answer showing
    advance(3.2);
    if (stillMode) { startCycle(qi); let guard = 0; while (waiting && guard++ < 600) frame(1 / 30); advance(Number(params.get("t") ?? 6)); }
    if (reduced && !stillMode) {
      cycleOn = false; speaker = null;
      const q = data.questions[qi]!; showBubble(q); showAnswer(q, true);
      const sp = chipById(q.agent); if (sp) { sp.glow = 1; frame(0.0001); }
      if (nextBtn) { nextBtn.hidden = false; nextBtn.addEventListener("click", () => { qi = (qi + 1) % data.questions.length; const n = data.questions[qi]!; showBubble(n); showAnswer(n, true); chips.forEach((c) => (c.glow = 0)); const s = chipById(n.agent); if (s) s.glow = 1; frame(0.0001); }); }
    }
    if (still) still.classList.add("is-gone");
    return;
  }
  let running = false, last = 0, visible = true; let raf = 0;
  const loop = (ts: number) => { if (!running) return; const dt = Math.min(0.05, (ts - last) / 1000); last = ts; frame(dt); raf = requestAnimationFrame(loop); };
  const start = () => { if (running || !visible || document.hidden) return; running = true; last = performance.now(); raf = requestAnimationFrame(loop); };
  const stop = () => { running = false; cancelAnimationFrame(raf); };
  new IntersectionObserver(([e]) => { visible = !!e?.isIntersecting; visible ? start() : stop(); }, { threshold: 0.05 }).observe(root);
  document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
  frame(0.016);
  if (still) requestAnimationFrame(() => still.classList.add("is-gone"));
  start();
}

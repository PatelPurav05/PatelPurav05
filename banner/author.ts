import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANIMATION_DOCUMENT_VERSION,
  assertValidAnimationDocument,
  constant,
  parseSvgPath,
  withComputedRevision,
  type Animatable,
  type AnimationDocument,
  type Color,
  type CubicBezier,
  type EffectNode,
  type EffectParameter,
  type GroupNode,
  type PathContour,
  type PathData,
  type PathNode,
  type PathVertex,
  type SceneNode,
  type ShapeStyle,
  type Transform25D,
  type Vec2,
  type Vec3,
} from "@clayzo/animation/authoring";

// Art direction. A GitHub profile banner, one lockup on the page's own ground:
// the Clayzo halftone minifig on the left, "purav" on the right in the liquid
// teal stroke from the platform's loading screen. The print sparks in (the
// punch), the figure winds up and waves three times toward the name while the
// name writes itself in one continuous stroke (the flow), holds, blinks, then
// the print is eaten and the ink drains so the loop starts clean. Two inks on
// the ground: graphite or paper, and teal. `light` prints graphite on white;
// `dark` inverts the screen so the figure reads as a negative on GitHub's dark
// ground.
//
// The rig, the springs and the halftone screen come from clayzo.com's 404
// scene (animations/notfound/author.ts); the stroke's liquid flow comes from
// the platform's loading wordmark.

const THEME = process.argv[2] === "dark" ? "dark" : "light";

const W = 1300;
const H = 500;
const TPS = 200;
const FPS = 25;
const TPF = TPS / FPS;
const TAU = Math.PI * 2;

const IN_OUT: CubicBezier = { x1: 0.45, y1: 0, x2: 0.55, y2: 1 };
const OUT: CubicBezier = { x1: 0.16, y1: 1, x2: 0.3, y2: 1 };
const DRAW: CubicBezier = { x1: 0.42, y1: 0, x2: 0.3, y2: 1 };

const PALETTE = {
  light: {
    ground: "#ffffff",
    inkGraphite: "0.176, 0.161, 0.133",
    inkTeal: "0.043, 0.518, 0.518",
    spark: "0.36, 0.78, 0.75",
    tone: "0.1 + 0.9 * (1.0 - smoothstep(0.2, 0.99, lum))",
    stroke: "#019ca2",
    sheen: "#7be6e0",
    sheenOpacity: 0.32,
  },
  dark: {
    ground: "#0d1117",
    inkGraphite: "0.91, 0.89, 0.85",
    inkTeal: "0.235, 0.769, 0.749",
    spark: "0.62, 0.93, 0.90",
    tone: "0.06 + 0.94 * smoothstep(0.12, 0.96, lum)",
    stroke: "#2bbdb7",
    sheen: "#b8f5f1",
    sheenOpacity: 0.28,
  },
}[THEME];

const hex = (value: string, a = 1): Color => {
  const n = Number.parseInt(value.replace("#", ""), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a };
};

const snap = (tick: number) => Math.round(tick / TPF) * TPF;
const sec = (seconds: number) => snap(seconds * TPS);
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smoothstep = (t: number) => {
  const u = clamp01(t);
  return u * u * (3 - 2 * u);
};

const DURATION = sec(8);

type Ease = CubicBezier | "linear" | "hold";

function steps<T>(id: string, keys: readonly (readonly [number, T, Ease])[]): Animatable<T> {
  return {
    kind: "keyframed",
    keyframes: keys.map(([tick, value, ease], index) => {
      const keyId = `${id}-${index}`;
      if (index === keys.length - 1 || ease === "hold") return { id: keyId, tick, value, interpolation: "hold" as const };
      if (ease === "linear") return { id: keyId, tick, value, interpolation: "linear" as const };
      return { id: keyId, tick, value, interpolation: "bezier" as const, easing: ease };
    }),
  };
}

function track<T>(id: string, value: (tick: number) => T): Animatable<T> {
  const key = (v: T) => JSON.stringify(v, (_k, x: unknown) => (typeof x === "number" ? Math.round(x * 100) / 100 : x));
  const ticks: number[] = [];
  for (let tick = 0; tick <= DURATION; tick += TPF) ticks.push(tick);
  const values = ticks.map(value);
  const sig = values.map(key);
  const keys: (readonly [number, T, Ease])[] = [];
  for (let i = 0; i < ticks.length; i++) {
    const redundant = i > 0 && i < ticks.length - 1 && sig[i] === sig[i - 1] && sig[i] === sig[i + 1];
    if (!redundant) keys.push([ticks[i]!, values[i]!, "linear"]);
  }
  return keys.length === 1 ? constant(values[0]!) : steps(id, keys);
}

interface Place {
  x?: number;
  y?: number;
  ax?: number;
  ay?: number;
  sx?: number;
  sy?: number;
  rot?: number;
}

const transform = ({ x = 0, y = 0, ax = 0, ay = 0, sx = 1, sy = 1, rot = 0 }: Place = {}): Transform25D => ({
  position: constant<Vec3>({ x, y, z: 0 }),
  anchor: constant<Vec3>({ x: ax, y: ay, z: 0 }),
  scale: constant<Vec3>({ x: sx, y: sy, z: 1 }),
  rotation: constant<Vec3>({ x: 0, y: 0, z: rot }),
  skew: constant<Vec2>({ x: 0, y: 0 }),
});

const v3 = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });
const rotZ = (deg: number): Vec3 => ({ x: 0, y: 0, z: deg });

const base = (id: string, place: Place = {}) => ({
  id,
  name: id,
  visible: true,
  inTick: 0,
  outTick: DURATION,
  opacity: constant(1),
  transform: transform(place),
  blendMode: "normal" as const,
});

const solid = (color: string, a = 1): ShapeStyle => ({
  fill: { color: constant(hex(color, a)), opacity: constant(1) },
});

type Stop = readonly [position: number, color: Color];
const linear = (start: Vec2, end: Vec2, stops: readonly Stop[]): ShapeStyle => ({
  gradientFill: {
    kind: "linear",
    stops: constant(stops.map(([position, color]) => ({ position, color }))),
    start: constant(start),
    end: constant(end),
    opacity: constant(1),
  },
});

const stroke = (color: string, width: number) => ({
  color: constant(hex(color)),
  opacity: constant(1),
  width: constant(width),
  lineCap: "round" as const,
  lineJoin: "round" as const,
  miterLimit: 4,
});

const withStroke = (style: ShapeStyle, color: string, width: number): ShapeStyle => ({ ...style, stroke: stroke(color, width) });

const rect = (id: string, x: number, y: number, w: number, h: number, style: ShapeStyle, corner = 0): SceneNode => ({
  ...base(id, { x, y }),
  type: "rect",
  size: constant({ width: w, height: h }),
  cornerRadius: constant(corner),
  style,
});

const ellipse = (id: string, x: number, y: number, w: number, h: number, style: ShapeStyle): SceneNode => ({
  ...base(id, { x, y }),
  type: "ellipse",
  size: constant({ width: w, height: h }),
  style,
});

const group = (id: string, children: string[], extra: Partial<GroupNode> = {}, place: Place = {}): GroupNode => ({
  ...base(id, place),
  type: "group",
  children,
  ...extra,
});

const path = (id: string, contours: PathContour[], style: ShapeStyle): SceneNode => ({
  ...base(id),
  type: "path",
  path: constant({ contours }),
  style,
});

function smooth(points: readonly Vec2[], closed: boolean): PathContour {
  const n = points.length;
  const at = (i: number) => (closed ? points[(i + n) % n]! : points[Math.min(n - 1, Math.max(0, i))]!);
  const vertices: PathVertex[] = points.map((point, i) => {
    const tx = (at(i + 1).x - at(i - 1).x) / 6;
    const ty = (at(i + 1).y - at(i - 1).y) / 6;
    return { point, inTangent: { x: -tx, y: -ty }, outTangent: { x: tx, y: ty } };
  });
  return { closed, vertices };
}

const corners = (points: readonly Vec2[]): PathContour => ({
  closed: true,
  vertices: points.map((point) => ({ point, inTangent: { x: 0, y: 0 }, outTangent: { x: 0, y: 0 } })),
});

const nodes: Record<string, SceneNode> = {};
const add = (...list: SceneNode[]) => {
  for (const node of list) {
    if (nodes[node.id]) throw new Error(`duplicate node ${node.id}`);
    nodes[node.id] = node;
  }
  return list.map((node) => node.id);
};

// ---------------------------------------------------------------------------
// Beats, in seconds.

const T_PRINT_IN = 0.1;
const T_PRINTED = 0.95;
const T_WINDUP = 1.0;
const T_RAISE = 1.18;
const T_WAVE = 1.5;
const PERIOD = 0.6;
const WAVES = 3;
const T_WAVE_END = T_WAVE + PERIOD * WAVES;
const T_LOWER = T_WAVE_END + 0.02;
const T_WRITE = 1.55;
const T_WRITTEN = 3.45;
const T_OUT = 6.75;
const T_GONE = 7.6;
const BLINKS = [0.62, 4.6, 4.77];

// ---------------------------------------------------------------------------
// The rig. Joint angles in degrees, clockwise on screen. The waving arm is on
// the viewer's right, toward the name.

const REST = -10;
const RAISED = -164;
const WINDUP = 10;

function targets(s: number) {
  const raised = s >= T_RAISE && s < T_LOWER;
  const windup = s >= T_WINDUP && s < T_RAISE;
  const env = smoothstep((s - T_WAVE) / 0.18) * (1 - smoothstep((s - (T_WAVE_END - 0.22)) / 0.22));
  const phase = (TAU * (s - T_WAVE)) / PERIOD;
  const swing = (Math.tanh(1.8 * Math.sin(phase)) / Math.tanh(1.8)) * env;
  const shoulder = windup ? REST + WINDUP : raised ? RAISED + 9 * swing : REST;
  const wrist = raised ? 30 * swing : 0;
  const tilt = raised ? -6.5 : 0;
  const lean = windup ? -1.4 : raised ? 1.6 : 0;
  const otherArm = windup ? 3 : raised ? -4 : 0;
  const smile = raised ? 1 : 0;
  return { shoulder, wrist, tilt, lean, otherArm, smile };
}

interface Spring {
  x: number;
  v: number;
}
const spring = (x: number): Spring => ({ x, v: 0 });
function stepSpring(sp: Spring, target: number, hz: number, zeta: number, dt: number, force = 0) {
  const w = TAU * hz;
  const a = w * w * (target - sp.x) - 2 * zeta * w * sp.v + force;
  sp.v += a * dt;
  sp.x += sp.v * dt;
  return a;
}

interface Pose {
  shoulder: number;
  wrist: number;
  tilt: number;
  lean: number;
  otherArm: number;
  smile: number;
}

function simulate(): Pose[] {
  const dt = 1 / TPS;
  const sh = spring(REST);
  const wr = spring(0);
  const tl = spring(0);
  const ln = spring(0);
  const oa = spring(0);
  const sm = spring(0);
  const poses: Pose[] = [];
  for (let tick = 0; tick <= DURATION; tick++) {
    poses.push({ shoulder: sh.x, wrist: wr.x, tilt: tl.x, lean: ln.x, otherArm: oa.x, smile: sm.x });
    const t = targets(tick / TPS);
    const armAccel = stepSpring(sh, t.shoulder, 2.1, 0.62, dt);
    stepSpring(wr, t.wrist, 3.2, 0.5, dt, -0.32 * armAccel);
    stepSpring(tl, t.tilt - 0.035 * (sh.x - RAISED) * (t.tilt !== 0 ? 1 : 0), 1.5, 0.7, dt);
    stepSpring(ln, t.lean, 1.3, 0.75, dt);
    stepSpring(oa, t.otherArm, 1.6, 0.55, dt);
    stepSpring(sm, t.smile, 2.2, 0.8, dt);
  }
  return poses;
}

const poses = simulate();
const poseAt = (tick: number) => poses[Math.min(poses.length - 1, Math.max(0, Math.round(tick)))]!;
const sway = (tick: number) => 0.9 * Math.sin((TAU * tick) / DURATION);

function blinkAt(s: number) {
  let open = 1;
  for (const b of BLINKS) {
    const u = (s - b) / 0.13;
    if (u > 0 && u < 1) open = Math.min(open, 1 - 0.92 * Math.sin(Math.PI * u) ** 0.8);
  }
  return open;
}

// ---------------------------------------------------------------------------
// The figure, in its own space with the middle of its soles at the origin.

const FIG_SCALE = 0.8;
const CX = 269;
const FEET = 462;

const LINE = 3;
const PORCELAIN = { hi: "#faf8f3", face: "#efebe3", low: "#d6cfc2", line: "#5d574d" };
const TEAL = { hi: "#56bdb6", face: "#34aaa4", low: "#1f938f", line: "#0d6664" };
const SLEEVE = { hi: "#b4e8e2", face: "#86d4cd", low: "#5cc0b9", line: "#0d6664" };
const GRAPHITE = { hi: "#c9c2b6", face: "#bab3a6", low: "#a69e91", foot: "#8f877a", line: "#2f2b25" };
const FACE_INK = "#2d2922";

function outlinedRect(id: string, cx: number, cy: number, w: number, h: number, fill: ShapeStyle, line: string, corner = 4) {
  return add(rect(`${id}-line`, cx, cy, w, h, solid(line), corner), rect(id, cx, cy, w - LINE * 2, h - LINE * 2, fill, Math.max(1, corner - LINE)));
}

const shadeX = (w: number, low: string, face: string, hi: string): ShapeStyle =>
  linear({ x: -w / 2, y: 0 }, { x: w / 2, y: 0 }, [
    [0, hex(low)],
    [0.42, hex(face)],
    [0.78, hex(hi)],
    [1, hex(face)],
  ]);

const LEG_W = 90;
const LEG_GAP = 12;
const LEG_H = 150;
const HIP_H = 40;
const HIP_W = LEG_W * 2 + LEG_GAP + 4;
const HIP_TOP = -LEG_H - HIP_H;
const FOOT_H = 30;
const leg = (id: string, cx: number, top: string, foot: string) => [
  ...outlinedRect(id, cx, -LEG_H / 2, LEG_W, LEG_H, solid(top), GRAPHITE.line, 6),
  ...outlinedRect(`${id}-foot`, cx, -FOOT_H / 2, LEG_W, FOOT_H, solid(foot), GRAPHITE.line, 5),
];
const legIds = [
  ...leg("leg-l", -(LEG_W + LEG_GAP) / 2, GRAPHITE.low, GRAPHITE.foot),
  ...leg("leg-r", (LEG_W + LEG_GAP) / 2, GRAPHITE.face, GRAPHITE.low),
  ...outlinedRect("hips", 0, -LEG_H - HIP_H / 2 + 2, HIP_W, HIP_H, shadeX(HIP_W, GRAPHITE.foot, GRAPHITE.low, GRAPHITE.face), GRAPHITE.line, 6),
];

const TORSO_H = 158;
const TORSO_TOP = HIP_TOP - TORSO_H;
const SHOULDER_HW = 68;
const WAIST_HW = HIP_W / 2 - 2;
const torsoIds = add(
  path(
    "torso",
    [
      corners([
        { x: -SHOULDER_HW, y: TORSO_TOP },
        { x: SHOULDER_HW, y: TORSO_TOP },
        { x: WAIST_HW, y: HIP_TOP + 2 },
        { x: -WAIST_HW, y: HIP_TOP + 2 },
      ]),
    ],
    withStroke(shadeX(WAIST_HW * 2, TEAL.low, TEAL.face, TEAL.hi), TEAL.line, LINE * 2),
  ),
);

const NECK_Y = TORSO_TOP;
const HEAD_W = 122;
const HEAD_H = 104;
const HEAD_CY = NECK_Y - 12 - HEAD_H / 2;
const STUD_W = 64;
const STUD_H = 18;
const STUD_Y = HEAD_CY - HEAD_H / 2 + 2;

add(rect("neck-line", 0, NECK_Y - 6, 70, 20, solid(PORCELAIN.line), 4), rect("neck", 0, NECK_Y - 6, 64, 14, solid(PORCELAIN.low), 2));

const headShapes = [
  ...add(
    rect("stud-wall", 0, STUD_Y - STUD_H / 2, STUD_W, STUD_H, shadeX(STUD_W, PORCELAIN.low, PORCELAIN.face, PORCELAIN.hi), 0),
    rect("stud-wall-l", -STUD_W / 2, STUD_Y - STUD_H / 2, LINE, STUD_H, solid(PORCELAIN.line), 0),
    rect("stud-wall-r", STUD_W / 2, STUD_Y - STUD_H / 2, LINE, STUD_H, solid(PORCELAIN.line), 0),
  ),
  ...outlinedRect("head", 0, HEAD_CY, HEAD_W, HEAD_H, shadeX(HEAD_W, PORCELAIN.low, PORCELAIN.face, PORCELAIN.hi), PORCELAIN.line, 30),
  ...add(ellipse("stud-cap", 0, STUD_Y - STUD_H, STUD_W, STUD_W * 0.34, withStroke(solid(PORCELAIN.hi), PORCELAIN.line, 3))),
];

const EYE_Y = HEAD_CY - 8;
add(ellipse("eye-l", -24, 0, 16, 22, solid(FACE_INK)), ellipse("eye-r", 24, 0, 16, 22, solid(FACE_INK)));
const eyes = group("eyes", ["eye-l", "eye-r"], {}, { x: 0, y: EYE_Y });
eyes.transform.scale = track("eyes-blink", (t) => v3(1, blinkAt(t / TPS), 1));
add(eyes);

const SMILE_Y = HEAD_CY + 16;
add(path("smile-line", [smooth([{ x: -27, y: 0 }, { x: -14, y: 11 }, { x: 0, y: 14 }, { x: 14, y: 11 }, { x: 27, y: 0 }], false)], { stroke: stroke(FACE_INK, 7) }));
const smile = group("smile", ["smile-line"], {}, { x: 0, y: SMILE_Y });
smile.transform.scale = track("smile-grin", (t) => {
  const g = poseAt(t).smile;
  return v3(1 + 0.12 * g, 1 + 0.22 * g, 1);
});
add(smile);

add(group("face", ["eyes", "smile"]));
const headLook = group("head-look", [...headShapes, "face"], {}, { x: 0, y: NECK_Y, ax: 0, ay: NECK_Y });
add(headLook);
const head = group("head-tilt", ["head-look"], {}, { x: 0, y: NECK_Y, ax: 0, ay: NECK_Y });
head.transform.rotation = track("head-tilt-rot", (t) => rotZ(poseAt(t).tilt - 0.6 * sway(t)));
add(head);

const ARM_L = 118;
function armShapes(id: string, mirror: 1 | -1) {
  const m = (p: Vec2): Vec2 => ({ x: p.x * mirror, y: p.y });
  const outline = [
    { x: -24, y: 2 },
    { x: -21, y: 44 },
    { x: -17, y: 88 },
    { x: -16, y: ARM_L - 4 },
    { x: 0, y: ARM_L + 4 },
    { x: 16, y: ARM_L - 4 },
    { x: 19, y: 88 },
    { x: 24, y: 44 },
    { x: 25, y: 2 },
    { x: 14, y: -20 },
    { x: -13, y: -20 },
  ].map(m);
  return add(path(`${id}-sleeve`, [smooth(outline, true)], withStroke(shadeX(50, SLEEVE.low, SLEEVE.face, SLEEVE.hi), SLEEVE.line, LINE * 2.6)));
}

function handShapes(id: string) {
  const R = 21;
  const cy = 32;
  const gap = 36;
  const arc: Vec2[] = [];
  for (let a = 90 + gap; a <= 450 - gap; a += 18) {
    const r = (a * Math.PI) / 180;
    arc.push({ x: R * Math.cos(r), y: cy + R * Math.sin(r) });
  }
  return add(
    rect(`${id}-peg-line`, 0, 6, 26, 20, solid(PORCELAIN.line), 4),
    rect(`${id}-peg`, 0, 6, 20, 14, solid(PORCELAIN.low), 2),
    path(`${id}-ring-line`, [smooth(arc, false)], { stroke: stroke(PORCELAIN.line, 24) }),
    path(`${id}-ring`, [smooth(arc, false)], { stroke: stroke(PORCELAIN.hi, 16) }),
  );
}

const reach = (shoulder: number) => 1 - 0.2 * Math.sin((shoulder * Math.PI) / 180) ** 2;

const SHOULDER_X = SHOULDER_HW - 4;
const SHOULDER_Y = TORSO_TOP + 22;

const handL = group("hand-l", handShapes("hand-l"), {}, { x: 0, y: ARM_L });
add(handL);
const armL = group("arm-l", [...armShapes("arm-l", -1), "hand-l"], {}, { x: -SHOULDER_X, y: SHOULDER_Y, rot: -REST });
armL.transform.rotation = track("arm-l-rot", (t) => rotZ(-REST + poseAt(t).otherArm + 0.5 * sway(t)));
add(armL);

const handR = group("hand-r", handShapes("hand-r"), {}, { x: 0, y: ARM_L });
handR.transform.rotation = track("hand-r-rot", (t) => rotZ(poseAt(t).wrist));
add(handR);
const armR = group("arm-r", [...armShapes("arm-r", 1), "hand-r"], {}, { x: SHOULDER_X, y: SHOULDER_Y });
armR.transform.rotation = track("arm-r-rot", (t) => rotZ(poseAt(t).shoulder));
armR.transform.scale = track("arm-r-reach", (t) => v3(1, reach(poseAt(t).shoulder), 1));
add(armR);

const upper = group("upper", [...torsoIds, "neck-line", "neck", "head-tilt", "arm-l", "arm-r"], {}, { x: 0, y: HIP_TOP, ax: 0, ay: HIP_TOP });
upper.transform.rotation = track("upper-lean", (t) => rotZ(poseAt(t).lean + sway(t)));
add(upper);

add(group("minifig", [...legIds, "upper"], {}, { x: CX, y: FEET, sx: FIG_SCALE, sy: FIG_SCALE }));

// ---------------------------------------------------------------------------
// The print. Each cell's colour picks an ink and its lightness sets the dot's
// area; the in and out fronts build and eat the figure from its middle.

const HALFTONE_SKSL = /* glsl */ `
uniform shader inputImage;
uniform float pitch;
uniform float dotScale;
uniform float2 inFront;
uniform float inProgress;
uniform float inReach;
uniform float2 outFront;
uniform float outProgress;
uniform float outReach;
uniform float2 renderScale;

float hash(float2 c) {
  return fract(sin(dot(c, float2(12.9898, 78.233))) * 43758.5453);
}

float front(float progress, float reach, float dist, float jitter) {
  return clamp((progress * reach - dist - jitter * 120.0) / 100.0, 0.0, 1.0);
}

half4 main(float2 p) {
  float s = max(renderScale.x, 0.0001);
  float cell = max(2.0, pitch * s);
  float2 id = floor(p / cell);
  float2 c = (id + 0.5) * cell;

  float q = cell * 0.25;
  half4 sum = inputImage.eval(c + float2(-q, -q)) + inputImage.eval(c + float2(q, -q))
            + inputImage.eval(c + float2(-q, q)) + inputImage.eval(c + float2(q, q));
  float cover = float(sum.a) * 0.25;
  if (cover < 0.03) { return half4(0.0); }
  float3 col = float3(sum.rgb) / max(float(sum.a), 0.0001);

  float h = hash(id);
  float qIn = front(inProgress, inReach, length(c - inFront) / s, h);
  float qOut = front(outProgress, outReach, length(c - outFront) / s, h);
  float alive = qIn * (1.0 - qOut);
  if (alive <= 0.0) { return half4(0.0); }

  float3 ink = float3(${PALETTE.inkGraphite});
  if (col.b - col.r > 0.05) { ink = float3(${PALETTE.inkTeal}); }

  float lum = dot(col, float3(0.299, 0.587, 0.114));
  float tone = ${PALETTE.tone};

  float spark = 0.7 * sin(3.14159 * qIn) + 0.6 * sin(3.14159 * qOut);
  float radius = cell * 0.5 * dotScale * sqrt(tone * cover) * alive * (1.0 + 0.45 * spark);
  radius = min(radius, cell * 0.54);
  ink = mix(ink, float3(${PALETTE.spark}), clamp(0.8 * spark, 0.0, 0.9));

  float dotAlpha = clamp(radius - length(p - c) + 0.5, 0.0, 1.0);
  return half4(half3(ink * dotAlpha), half(dotAlpha));
}
`;

const pointParam = (id: string, name: string, value: Animatable<Vec2>): EffectParameter => ({
  id,
  name,
  valueType: "point",
  value,
  minimum: { x: -6000, y: -6000 },
  maximum: { x: 6000, y: 6000 },
});
const numberParam = (id: string, name: string, value: Animatable<number> | number, maximum = 8000): EffectParameter => ({
  id,
  name,
  valueType: "number",
  value: typeof value === "number" ? constant(value) : value,
  minimum: 0,
  maximum,
});

const FIG_MIDDLE: Vec2 = { x: CX + 10, y: FEET - 210 };
add({
  ...base("print-minifig"),
  type: "effect",
  inputId: "minifig",
  effect: "custom-sksl",
  implementation: HALFTONE_SKSL,
  parameters: [
    numberParam("print-pitch", "pitch", 7, 64),
    numberParam("print-scale", "dotScale", 1.04, 2),
    pointParam("print-in-front", "inFront", constant(FIG_MIDDLE)),
    numberParam("print-in-progress", "inProgress", steps("print-in", [[0, 0, "hold"], [sec(T_PRINT_IN), 0, OUT], [sec(T_PRINTED), 1, "hold"]]), 1),
    numberParam("print-in-reach", "inReach", 620),
    pointParam("print-out-front", "outFront", constant({ x: FIG_MIDDLE.x, y: FIG_MIDDLE.y - 60 })),
    numberParam("print-out-progress", "outProgress", steps("print-out", [[0, 0, "hold"], [sec(T_OUT), 0, IN_OUT], [sec(T_GONE), 1, "hold"]]), 1),
    numberParam("print-out-reach", "outReach", 640),
  ],
  capability: { requires: ["runtime-effect"], fallback: "passthrough", maxTemporarySurfaces: 1 },
} satisfies EffectNode);

// ---------------------------------------------------------------------------
// The name: one continuous cursive spine, p-u-r-a-v, joined like the loader's
// "clayzo". Flattened to a dense polyline so the trim follows the curves, then
// breathed by the same liquid offset.

const CURSIVE_PURAV = [
  "M 52 128",
  "C 62 118 74 104 84 88",
  "C 82 118 80 150 75 182",
  "C 78 150 82 120 88 102",
  "C 96 86 118 84 121 101",
  "C 124 118 108 133 91 128",
  "C 106 131 119 124 129 110",
  "C 131 103 132 96 135 90",
  "C 132 110 129 128 143 130",
  "C 157 132 163 110 167 90",
  "C 165 106 162 124 171 130",
  "C 180 134 188 121 194 108",
  "C 197 100 199 94 203 90",
  "C 208 93 213 96 219 92",
  "C 215 104 211 118 213 130",
  "C 222 116 240 99 262 97",
  "C 250 87 229 93 226 112",
  "C 224 128 240 136 252 126",
  "C 258 120 262 108 265 94",
  "C 263 108 260 124 268 130",
  "C 277 134 286 121 292 107",
  "C 294 100 295 95 298 90",
  "C 303 104 306 120 312 130",
  "C 319 117 326 100 334 90",
  "C 339 84 344 91 337 97",
  "C 333 101 344 101 354 94",
].join(" ");

function cubicPoint(a: Vec2, b: Vec2, c: Vec2, d: Vec2, t: number): Vec2 {
  const u = 1 - t;
  return {
    x: u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
    y: u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y,
  };
}

function flatten(data: PathData, subdivisions = 12): PathData {
  return {
    fillRule: "nonzero",
    contours: data.contours.map((contour) => {
      const first = contour.vertices[0]!;
      const vertices: PathVertex[] = [{ point: { ...first.point }, inTangent: { x: 0, y: 0 }, outTangent: { x: 0, y: 0 } }];
      for (let i = 1; i < contour.vertices.length; i++) {
        const prev = contour.vertices[i - 1]!;
        const cur = contour.vertices[i]!;
        const ca = { x: prev.point.x + prev.outTangent.x, y: prev.point.y + prev.outTangent.y };
        const cb = { x: cur.point.x + cur.inTangent.x, y: cur.point.y + cur.inTangent.y };
        for (let s = 1; s <= subdivisions; s++) {
          vertices.push({ point: cubicPoint(prev.point, ca, cb, cur.point, s / subdivisions), inTangent: { x: 0, y: 0 }, outTangent: { x: 0, y: 0 } });
        }
      }
      return { closed: contour.closed, vertices };
    }),
  };
}

/** Fits the spine's x-extent to `width`, keeping its proportions, with the baseline at `baseline`. */
function place(data: PathData, left: number, width: number, baseline: number, spineBaseline = 130): PathData {
  const xs = data.contours.flatMap((c) => c.vertices.map((v) => v.point.x));
  const minX = Math.min(...xs);
  const k = width / (Math.max(...xs) - minX);
  return {
    fillRule: "nonzero",
    contours: data.contours.map((c) => ({
      closed: c.closed,
      vertices: c.vertices.map((v) => ({
        point: { x: left + (v.point.x - minX) * k, y: baseline + (v.point.y - spineBaseline) * k },
        inTangent: { x: 0, y: 0 },
        outTangent: { x: 0, y: 0 },
      })),
    })),
  };
}

function liquid(data: PathData, phase: number, amount: number): PathData {
  return {
    fillRule: "nonzero",
    contours: data.contours.map((contour) => {
      const d = [0];
      for (let i = 1; i < contour.vertices.length; i++) {
        const a = contour.vertices[i - 1]!.point;
        const b = contour.vertices[i]!.point;
        d.push(d[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
      }
      const total = Math.max(1, d[d.length - 1]!);
      return {
        closed: contour.closed,
        vertices: contour.vertices.map((vertex, i) => {
          const prev = contour.vertices[Math.max(0, i - 1)]!.point;
          const next = contour.vertices[Math.min(contour.vertices.length - 1, i + 1)]!.point;
          const len = Math.max(0.0001, Math.hypot(next.x - prev.x, next.y - prev.y));
          const t = { x: (next.x - prev.x) / len, y: (next.y - prev.y) / len };
          const n = { x: -t.y, y: t.x };
          const arc = d[i]! / total;
          const env = Math.pow(Math.max(0, Math.sin(Math.PI * arc)), 0.85);
          const off = amount * env * (3.4 * Math.sin(TAU * (arc - phase)) + 1.25 * Math.sin(TAU * (2.15 * arc - 1.6 * phase)));
          const along = amount * env * 0.65 * Math.sin(TAU * (0.6 * arc + phase));
          return {
            point: { x: vertex.point.x + n.x * off + t.x * along, y: vertex.point.y + n.y * off + t.y * along },
            inTangent: { x: 0, y: 0 },
            outTangent: { x: 0, y: 0 },
          };
        }),
      };
    }),
  };
}

const parsed = parseSvgPath(CURSIVE_PURAV);
if (parsed.diagnostics.length > 0) throw new Error(parsed.diagnostics.map((d) => d.message).join("; "));
const NAME_LEFT = 499;
const NAME_WIDTH = 610;
const NAME_BASELINE = 292;
const spine = place(flatten(parsed.path), NAME_LEFT, NAME_WIDTH, NAME_BASELINE);
const nameScale = NAME_WIDTH / 302;

const flowTicks: number[] = [];
for (let tick = 0; tick <= DURATION; tick += sec(0.5)) flowTicks.push(tick);
if (flowTicks[flowTicks.length - 1] !== DURATION) flowTicks.push(DURATION);
const flow: PathNode["path"] = {
  kind: "keyframed",
  keyframes: flowTicks.map((tick, i) => ({
    id: `name-flow-${i}`,
    tick,
    value: liquid(spine, tick / DURATION, nameScale * 0.55),
    interpolation: i === flowTicks.length - 1 ? ("hold" as const) : ("linear" as const),
  })),
};

const trim = (id: string): NonNullable<PathNode["operators"]>[number] => ({
  id,
  type: "trim",
  start: steps(`${id}-start`, [[0, 0, "hold"], [sec(T_OUT), 0, IN_OUT], [sec(T_GONE), 1, "hold"]]),
  end: steps(`${id}-end`, [[0, 0, "hold"], [sec(T_WRITE), 0, DRAW], [sec(T_WRITTEN), 1, "hold"]]),
  offset: constant(0),
});

const nameStroke = (id: string, color: string, width: number, opacity: number): PathNode => ({
  ...base(id),
  type: "path",
  path: flow,
  style: { stroke: { ...stroke(color, width), opacity: constant(opacity) } },
  operators: [trim(`${id}-trim`)],
});

add(nameStroke("name-ink", PALETTE.stroke, 6.2 * nameScale, 1), nameStroke("name-sheen", PALETTE.sheen, 1.5 * nameScale, PALETTE.sheenOpacity));
add(group("name", ["name-ink", "name-sheen"], { isolation: true }));

add(rect("ground", W / 2, H / 2, W, H, solid(PALETTE.ground)));

// ---------------------------------------------------------------------------
// Framing report, measured through the same rig the document plays.

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const at = (x: number, y: number, deg = 0, ax = 0, ay = 0): M => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [c, s, -s, c, x - (c * ax - s * ay), y - (s * ax + c * ay)];
};
const apply = (m: M, p: Vec2): Vec2 => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] });

const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
for (let tick = 0; tick <= DURATION; tick += TPF) {
  const p = poseAt(tick);
  const fig = mul(at(CX, FEET), [FIG_SCALE, 0, 0, FIG_SCALE, 0, 0]);
  const up = mul(fig, at(0, HIP_TOP, p.lean + sway(tick), 0, HIP_TOP));
  const hd = mul(up, at(0, NECK_Y, p.tilt - 0.6 * sway(tick), 0, NECK_Y));
  const armR2 = mul(mul(up, at(SHOULDER_X, SHOULDER_Y, p.shoulder)), [1, 0, 0, reach(p.shoulder), 0, 0]);
  const hand = mul(armR2, at(0, ARM_L, p.wrist));
  const pts: Vec2[] = [];
  for (let a = 0; a < 360; a += 15) pts.push(apply(hand, { x: 33 * Math.cos((a * Math.PI) / 180), y: 32 + 33 * Math.sin((a * Math.PI) / 180) }));
  pts.push(apply(hd, { x: 0, y: STUD_Y - STUD_H - STUD_W * 0.17 - 2 }), apply(hd, { x: -HEAD_W / 2, y: HEAD_CY - HEAD_H / 2 }), apply(fig, { x: -HIP_W / 2, y: 0 }), apply(fig, { x: HIP_W / 2, y: 0 }));
  for (const q of pts) {
    bounds.minX = Math.min(bounds.minX, q.x);
    bounds.maxX = Math.max(bounds.maxX, q.x);
    bounds.minY = Math.min(bounds.minY, q.y);
    bounds.maxY = Math.max(bounds.maxY, q.y);
  }
}
const nameYs = spine.contours.flatMap((c) => c.vertices.map((v) => v.point.y));
const nameXs = spine.contours.flatMap((c) => c.vertices.map((v) => v.point.x));

const POSTER = sec(T_WAVE + PERIOD * 1.25 + 0.9);
const scene: AnimationDocument = {
  version: ANIMATION_DOCUMENT_VERSION,
  id: `purav-profile-banner-${THEME}`,
  revision: "",
  name: `Purav's GitHub banner (${THEME})`,
  canvas: { width: W, height: H, pixelAspectRatio: 1, backgroundColor: hex(PALETTE.ground) },
  timing: { ticksPerSecond: TPS, frameRate: { numerator: FPS, denominator: 1 }, durationTicks: DURATION, displayStartTick: 0 },
  assets: {},
  compositions: {
    main: { id: "main", name: "Main", width: W, height: H, durationTicks: DURATION, nodes, rootNodeIds: ["ground", "print-minifig", "name"] },
  },
  rootCompositionId: "main",
  components: {},
  markers: [
    { id: "m-print", name: "print in", tick: sec(T_PRINT_IN), durationTicks: sec(T_PRINTED - T_PRINT_IN) },
    { id: "m-wave", name: "wave", tick: sec(T_WAVE), durationTicks: sec(T_WAVE_END - T_WAVE) },
    { id: "m-write", name: "write", tick: sec(T_WRITE), durationTicks: sec(T_WRITTEN - T_WRITE) },
    { id: "m-poster", name: "poster", tick: POSTER, durationTicks: 0 },
    { id: "m-out", name: "print out", tick: sec(T_OUT), durationTicks: sec(T_GONE - T_OUT) },
  ],
  capabilities: { required: [], optional: [], unsupportedPolicy: "warn" },
};

const rounded = JSON.parse(
  JSON.stringify(scene, (_key, value: unknown) => (typeof value === "number" ? Math.round(value * 1000) / 1000 : value)),
) as AnimationDocument;
const document = withComputedRevision(rounded);
assertValidAnimationDocument(document);

const outFile = join(dirname(fileURLToPath(import.meta.url)), `banner-${THEME}.json`);
writeFileSync(outFile, JSON.stringify(document));
const r = Math.round;
console.log(
  JSON.stringify({
    out: outFile,
    revision: document.revision,
    nodes: Object.keys(nodes).length,
    poster: POSTER,
    figure: { minX: r(bounds.minX), maxX: r(bounds.maxX), minY: r(bounds.minY), maxY: r(bounds.maxY) },
    name: { minX: r(Math.min(...nameXs)), maxX: r(Math.max(...nameXs)), minY: r(Math.min(...nameYs)), maxY: r(Math.max(...nameYs)) },
  }),
);

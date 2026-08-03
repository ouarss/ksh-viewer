/**
 * 3D chart rendering: SDVX-style scrolling highway.
 *
 * All note geometry is built once (Z positions proportional to scroll
 * position × approach speed); scrolling then only translates groups.
 *
 * Camera effects replicate the reference implementation's model:
 * the camera stays fixed and the whole "highway" group carries the
 * transformations, recomputed every frame from the chart's camera curves:
 *   M = T(zoom) · Ry(shake) · Rz(roll) · T(offsetX) · Rx(pitch)
 * The track and notes are split into left/right halves so center_split can
 * push them apart. Lasers are not split (they span the full width).
 */

import * as THREE from '../../lib/three.module.js';
import {
    curveValueAt, scrollPosAt, tiltStateAt, laserPosAt, lastIndexAt,
} from './ksh-parser.js';

const TRACK_W = 2.4;        // track width (4 BT lanes)
const LANE_W = TRACK_W / 4;
const TRACK_LEN = 300;      // visible track length
const LASER_W = 0.28;
const LASER_TAIL_LEN = 0.55; // laser section entry/exit tails
export const DEFAULT_SPEED = 700;

// Camera effect constants, matching the reference implementation
const MAX_ROLL_TURNS = 10 / 360;        // 1 tilt unit = 10° of screen roll
const PITCH_UNIT_DEG = 15;              // zoom_top → degrees factor
const ZOOM_POW = 1.65;
const ZOOM_SCALE = 2.0;                 // game units → world units (push-away branch)
const SIDE_OFFSET = 0.3592 * TRACK_W;   // zoom_side=1 → X offset
const SPLIT_UNIT = TRACK_W / 6 * 0.5;   // center_split=1 → per-half X offset
const ROLL_SPEED = 4;                   // roll pursuit rate (game rollSpeed)
const SLAM_ROLL_DURATION = 0.1;         // slam tail drives the roll input (s)
const ROLL_IGNORE_DURATION = 0.1;       // then the laser input reads 0 (s)
const SHAKE_DECAY = 0.2 * 60;           // shake decay, degrees/s (0.2°/frame at 60 fps)

const COLORS = {
    background: 0x06070d,
    track: 0x11131f,
    trackEdge: 0x5560ff,
    laneLine: 0x2a2e45,
    judgeLine: 0xff3355,
    measureLine: 0x8890b0,
    btChip: 0xffffff,
    btChipBottom: 0x8fa8ff,
    btHold: 0xfff6b0,
    fxChip: 0xff7a1a,
    fxHold: 0xff9030,
    laserL: 0x00ffff,
    laserR: 0xff0090,
};

const clamp = THREE.MathUtils.clamp;

/** Centered rounded rectangle in the XY plane. */
function roundedRectShape(w, h, r) {
    const s = new THREE.Shape();
    const x = -w / 2, y = -h / 2;
    s.moveTo(x + r, y);
    s.lineTo(x + w - r, y);
    s.quadraticCurveTo(x + w, y, x + w, y + r);
    s.lineTo(x + w, y + h - r);
    s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    s.lineTo(x + r, y + h);
    s.quadraticCurveTo(x, y + h, x, y + h - r);
    s.lineTo(x, y + r);
    s.quadraticCurveTo(x, y, x + r, y);
    return s;
}

/** Box with rounded corners (top view), sitting on y=0, thickness h. */
function roundedChipGeometry(w, d, h) {
    const geo = new THREE.ExtrudeGeometry(
        roundedRectShape(w, d, Math.min(0.045, d / 2)),
        { depth: h, bevelEnabled: false }
    );
    geo.rotateX(-Math.PI / 2);
    return geo;
}

/** Merge flat rounded strips (holds) into a single geometry. */
function mergedRoundedStrips(items, y) {
    const positions = [];
    for (const it of items) {
        const r = Math.min(0.06, it.w / 2, it.len / 2);
        const geo = new THREE.ShapeGeometry(roundedRectShape(it.w, it.len, r)).toNonIndexed();
        geo.rotateX(-Math.PI / 2);
        geo.translate(it.x, y, it.z - it.len / 2);
        positions.push(...geo.getAttribute('position').array);
        geo.dispose();
    }
    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return merged;
}

/** Canvas texture of a letter (L/R marker at laser section starts). */
function makeLetterTexture(letter) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = 128;
    const ctx = cv.getContext('2d');
    ctx.font = 'bold 100px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(letter, 64, 70);
    return new THREE.CanvasTexture(cv);
}

/** Exact port of the game's PitchScaleFunc (Camera.cpp:40-84, landscape). */
function pitchScale(input) {
    const kLower = -4, uLower = -3.05;
    const kUpper = 5.59, uUpper = 4.75;

    let rot = 0;
    const dir = input < 0 ? -1 : 1;
    if (dir === -1) {
        while (input < -12) { input += 24; rot++; }
    } else {
        while (input > 12) { input -= 24; rot++; }
    }

    let scaled;
    if (input < kLower) scaled = -(-(input - kLower) / (12 + kLower)) * (12 + uLower) + uLower;
    else if (input < 0) scaled = (input / kLower) * uLower;
    else if (input < kUpper) scaled = (input / kUpper) * uUpper;
    else scaled = ((input - kUpper) / (12 - kUpper)) * (12 - uUpper) + uUpper;

    return rot * dir * 24 + scaled;
}

const dampedSin = (t, amplitude, frequency, decay) =>
    amplitude * Math.exp(-decay * t) * Math.sin(2 * Math.PI * frequency * t);
const swing = (t) => dampedSin(t, 120 / 360, 1, 3.5);

// Constant-rate approach toward a target without overshooting — the game's
// LerpTo (Camera.cpp:112-119). This is what makes tilt feel like a steady
// sweep rather than an exponential ease-out.
const lerpToward = (value, target, maxStep) =>
    target < value ? Math.max(value - maxStep, target) : Math.min(value + maxStep, target);

/** Laser position → roll contribution (Scoring::GetLaserPosition). */
const laserRoll = (side, pos) =>
    side === 0 ? -clamp(pos, 0, 1) : 1 - clamp(pos, 0, 1);

export class Viewer3D {
    constructor(canvas) {
        this.canvas = canvas;
        this.speed = DEFAULT_SPEED;
        this.chart = null;
        this.effectsEnabled = true;

        this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        this.renderer.setClearColor(0x000000, 0);

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(COLORS.background);
        this.scene.fog = new THREE.Fog(COLORS.background, 14, 34);

        this.camera = new THREE.PerspectiveCamera(58, 1, 0.1, 100);
        this.cameraRig = { pitch: 0, yaw: 0, dist: 0 };
        this.updateCamera();

        // Highway carries all camera-effect transforms; halves carry center_split
        this.highway = new THREE.Group();
        this.highway.matrixAutoUpdate = false;
        this.scene.add(this.highway);

        this.halves = [new THREE.Group(), new THREE.Group()]; // [left, right]
        this.noteGroups = [new THREE.Group(), new THREE.Group()];
        for (let h = 0; h < 2; h++) {
            this.halves[h].add(this.noteGroups[h]);
            this.highway.add(this.halves[h]);
        }
        this.lasersGroup = new THREE.Group();
        this.highway.add(this.lasersGroup);

        this.buildTrack();

        // Playback / effect state
        this.currentTime = 0;
        this._lastT = 0;
        this._critRoll = 0;        // stage 1: crit line roll pursuit (turns)
        this._actualRoll = 0;      // stage 2: applied highway roll (turns)
        this._rollKeepTarget = 0;  // held roll target while tilt keep_* is active
        this._lastIntensity = 1;   // previous roll intensity (stage 2 speed)
        this._wasManual = false;
        this._tiltCatchUp = false; // boosted speed after manual tilt toggles
        this._shake = 0;           // slam shake: camera yaw, in degrees
        this._shakeGuard = 0;      // keeps rapid slams from cancelling the shake
        this._slamTimer = [0, 0];  // per-side roll-ignore window after a slam
        this._slamValue = [0, 0];  // slam tail roll contribution during that window
        this._slamIdx = 0;
        this._letterAssets = null; // shared L/R marker geometry + materials
        this._workMatrix = new THREE.Matrix4();
        this._tmpMatrix = new THREE.Matrix4();
        this._zoomDir = new THREE.Vector3();

        this.resize();
    }

    updateCamera() {
        const { pitch, yaw, dist } = this.cameraRig;
        const base = new THREE.Vector3(0, 1.55, 2.1 + dist);
        const target = new THREE.Vector3(0, 0, -5.5);
        const offset = base.clone().sub(target);
        const spherical = new THREE.Spherical().setFromVector3(offset);
        spherical.phi = clamp(spherical.phi - pitch, 0.35, 1.45);
        spherical.theta += yaw;
        offset.setFromSpherical(spherical);
        this.camera.position.copy(target).add(offset);
        this.camera.lookAt(target);
    }

    orbit(dPitch, dYaw) {
        this.cameraRig.pitch = clamp(this.cameraRig.pitch + dPitch, -0.7, 0.55);
        this.cameraRig.yaw = clamp(this.cameraRig.yaw + dYaw, -1.2, 1.2);
        this.updateCamera();
    }

    zoom(delta) {
        this.cameraRig.dist = clamp(this.cameraRig.dist + delta, -1.2, 6);
        this.updateCamera();
    }

    resetCamera() {
        this.cameraRig = { pitch: 0, yaw: 0, dist: 0 };
        this.updateCamera();
    }

    setEffectsEnabled(enabled) {
        this.effectsEnabled = enabled;
    }

    /** Build the static track visuals, split into left/right halves. */
    buildTrack() {
        const halfW = TRACK_W / 2;

        for (let h = 0; h < 2; h++) {
            const sign = h === 0 ? -1 : 1;
            const g = this.halves[h];
            const cx = sign * halfW / 2;

            const track = new THREE.Mesh(
                new THREE.PlaneGeometry(halfW, TRACK_LEN),
                new THREE.MeshBasicMaterial({ color: COLORS.track })
            );
            track.rotation.x = -Math.PI / 2;
            track.position.set(cx, -0.01, -TRACK_LEN / 2 + 4);
            g.add(track);

            // Lane boundaries owned by this half (shared center line on both)
            const linePositions = [];
            for (let i = 0; i <= 2; i++) {
                const x = sign * i * LANE_W;
                linePositions.push(x, 0, 4, x, 0, -TRACK_LEN + 4);
            }
            const lineGeo = new THREE.BufferGeometry();
            lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(linePositions, 3));
            g.add(new THREE.LineSegments(lineGeo, new THREE.LineBasicMaterial({
                color: COLORS.laneLine, transparent: true, opacity: 0.9,
            })));

            const edge = new THREE.Mesh(
                new THREE.PlaneGeometry(0.06, TRACK_LEN),
                new THREE.MeshBasicMaterial({ color: COLORS.trackEdge, transparent: true, opacity: 0.65 })
            );
            edge.rotation.x = -Math.PI / 2;
            edge.position.set(sign * (halfW + 0.03), 0, -TRACK_LEN / 2 + 4);
            g.add(edge);

            const judge = new THREE.Mesh(
                new THREE.PlaneGeometry(halfW + 0.12, 0.09),
                new THREE.MeshBasicMaterial({ color: COLORS.judgeLine })
            );
            judge.rotation.x = -Math.PI / 2;
            judge.position.set(sign * (halfW + 0.12) / 2, 0.002, 0);
            g.add(judge);

            const glow = new THREE.Mesh(
                new THREE.PlaneGeometry(halfW + 0.12, 0.55),
                new THREE.MeshBasicMaterial({
                    color: COLORS.judgeLine, transparent: true, opacity: 0.18,
                    blending: THREE.AdditiveBlending, depthWrite: false,
                })
            );
            glow.rotation.x = -Math.PI / 2;
            glow.position.set(sign * (halfW + 0.12) / 2, 0.001, 0);
            g.add(glow);
        }
    }

    loadChart(chart) {
        this.chart = chart;

        this._slamIdx = 0;
        this._critRoll = 0;
        this._actualRoll = 0;
        this._rollKeepTarget = 0;
        this._lastIntensity = 1;
        this._wasManual = false;
        this._tiltCatchUp = false;
        this._shake = 0;
        this._shakeGuard = 0;
        this._slamTimer = [0, 0];
        this._slamValue = [0, 0];
        this._lastT = 0;

        this.rebuild();
        this.setTime(0);
    }

    /** Approach speed: the in-game 3-4 digit number (~BPM × hispeed). */
    setSpeed(speed) {
        this.speed = speed;
        if (this.chart) {
            this.rebuild();
            this.setTime(this.currentTime);
        }
    }

    /**
     * World units per second of scroll. Game anchor: "8 beats (2 measures)
     * in view at 1x hi-speed" (Game.cpp) over a track of 10 track-widths
     * (Track.cpp) gives 10 * TRACK_W * speed / 480 = speed / 20 — but the
     * viewer's visible track is shorter than the game's (fog at 14-34 world
     * units ~ 6-8 track-widths, different camera), so the same linear speed
     * reads ~1.5x faster here. speed / 30 (= speed/20 * 2/3) matches the
     * in-game feel, confirmed by side-by-side comparison.
     */
    get unitsPerSecond() {
        return this.speed / 30;
    }

    rebuild() {
        const chart = this.chart;
        const K = this.unitsPerSecond;
        // Z from scroll position (identical to time when the chart has no stops)
        const zOf = (time) => -scrollPosAt(chart, time) * K;
        const laneX = (lane) => -TRACK_W / 2 + LANE_W * (lane + 0.5);
        const fxX = (n) => (n.lane === 0 ? -LANE_W : LANE_W);
        const btSide = (n) => (n.lane < 2 ? 0 : 1);       // BT lanes 0-1 left, 2-3 right
        const fxSide = (n) => n.lane;                      // FX lane 0 left, 1 right

        for (const group of [...this.noteGroups, this.lasersGroup]) {
            group.traverse((obj) => {
                if (obj.userData.shared) return;
                if (obj.geometry) obj.geometry.dispose();
                if (obj.material) {
                    if (obj.material.map) obj.material.map.dispose();
                    obj.material.dispose();
                }
            });
            group.clear();
        }

        const dummy = new THREE.Object3D();

        // Measure lines: one half-width instanced mesh per side
        for (let h = 0; h < 2; h++) {
            const sign = h === 0 ? -1 : 1;
            const mesh = new THREE.InstancedMesh(
                new THREE.PlaneGeometry(TRACK_W / 2, 0.035),
                new THREE.MeshBasicMaterial({
                    color: COLORS.measureLine, transparent: true, opacity: 0.35, depthWrite: false,
                }),
                chart.measures.length
            );
            chart.measures.forEach((m, idx) => {
                dummy.position.set(sign * TRACK_W / 4, 0.001, zOf(m.time));
                dummy.rotation.set(-Math.PI / 2, 0, 0);
                dummy.scale.set(1, 1, 1);
                dummy.updateMatrix();
                mesh.setMatrixAt(idx, dummy.matrix);
            });
            this.noteGroups[h].add(mesh);
        }
        dummy.rotation.set(0, 0, 0);

        // Holds: flat rounded strips merged per half (FX under BT)
        const addHolds = (notes, sideFn, xFn, w, y, color, opacity) => {
            for (let h = 0; h < 2; h++) {
                const holds = notes.filter((n) => n.endQuarters > n.quarters && sideFn(n) === h);
                if (!holds.length) continue;
                const geo = mergedRoundedStrips(holds.map((n) => ({
                    x: xFn(n),
                    z: zOf(n.time),
                    len: (scrollPosAt(chart, n.endTime) - scrollPosAt(chart, n.time)) * K,
                    w,
                })), y);
                this.noteGroups[h].add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                    color, transparent: true, opacity, depthWrite: false,
                })));
            }
        };
        addHolds(chart.fxNotes, fxSide, fxX, LANE_W * 2 - 0.1, 0.015, COLORS.fxHold, 0.45);
        addHolds(chart.btNotes, btSide, (n) => laneX(n.lane), LANE_W - 0.14, 0.03, COLORS.btHold, 0.55);

        // Chips: rounded instanced boxes per half (FX under BT)
        const addChips = (notes, sideFn, xFn, geoW, geoD, geoH, y, color) => {
            for (let h = 0; h < 2; h++) {
                const chips = notes.filter((n) => n.endQuarters === n.quarters && sideFn(n) === h);
                if (!chips.length) continue;
                const mesh = new THREE.InstancedMesh(
                    roundedChipGeometry(geoW, geoD, geoH),
                    new THREE.MeshBasicMaterial({ color }),
                    chips.length
                );
                chips.forEach((n, idx) => {
                    dummy.position.set(xFn(n), y, zOf(n.time));
                    dummy.updateMatrix();
                    mesh.setMatrixAt(idx, dummy.matrix);
                });
                this.noteGroups[h].add(mesh);
            }
        };
        addChips(chart.fxNotes, fxSide, fxX, LANE_W * 2 - 0.08, 0.16, 0.045, 0.002, COLORS.fxChip);
        addChips(chart.btNotes, btSide, (n) => laneX(n.lane), LANE_W - 0.08, 0.18, 0.02, 0.002, COLORS.btChipBottom);
        addChips(chart.btNotes, btSide, (n) => laneX(n.lane), LANE_W - 0.08, 0.16, 0.06, 0.025, COLORS.btChip);

        // Lasers: ribbons on top of everything (not split by center_split)
        for (const section of chart.lasers) {
            const geo = this.buildLaserGeometry(section, K, zOf);
            const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
                color: section.side === 0 ? COLORS.laserL : COLORS.laserR,
                transparent: true, opacity: 0.8, side: THREE.DoubleSide,
                blending: THREE.AdditiveBlending, depthWrite: false,
            }));
            mesh.renderOrder = 10;
            this.lasersGroup.add(mesh);
        }

        // L / R letter inside each laser section's entry tail (shared assets,
        // reused across rebuilds — only Z positions depend on the speed)
        if (chart.lasers.length) {
            if (!this._letterAssets) {
                const geo = new THREE.PlaneGeometry(0.3, 0.44);
                geo.rotateX(-Math.PI / 2);
                this._letterAssets = {
                    geo,
                    mats: ['L', 'R'].map((letter) => new THREE.MeshBasicMaterial({
                        map: makeLetterTexture(letter), transparent: true, depthWrite: false,
                    })),
                };
            }
            for (const s of chart.lasers) {
                const mesh = new THREE.Mesh(this._letterAssets.geo, this._letterAssets.mats[s.side]);
                mesh.userData.shared = true;
                mesh.position.set(
                    (s.points[0].pos - 0.5) * TRACK_W,
                    0.095,
                    zOf(s.points[0].time) + LASER_TAIL_LEN / 2
                );
                mesh.renderOrder = 11;
                this.lasersGroup.add(mesh);
            }
        }
    }

    /**
     * Laser ribbon in the XZ plane: one quad per point pair, horizontal
     * slams, plus a rectangular entry tail before the first point and an
     * exit tail after the last one (like the game's GenerateTrackEntry/Exit),
     * so the start and end of the laser are visible.
     */
    buildLaserGeometry(section, K, zOf) {
        const posToX = (p) => (p - 0.5) * TRACK_W;
        const verts = [];
        const pts = section.points;
        const y = 0.09;
        const hw = LASER_W / 2;

        const pushQuad = (x1, z1, x2, z2) => {
            verts.push(
                x1 - hw, y, z1, x1 + hw, y, z1, x2 + hw, y, z2,
                x1 - hw, y, z1, x2 + hw, y, z2, x2 - hw, y, z2
            );
        };

        // Entry tail: rectangle before the starting point
        const startX = posToX(pts[0].pos);
        const startZ = zOf(pts[0].time);
        pushQuad(startX, startZ + LASER_TAIL_LEN, startX, startZ);

        // Actual drawn end (a final slam shifts the exit by its height)
        let endX = startX, endZ = startZ;

        for (let i = 0; i < pts.length - 1; i++) {
            const a = pts[i], b = pts[i + 1];
            const xa = posToX(a.pos), xb = posToX(b.pos);
            const za = zOf(a.time), zb = zOf(b.time);
            if (a.slam) {
                // Slam: horizontal segment with a minimum visual height
                const h = Math.max(za - zb, 0.22);
                const lo = Math.min(xa, xb) - hw, hi = Math.max(xa, xb) + hw;
                verts.push(
                    lo, y, za, hi, y, za, hi, y, za - h,
                    lo, y, za, hi, y, za - h, lo, y, za - h
                );
                endX = xb; endZ = za - h;
                // Connect to the next point from the slam exit
                if (i + 2 < pts.length) {
                    const c = pts[i + 2];
                    endX = posToX(c.pos); endZ = zOf(c.time);
                    pushQuad(xb, za - h, endX, endZ);
                    i++; // the b→c segment is already drawn
                }
            } else {
                pushQuad(xa, za, xb, zb);
                endX = xb; endZ = zb;
            }
        }

        // Exit tail: rectangle after the end
        pushQuad(endX, endZ, endX, endZ - LASER_TAIL_LEN);

        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
        return geo;
    }

    /** Set the scroll and camera effects for chart time t (seconds). */
    setTime(t) {
        this.currentTime = t;
        if (!this.chart) return;

        const scroll = scrollPosAt(this.chart, t) * this.unitsPerSecond;
        this.noteGroups[0].position.z = scroll;
        this.noteGroups[1].position.z = scroll;
        this.lasersGroup.position.z = scroll;

        const dt = clamp(t - this._lastT, 0, 0.1);
        const jumped = Math.abs(t - this._lastT) > 0.5;
        this._lastT = t;

        this.applyCameraEffects(t, dt, jumped);
    }

    /** Per-frame camera effect evaluation — mirrors the game's Camera::Tick. */
    applyCameraEffects(t, dt, jumped) {
        if (!this.effectsEnabled) {
            this.highway.matrix.identity();
            this.highway.matrixWorldNeedsUpdate = true;
            this.halves[0].position.x = 0;
            this.halves[1].position.x = 0;
            return;
        }

        const cam = this.chart.camera;

        const zoomBottom = curveValueAt(cam.zoomBottom, t);
        const zoomTop = curveValueAt(cam.zoomTop, t);
        const zoomSide = curveValueAt(cam.zoomSide, t);
        const split = Math.max(0, curveValueAt(cam.centerSplit, t));

        // --- Slam windows and camera shake (processed before the roll input) ---
        if (jumped) {
            this._shake = 0;
            this._shakeGuard = 0;
            this._slamTimer = [0, 0];
            this._slamIdx = lastIndexAt(cam.slams, t) + 1;
        } else {
            while (this._slamIdx < cam.slams.length && cam.slams[this._slamIdx].time <= t) {
                const slam = cam.slams[this._slamIdx++];
                // Shake: camera yaw in degrees (≤1°), guarded against
                // rapid slams cancelling each other within a frame
                if (this._shakeGuard <= 0) {
                    this._shake = -slam.size;
                    this._shakeGuard = 1 / 60;
                }
                // Roll ignore: the slam tail drives this side's roll input
                // for 100 ms, then it reads 0 for another 100 ms
                this._slamTimer[slam.side] = SLAM_ROLL_DURATION + ROLL_IGNORE_DURATION;
                this._slamValue[slam.side] = laserRoll(slam.side, slam.tail);
            }
            this._shakeGuard -= dt;
            this._slamTimer[0] -= dt;
            this._slamTimer[1] -= dt;
            const decay = SHAKE_DECAY * dt;
            this._shake = Math.max(Math.abs(this._shake) - decay, 0) * Math.sign(this._shake);
        }

        // --- Roll: two-stage constant-rate pursuit, mirroring Camera::Tick ---
        // Stage 1: crit line roll chases the laser target.
        // Stage 2: the applied highway roll chases stage 1 × intensity (or the
        // manual tilt / keep value), each stage capped at its own speed limit.
        const tilt = tiltStateAt(this.chart, t);
        const posL = laserPosAt(this.chart, 0, t);
        const posR = laserPosAt(this.chart, 1, t);
        const inputRoll = (side, pos) => {
            if (this._slamTimer[side] > ROLL_IGNORE_DURATION) return this._slamValue[side];
            if (this._slamTimer[side] > 0) return 0;
            return pos === null ? 0 : laserRoll(side, pos);
        };
        const rollL = inputRoll(0, posL);
        const rollR = inputRoll(1, posR);
        // Game slowTilt: lasers at opposite extremes, or both neutral/absent
        const slowTilt = (rollL === -1 && rollR === 1) || (rollL === 0 && rollR === 0);
        const targetCrit = clamp(rollL + rollR, -1, 1) * MAX_ROLL_TURNS;

        let critSpeed = MAX_ROLL_TURNS * ROLL_SPEED;
        if (slowTilt) {
            critSpeed /= Math.abs(this._critRoll) > MAX_ROLL_TURNS * 0.1 ? 4 : 8;
        }
        this._critRoll = jumped ? targetCrit
            : lerpToward(this._critRoll, targetCrit, critSpeed * dt);

        // Roll keep: hold the strongest same-direction target (SetTargetRoll's
        // ShouldRollDuringKeep), tracked without the slam contribution
        const zeroedRoll = (side, pos) =>
            this._slamTimer[side] > 0 ? 0 : (pos === null ? 0 : laserRoll(side, pos));
        const keepInput = clamp(zeroedRoll(0, posL) + zeroedRoll(1, posR), -1, 1);
        if (!tilt.keep || this._rollKeepTarget === 0 ||
            (Math.sign(this._rollKeepTarget) === Math.sign(keepInput) &&
             Math.abs(this._rollKeepTarget) < Math.abs(keepInput))) {
            this._rollKeepTarget = keepInput;
        }

        let rollTarget;
        if (tilt.manual) {
            // tilt 1.0 = -10° (game stores value × -(10/360))
            rollTarget = curveValueAt(cam.tiltManual, t) * -MAX_ROLL_TURNS;
        } else if (tilt.keep) {
            rollTarget = this._rollKeepTarget * MAX_ROLL_TURNS * tilt.intensity;
        } else {
            rollTarget = this._critRoll * tilt.intensity;
        }

        if (tilt.manual !== this._wasManual) this._tiltCatchUp = true;
        this._wasManual = tilt.manual;

        let rollSpeed = MAX_ROLL_TURNS * ROLL_SPEED
            * Math.max(tilt.intensity, this._lastIntensity);
        if (rollSpeed === 0 || tilt.manual || this._tiltCatchUp) {
            rollSpeed = MAX_ROLL_TURNS * ROLL_SPEED * 2.5;
        }
        if (tilt.manual || this._tiltCatchUp) {
            // Catch-up boost when more than 10° away from the target
            const delta = Math.abs(this._actualRoll - rollTarget) - MAX_ROLL_TURNS;
            if (delta > 0) rollSpeed *= 1 + (delta * 360) / 2.5;
        }
        this._lastIntensity = tilt.intensity;

        // Manual tilt sections starting with a slam apply instantly
        const manualInstant = tilt.manual && this.manualTiltInstant(t);
        if (jumped || manualInstant) this._actualRoll = rollTarget;
        else this._actualRoll = lerpToward(this._actualRoll, rollTarget, rollSpeed * dt);
        if (this._tiltCatchUp && this._actualRoll === rollTarget) this._tiltCatchUp = false;

        // --- Spin (slam-triggered): full 360° / quarter swing / lateral bounce ---
        let spinRollTurns = 0;
        let bounceX = 0;
        const spin = this.activeSpinAt(t);
        if (spin) {
            const st = (t - spin.time) / spin.duration / 2;
            if (spin.type === 'full') {
                if (st <= 0.375) spinRollTurns = -spin.dir * (0.375 - st) / 0.375;
                else if (st < 0.75) spinRollTurns = swing((st - 0.375) / 0.375) * 0.25 * spin.dir;
            } else if (spin.type === 'quarter') {
                spinRollTurns = swing(Math.min(st, 1)) * spin.dir;
            } else {
                bounceX = dampedSin(st, spin.amplitude, spin.frequency / 2, spin.decay)
                    * spin.dir * TRACK_W;
            }
        }

        // --- Compose the highway matrix: T(zoom) · Ry(shake) · Rz(roll) · T(offsetX) · Rx(pitch) ---
        const rollRad = -(this._actualRoll + spinRollTurns) * Math.PI * 2;
        const pitchRad = THREE.MathUtils.degToRad(pitchScale(zoomTop) * PITCH_UNIT_DEG);
        const shakeRad = THREE.MathUtils.degToRad(this._shake);
        const offsetX = zoomSide * SIDE_OFFSET + bounceX;

        // zoom_bottom: translation along the camera→track axis (asymmetric)
        let zoomAmt;
        if (zoomBottom <= 0) {
            zoomAmt = (Math.pow(ZOOM_POW, -zoomBottom) - 1) * ZOOM_SCALE;
        } else {
            const dist = this.camera.position.length();
            zoomAmt = dist * (Math.pow(ZOOM_POW, -Math.pow(zoomBottom, 1.35)) - 1);
        }
        this._zoomDir.copy(this.camera.position).negate().normalize().multiplyScalar(zoomAmt);

        const m = this._workMatrix;
        m.makeTranslation(this._zoomDir.x, this._zoomDir.y, this._zoomDir.z);
        m.multiply(this._tmpMatrix.makeRotationY(shakeRad));
        m.multiply(this._tmpMatrix.makeRotationZ(rollRad));
        m.multiply(this._tmpMatrix.makeTranslation(offsetX, 0, 0));
        m.multiply(this._tmpMatrix.makeRotationX(pitchRad));
        this.highway.matrix.copy(m);
        this.highway.matrixWorldNeedsUpdate = true;

        // --- center_split: push the two halves apart ---
        const splitOffset = split * SPLIT_UNIT;
        this.halves[0].position.x = -splitOffset;
        this.halves[1].position.x = splitOffset;
    }

    /**
     * True while the current manual tilt section should apply instantly:
     * the first tiltManual point after the last tilt-mode change is a slam
     * already reached (game CheckIfManualTiltInstant).
     */
    manualTiltInstant(t) {
        const cam = this.chart.camera;
        const ei = lastIndexAt(cam.tiltEvents, t);
        const sectionStart = ei >= 0 ? cam.tiltEvents[ei].time : 0;
        const first = cam.tiltManual[lastIndexAt(cam.tiltManual, sectionStart - 1e-9) + 1];
        return !!first && first.time <= t && first.vIn !== first.vOut;
    }

    /** Most recent spin still in effect at time t, if any. */
    activeSpinAt(t) {
        const spins = this.chart.camera.spins;
        const i = lastIndexAt(spins, t);
        if (i < 0) return null;
        // Roll/bounce formulas fade out by progress 2 (see Camera::Tick)
        return (t - spins[i].time) / spins[i].duration < 2 ? spins[i] : null;
    }

    /** Transparent scene background so the cover video shows through. */
    setVideoBackground(enabled) {
        this.scene.background = enabled ? null : new THREE.Color(COLORS.background);
    }

    resize() {
        const parent = this.canvas.parentElement;
        if (!parent) return;
        const w = parent.clientWidth, h = parent.clientHeight;
        if (w === 0 || h === 0) return;
        this.renderer.setSize(w, h, false);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
    }

    render() {
        this.renderer.render(this.scene, this.camera);
    }
}

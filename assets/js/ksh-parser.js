/**
 * KShootMania chart (.ksh) parser
 *
 * Format: "key=value" header up to the first "--", then measures separated
 * by "--". Chart line: "BBBB|FF|LL" (4 BT buttons, 2 FX, 2 lasers) plus an
 * optional spin suffix.
 * BT: 0 = none, 1 = chip, 2 = hold. FX: 0 = none, 2 = chip, anything else = hold.
 * Lasers: '-' = none, ':' = interpolation, otherwise base-51 position (0-9A-Za-o).
 *
 * Camera effects (zoom_*, tilt, center_split, spins, stop) are collected into
 * chart.camera — curves and events driving the camera effects.
 */

const LASER_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno';

// Two laser points at most 1/32 of a whole note apart (0.125 quarter) form a slam
const SLAM_THRESHOLD_Q = 0.13;

const DIFFICULTY_NAMES = {
    light: 'NOV',
    challenge: 'ADV',
    extended: 'EXH',
    infinite: 'INF',
};

export function difficultyShortName(difficulty) {
    return DIFFICULTY_NAMES[difficulty] || (difficulty || '?').toUpperCase().slice(0, 3);
}

export function parseKsh(text) {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/);

    const meta = {};
    let i = 0;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '--') { i++; break; }
        const eq = line.indexOf('=');
        if (eq > 0) meta[line.slice(0, eq)] = line.slice(eq + 1);
    }

    const chart = {
        meta: {
            title: meta.title || '',
            artist: meta.artist || '',
            effect: meta.effect || '',
            difficulty: meta.difficulty || '',
            level: parseInt(meta.level, 10) || 0,
            audioFile: (meta.m || '').split(';')[0].trim(),
            offsetMs: parseFloat(meta.o) || 0,
        },
        timing: [],      // {time, bpm} — BPM change points
        measures: [],    // {time} — start of each measure
        btNotes: [],     // {lane 0-3, time, quarters, endTime, endQuarters} (end == start for a chip)
        fxNotes: [],     // {lane 0-1, ...}
        // Laser sections: points carry the visual position (pos, extended-range
        // adjusted) and the raw 0-1 position (raw, used for the roll input like
        // the game); points starting a slam segment have .slam = true
        lasers: [],      // {side 0-1, points: [{time, quarters, pos, raw, slam?}]}
        laserBySide: [[], []],
        // Camera effects — curves are {time, vIn, vOut}
        camera: {
            zoomBottom: [],   // highway distance (zoom_bottom / 100)
            zoomTop: [],      // pitch (zoom_top / 100)
            zoomSide: [],     // X translation (zoom_side / 100)
            tiltManual: [],   // numeric tilt (raw KSH value, 1 = 10° of screen roll)
            centerSplit: [],  // half-track separation (center_split / 100)
            tiltEvents: [],   // {time, mode: 'zero'|'normal'|'bigger'|'biggest'|'manual', keep}
            spins: [],        // {time, type: 'full'|'quarter'|'bounce', dir, duration, amplitude, frequency, decay}
            stops: [],        // {time, duration} — frozen scroll
            slams: [],        // {time, side, size, tail} — laser slams (raw positions)
        },
    };

    let bpm = parseFloat(meta.t);
    if (!isFinite(bpm)) bpm = 120; // range header ("189-216"): the first body t= takes over
    let sigN = 4, sigD = 4;
    let time = 0, quarters = 0;

    const cam = chart.camera;
    // A second point at the same instant creates a discontinuity (zoom/tilt slam)
    const curveInsert = (curve, value) => {
        const last = curve[curve.length - 1];
        if (last && Math.abs(last.time - time) < 1e-9) last.vOut = value;
        else curve.push({ time, vIn: value, vOut: value });
    };

    chart.timing.push({ time: 0, bpm });

    const btHolds = [null, null, null, null];
    const fxHolds = [null, null];
    const laserSections = [null, null];
    const laserRangePending = [1, 1];

    const makeHoldCloser = (holds) => (lane) => {
        if (!holds[lane]) return;
        holds[lane].endTime = time;
        holds[lane].endQuarters = quarters;
        holds[lane] = null;
    };
    const closeBtHold = makeHoldCloser(btHolds);
    const closeFxHold = makeHoldCloser(fxHolds);

    // Split the body into measures
    let measure = [];
    const measures = [];
    for (; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line === '--') { measures.push(measure); measure = []; }
        else if (line !== '') measure.push(line);
    }
    if (measure.length) measures.push(measure);

    for (const block of measures) {
        // Separate chart lines from options (options attach to the next chart line)
        const chartLines = [];
        const optionsByLine = new Map();
        let pending = [];
        for (const raw of block) {
            if (raw.startsWith('//') || raw.startsWith('#')) continue;
            const parts = raw.split('|');
            if (parts.length >= 3 && parts[0].length === 4 && raw.indexOf('=') === -1) {
                if (pending.length) { optionsByLine.set(chartLines.length, pending); pending = []; }
                chartLines.push(parts);
            } else if (raw.indexOf('=') > 0) {
                pending.push(raw);
            }
        }
        if (pending.length) optionsByLine.set(-1, pending); // trailing options

        // beat= only applies at the start of a measure
        const applyOption = (opt) => {
            const eq = opt.indexOf('=');
            const key = opt.slice(0, eq), value = opt.slice(eq + 1);
            if (key === 't') {
                const newBpm = parseFloat(value);
                if (isFinite(newBpm) && newBpm > 0 && newBpm !== bpm) {
                    bpm = newBpm;
                    chart.timing.push({ time, bpm });
                }
            } else if (key === 'beat') {
                const m = value.match(/^(\d+)\/(\d+)$/);
                if (m) { sigN = parseInt(m[1], 10); sigD = parseInt(m[2], 10); }
            } else if (key === 'laserrange_l') {
                laserRangePending[0] = value.startsWith('2') ? 2 : 1;
            } else if (key === 'laserrange_r') {
                laserRangePending[1] = value.startsWith('2') ? 2 : 1;
            } else if (key === 'zoom_bottom') {
                curveInsert(cam.zoomBottom, parseFloat(value) / 100);
            } else if (key === 'zoom_top') {
                curveInsert(cam.zoomTop, parseFloat(value) / 100);
            } else if (key === 'zoom_side') {
                curveInsert(cam.zoomSide, parseFloat(value) / 100);
            } else if (key === 'center_split') {
                curveInsert(cam.centerSplit, parseFloat(value) / 100);
            } else if (key === 'tilt') {
                if (/^-?\d+(\.\d+)?$/.test(value)) {
                    curveInsert(cam.tiltManual, parseFloat(value));
                    const last = cam.tiltEvents[cam.tiltEvents.length - 1];
                    if (!last || last.mode !== 'manual') {
                        cam.tiltEvents.push({ time, mode: 'manual', keep: false });
                    }
                } else {
                    const keep = value.startsWith('keep_');
                    const mode = keep ? value.slice(5) : value;
                    if (['zero', 'normal', 'bigger', 'biggest'].includes(mode)) {
                        cam.tiltEvents.push({ time, mode, keep });
                    }
                }
            } else if (key === 'stop') {
                const ticks = parseFloat(value);
                if (isFinite(ticks) && ticks > 0) {
                    cam.stops.push({ time, duration: (ticks / 192) * 4 * 60 / bpm });
                }
            }
            // fx-*, filtertype, lane_toggle… : not handled by the viewer
        };

        // Apply any beat= up front to size the measure
        for (const opts of optionsByLine.values()) {
            for (const o of opts) if (o.startsWith('beat=')) applyOption(o);
        }

        const measureQuarters = 4 * sigN / sigD;
        const lineCount = Math.max(chartLines.length, 1);
        const qPerLine = measureQuarters / lineCount;

        chart.measures.push({ time });

        for (let li = 0; li < chartLines.length; li++) {
            const opts = optionsByLine.get(li);
            if (opts) for (const o of opts) { if (!o.startsWith('beat=')) applyOption(o); }

            const [bt, fx, laserPart] = chartLines[li];

            for (let lane = 0; lane < 4; lane++) {
                const c = bt[lane];
                if (c === '2') {
                    if (!btHolds[lane]) {
                        btHolds[lane] = { lane, time, quarters, endTime: time, endQuarters: quarters };
                        chart.btNotes.push(btHolds[lane]);
                    }
                } else {
                    closeBtHold(lane);
                    if (c === '1') chart.btNotes.push({ lane, time, quarters, endTime: time, endQuarters: quarters });
                }
            }

            for (let lane = 0; lane < 2; lane++) {
                const c = fx[lane];
                if (c === '0') {
                    closeFxHold(lane);
                } else if (c === '2') {
                    closeFxHold(lane);
                    chart.fxNotes.push({ lane, time, quarters, endTime: time, endQuarters: quarters });
                } else {
                    // '1' or an effect letter (legacy format): hold
                    if (!fxHolds[lane]) {
                        fxHolds[lane] = { lane, time, quarters, endTime: time, endQuarters: quarters };
                        chart.fxNotes.push(fxHolds[lane]);
                    }
                }
            }

            // Spin attached to a slam: notation after the 2 laser characters
            // "@(192" / "@)384" (full spin), "@<48" / "@>48" (quarter spin),
            // "S<d;amp;freq;decay" (lateral bounce) — durations in 1/192 of a measure
            const spinPart = laserPart.slice(2);
            if (spinPart.length >= 2 && (spinPart[0] === '@' || spinPart[0] === 'S')) {
                const bounce = spinPart[0] === 'S';
                const sym = spinPart[1];
                if ('()<>'.includes(sym)) {
                    const params = spinPart.slice(2).split(';').map(Number);
                    const ticks = isFinite(params[0]) && params[0] > 0 ? params[0] : 192;
                    const measureSec = 4 * 60 / bpm;
                    cam.spins.push({
                        time,
                        type: bounce ? 'bounce' : (sym === '(' || sym === ')') ? 'full' : 'quarter',
                        dir: (sym === ')' || sym === '>') ? 1 : -1,
                        duration: (bounce ? 0.5 : 1) * (ticks / 192) * measureSec,
                        amplitude: bounce && isFinite(params[1]) ? params[1] / 250 : 0,
                        frequency: bounce && isFinite(params[2]) ? params[2] : 2,
                        // The game passes the spin duration where the decay is
                        // expected (Game.cpp:2174), so its {0,1,else}→{0,1.5,3}
                        // mapping always lands on 3 for real charts
                        decay: bounce ? 3 : 0,
                    });
                }
            }

            for (let side = 0; side < 2; side++) {
                const c = laserPart.length > side ? laserPart[side] : '-';
                if (c === '-') {
                    if (laserSections[side]) {
                        laserSections[side] = null;
                        laserRangePending[side] = 1;
                    }
                } else if (c !== ':') {
                    const idx = LASER_CHARS.indexOf(c);
                    if (idx >= 0) {
                        if (!laserSections[side]) {
                            laserSections[side] = { side, range: laserRangePending[side], points: [] };
                            chart.lasers.push(laserSections[side]);
                        }
                        const raw = idx / (LASER_CHARS.length - 1);
                        // The game keeps roll on the raw 0-1 position; the
                        // extended (2x) transform is visual-only
                        const pos = laserSections[side].range === 2 ? raw * 2 - 0.5 : raw;
                        laserSections[side].points.push({ time, quarters, pos, raw });
                    }
                }
                // ':' : linear interpolation between explicit points, nothing to store
            }

            time += qPerLine * 60 / bpm;
            quarters += qPerLine;
        }

        // Trailing options (take effect from here on)
        const trailing = optionsByLine.get(-1);
        if (trailing) for (const o of trailing) { if (!o.startsWith('beat=')) applyOption(o); }

        // Measure without any chart line: still advances a full measure
        if (chartLines.length === 0) {
            time += measureQuarters * 60 / bpm;
            quarters += measureQuarters;
        }
    }

    for (let lane = 0; lane < 4; lane++) closeBtHold(lane);
    for (let lane = 0; lane < 2; lane++) closeFxHold(lane);
    chart.lasers = chart.lasers.filter((s) => s.points.length >= 2);

    // Classify slams once: mark segment starts and emit slam events
    for (const section of chart.lasers) {
        const pts = section.points;
        for (let p = 0; p < pts.length - 1; p++) {
            if (pts[p + 1].quarters - pts[p].quarters <= SLAM_THRESHOLD_Q &&
                pts[p].pos !== pts[p + 1].pos) {
                pts[p].slam = true;
                cam.slams.push({
                    time: pts[p].time,
                    side: section.side,
                    size: Math.max(-1, Math.min(1, pts[p + 1].raw - pts[p].raw)),
                    tail: pts[p + 1].raw,
                });
            }
        }
        chart.laserBySide[section.side].push(section);
    }
    cam.slams.sort((a, b) => a.time - b.time);

    return chart;
}

/** Index of the last element with .time <= t in a time-sorted array, or -1. */
export function lastIndexAt(arr, t) {
    let lo = -1, hi = arr.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (arr[mid].time <= t) lo = mid;
        else hi = mid - 1;
    }
    return lo;
}

/** Current BPM at time t (s). */
export function bpmAt(chart, t) {
    return chart.timing[Math.max(lastIndexAt(chart.timing, t), 0)].bpm;
}

/** Measure number (1-indexed) at time t (s). */
export function measureAt(chart, t) {
    return Math.max(lastIndexAt(chart.measures, t), 0) + 1;
}

/**
 * Sample a camera curve at time t. Linear interpolation between control
 * points, honoring per-point in/out values (discontinuities on slams) —
 * equivalent of the game's LineGraph::ValueAt.
 */
export function curveValueAt(curve, t, defaultValue = 0) {
    if (!curve.length) return defaultValue;
    if (t < curve[0].time) return curve[0].vIn;
    if (t >= curve[curve.length - 1].time) return curve[curve.length - 1].vOut;
    const i = lastIndexAt(curve, t);
    const a = curve[i], b = curve[i + 1];
    return a.vOut + (b.vIn - a.vOut) * ((t - a.time) / (b.time - a.time));
}

/** Scroll position (s) at time t: time minus the portions frozen by stop=. */
export function scrollPosAt(chart, t) {
    let s = t;
    for (const st of chart.camera.stops) {
        if (t >= st.time + st.duration) s -= st.duration;
        else if (t > st.time) s -= t - st.time;
        else break;
    }
    return s;
}

/** Tilt state at time t: roll intensity multiplier + manual/keep flags. */
const TILT_INTENSITY = { zero: 0, normal: 1, bigger: 1.75, biggest: 2.5, manual: 1 };
export function tiltStateAt(chart, t) {
    const events = chart.camera.tiltEvents;
    const i = lastIndexAt(events, t);
    const mode = i >= 0 ? events[i].mode : 'normal';
    return { intensity: TILT_INTENSITY[mode], manual: mode === 'manual', keep: i >= 0 && events[i].keep };
}

/**
 * Laser roll position (raw 0-1) for one side at time t, or null when no
 * laser is active. Mirrors Scoring::GetLaserRollOutput, including the 2-beat
 * look-ahead: an upcoming section pre-rolls the camera toward its start.
 */
export function laserPosAt(chart, side, t) {
    for (const section of chart.laserBySide[side]) {
        const pts = section.points;
        if (t < pts[0].time) {
            const beat = 60 / bpmAt(chart, t);
            return pts[0].time - t <= beat * 2 ? pts[0].raw : null;
        }
        if (t > pts[pts.length - 1].time) continue;
        const i = lastIndexAt(pts, t);
        const a = pts[i], b = pts[i + 1];
        if (!b || b.time <= a.time) return a.raw;
        return a.raw + (b.raw - a.raw) * ((t - a.time) / (b.time - a.time));
    }
    return null;
}

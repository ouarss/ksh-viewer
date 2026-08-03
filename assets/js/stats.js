/**
 * Chart statistics modal: figures + hand-drawn canvas charts (no library).
 * Everything is computed from the parsed chart object; openStatsModal(chart)
 * fills and shows the modal.
 */

import { measureAt, difficultyShortName } from './ksh-parser.js';

const el = (id) => document.getElementById(id);

const clamp01 = (v) => Math.min(Math.max(v, 0), 1);

function formatTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

const SNAP_CLASSES = [
    [1, '1/4'], [0.5, '1/8'], [1 / 3, '1/12'], [0.25, '1/16'],
    [1 / 6, '1/24'], [0.125, '1/32'],
];

function computeStats(c) {
    const isHold = (n) => n.endQuarters > n.quarters;
    const btChips = c.btNotes.filter((n) => !isHold(n)).length;
    const btHolds = c.btNotes.length - btChips;
    const fxChips = c.fxNotes.filter((n) => !isHold(n)).length;
    const fxHolds = c.fxNotes.length - fxChips;
    const total = c.btNotes.length + c.fxNotes.length;

    let start = Infinity, end = 0;
    const starts = [];
    for (const notes of [c.btNotes, c.fxNotes]) {
        for (const n of notes) {
            starts.push(n.time);
            start = Math.min(start, n.time);
            end = Math.max(end, n.endTime);
        }
    }
    for (const s of c.lasers) {
        start = Math.min(start, s.points[0].time);
        end = Math.max(end, s.points[s.points.length - 1].time);
    }
    if (!isFinite(start)) start = 0;
    starts.sort((a, b) => a - b);
    const duration = Math.max(end - start, 0.001);

    // Peak NPS: densest 1-second window (two pointers over sorted starts)
    let peak = 0, peakTime = start, j = 0;
    for (let i = 0; i < starts.length; i++) {
        while (starts[i] - starts[j] > 1) j++;
        if (i - j + 1 > peak) { peak = i - j + 1; peakTime = starts[j]; }
    }

    const bpms = c.timing.map((s) => s.bpm);
    const lanes = [0, 0, 0, 0, 0, 0];
    for (const n of c.btNotes) lanes[n.lane]++;
    for (const n of c.fxNotes) lanes[4 + n.lane]++;

    const binCount = 64;
    const binDur = duration / binCount;
    const binOf = (t) => Math.min(Math.max(Math.floor((t - start) / binDur), 0), binCount - 1);
    const npsBins = new Array(binCount).fill(0);
    for (const t of starts) npsBins[binOf(t)]++;

    // Snap distribution: gap to the previous note, in beat fractions.
    // Unmatched gaps are kept (grouped on the 1/192-of-a-measure KSH grid)
    // so the "other" bucket can be itemized.
    const snapCounts = new Map(SNAP_CLASSES.map(([, label]) => [label, 0]));
    snapCounts.set('other', 0);
    const otherGaps = new Map();
    const quarters = [...c.btNotes, ...c.fxNotes].map((n) => n.quarters).sort((a, b) => a - b);
    for (let i = 1; i < quarters.length; i++) {
        const gap = quarters[i] - quarters[i - 1];
        if (gap < 1e-6 || gap > 1.06) continue; // chords and rests don't count
        const match = SNAP_CLASSES.find(([q]) => Math.abs(gap - q) / q < 0.06);
        if (match) {
            snapCounts.set(match[1], snapCounts.get(match[1]) + 1);
        } else {
            snapCounts.set('other', snapCounts.get('other') + 1);
            const key = Math.round(gap * 48) / 48;
            otherGaps.set(key, (otherGaps.get(key) || 0) + 1);
        }
    }
    const snapOther = [...otherGaps.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([gap, count]) => ({ label: fractionLabel(gap), count }));

    // Laser activity intervals per side (KSH sections of one side never overlap)
    const laserIv = [[], []];
    for (const s of c.lasers) {
        laserIv[s.side].push([s.points[0].time, s.points[s.points.length - 1].time]);
    }
    const coverage = laserIv.map((list) => {
        list.sort((a, b) => a[0] - b[0]);
        let covered = 0;
        for (const [s0, s1] of list) covered += s1 - s0;
        return clamp01(covered / duration);
    });
    const laserActive = (side, t) => {
        const list = laserIv[side];
        let lo = -1, hi = list.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (list[mid][0] <= t) lo = mid;
            else hi = mid - 1;
        }
        return lo >= 0 && t <= list[lo][1];
    };

    // Notes played while a laser is active: same side as the laser means the
    // laser hand must also hit buttons (hand trip), other side plays with a
    // single free hand (one-hand). Left hand: BT A/B + FX-L.
    let oneHand = 0, handTrip = 0;
    const noteEntries = [];
    for (const n of c.btNotes) noteEntries.push([n.time, n.lane < 2 ? 0 : 1]);
    for (const n of c.fxNotes) noteEntries.push([n.time, n.lane]);
    for (const [t, side] of noteEntries) {
        if (laserActive(side, t)) handTrip++;
        else if (laserActive(1 - side, t)) oneHand++;
    }

    // Hand balance over time
    const handBins = { left: new Array(binCount).fill(0), right: new Array(binCount).fill(0) };
    for (const [t, side] of noteEntries) handBins[side === 0 ? 'left' : 'right'][binOf(t)]++;

    // Rough SDVX-style profile radar, each axis scaled so a mid-tier chart
    // lands around the middle — approximations, not the game's exact formulas
    const oneHandRatio = oneHand / Math.max(total, 1);
    const handTripRatio = handTrip / Math.max(total, 1);
    const trickyEvents = (c.timing.length - 1) + c.camera.spins.length + c.camera.stops.length;
    const radar = {
        notes: clamp01(total / duration / 12),
        peak: clamp01(peak / 24),
        tsumami: clamp01(coverage[0] + coverage[1]),
        oneHand: clamp01(oneHandRatio * 2.5),
        handTrip: clamp01(handTripRatio * 4),
        tricky: clamp01((((c.timing.length - 1) + 2 * c.camera.spins.length
            + 2 * c.camera.stops.length) / Math.max(c.measures.length, 1)) * 6),
    };

    // X-axis reference points (start / middle / end), labeled time + measure
    const xLabels = [start, start + duration / 2, start + duration]
        .map((t) => ({ t, measure: measureAt(c, t) }));

    return {
        btChips, btHolds, fxChips, fxHolds, total,
        lasers: c.lasers.length,
        slams: c.camera.slams.length,
        spins: c.camera.spins.length,
        measures: c.measures.length,
        duration,
        bpmMin: Math.min(...bpms),
        bpmMax: Math.max(...bpms),
        avgNps: total / duration,
        peakNps: peak,
        peakMeasure: measureAt(c, peakTime),
        lanes, npsBins,
        snap: [...snapCounts.entries()],
        start,
        timing: c.timing,
        coverage, radar, handBins,
        oneHandRatio, handTripRatio, trickyEvents, xLabels, snapOther,
    };
}

/** Gap in quarters -> whole-note fraction label ("3/16"), or "0.31q". */
function fractionLabel(gapQuarters) {
    const whole = gapQuarters / 4;
    for (let d = 2; d <= 64; d++) {
        const n = Math.round(whole * d);
        if (n >= 1 && Math.abs(whole - n / d) / whole < 0.03) {
            const g = gcd(n, d);
            return `${n / g}/${d / g}`;
        }
    }
    return `${gapQuarters.toFixed(2)}q`;
}

function gcd(a, b) {
    return b ? gcd(b, a % b) : a;
}

function statsCanvasCtx(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    return { ctx, w, h };
}

// Bar chart: thin marks, direct value labels, text in ink tokens
function drawStatsBars(canvas, items) {
    const { ctx, w, h } = statsCanvasCtx(canvas);
    const base = h - 13;
    const slot = w / items.length;
    const barW = Math.min(slot - 8, 26);
    const max = Math.max(...items.map((it) => it.value), 1);
    ctx.textAlign = 'center';
    items.forEach((it, i) => {
        const x = i * slot + (slot - barW) / 2;
        const bh = Math.max((it.value / max) * (base - 14), 1);
        ctx.fillStyle = it.color;
        ctx.fillRect(x, base - bh, barW, bh);
        ctx.fillStyle = '#e8eaf6';
        ctx.fillText(String(it.value), i * slot + slot / 2, base - bh - 3);
        ctx.fillStyle = '#8a90b8';
        ctx.fillText(it.label, i * slot + slot / 2, h - 3);
    });
    ctx.strokeStyle = '#262b4a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, base + 0.5);
    ctx.lineTo(w, base + 0.5);
    ctx.stroke();
    ctx.textAlign = 'left';
}

// Area chart of notes/s over the chart: labeled y gridlines, dashed average
// line, peak directly labeled, time + measure references on the x axis
function drawStatsNps(canvas, stats) {
    const { ctx, w, h } = statsCanvasCtx(canvas);
    const base = h - 13;
    const bins = stats.npsBins;
    const binDur = stats.duration / bins.length;
    const max = Math.max(...bins, 1);
    const maxNps = max / binDur;
    const x = (i) => (i / (bins.length - 1)) * w;
    const y = (v) => base - (v / max) * (base - 12);
    const yNps = (nps) => y(nps * binDur);

    // Y gridlines on a readable step (1/2/5/10… per second)
    const mag = Math.pow(10, Math.floor(Math.log10(Math.max(maxNps / 3, 0.1))));
    const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => maxNps / s <= 4) || 10 * mag;
    ctx.strokeStyle = 'rgba(42, 46, 69, 0.55)';
    ctx.fillStyle = '#8a90b8';
    ctx.font = '9px "Segoe UI", system-ui, sans-serif';
    ctx.lineWidth = 1;
    for (let v = step; v <= maxNps; v += step) {
        const ly = Math.round(yNps(v)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, ly);
        ctx.lineTo(w, ly);
        ctx.stroke();
        ctx.fillText(`${v}/s`, 2, ly - 2);
    }

    ctx.beginPath();
    ctx.moveTo(0, base);
    bins.forEach((v, i) => ctx.lineTo(x(i), y(v)));
    ctx.lineTo(w, base);
    ctx.closePath();
    ctx.fillStyle = 'rgba(85, 96, 255, 0.25)';
    ctx.fill();

    ctx.beginPath();
    bins.forEach((v, i) => (i ? ctx.lineTo(x(i), y(v)) : ctx.moveTo(x(0), y(v))));
    ctx.strokeStyle = '#5560ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Dashed average line
    ctx.strokeStyle = 'rgba(232, 234, 246, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(yNps(stats.avgNps)) + 0.5);
    ctx.lineTo(w, Math.round(yNps(stats.avgNps)) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#e8eaf6';
    ctx.font = '10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(`avg ${stats.avgNps.toFixed(1)}/s`, w - 2, yNps(stats.avgNps) - 3);
    ctx.textAlign = 'left';

    ctx.strokeStyle = '#262b4a';
    ctx.beginPath();
    ctx.moveTo(0, base + 0.5);
    ctx.lineTo(w, base + 0.5);
    ctx.stroke();

    const peakBin = bins.indexOf(Math.max(...bins));
    const label = `peak ${maxNps.toFixed(1)}/s · #${stats.peakMeasure}`;
    ctx.fillStyle = '#e8eaf6';
    ctx.textAlign = peakBin > bins.length / 2 ? 'right' : 'left';
    ctx.fillText(label, x(peakBin) + (peakBin > bins.length / 2 ? -4 : 4), Math.max(y(max), 10));

    // X references: start / middle / end as time + measure
    ctx.fillStyle = '#8a90b8';
    stats.xLabels.forEach(({ t, measure }, i) => {
        ctx.textAlign = i === 0 ? 'left' : (i === 1 ? 'center' : 'right');
        ctx.fillText(`${formatTime(t)} · #${measure}`, i === 0 ? 0 : (i === 1 ? w / 2 : w), h - 3);
    });
    ctx.textAlign = 'left';
}

// Hexagonal SDVX-style profile radar over a 3-ring grid; each vertex is
// labeled with the real underlying figure so the shape stays interpretable
function drawStatsRadar(canvas, stats) {
    const { ctx, w, h } = statsCanvasCtx(canvas);
    const { radar } = stats;
    const axes = [
        ['NOTES', radar.notes, `${stats.avgNps.toFixed(1)}/s`],
        ['PEAK', radar.peak, `${stats.peakNps}/s`],
        ['TSUMAMI', radar.tsumami, `${Math.round((stats.coverage[0] + stats.coverage[1]) * 100)}%`],
        ['ONE-HAND', radar.oneHand, `${Math.round(stats.oneHandRatio * 100)}% notes`],
        ['HAND-TRIP', radar.handTrip, `${Math.round(stats.handTripRatio * 100)}% notes`],
        ['TRICKY', radar.tricky, `${stats.trickyEvents} events`],
    ];
    const cx = w / 2, cy = h / 2 + 2;
    const R = Math.min(w, h) / 2 - 34;
    const pt = (i, r) => {
        const a = -Math.PI / 2 + (i * Math.PI) / 3;
        return [cx + Math.cos(a) * r * R, cy + Math.sin(a) * r * R];
    };

    ctx.strokeStyle = '#262b4a';
    ctx.lineWidth = 1;
    for (const ring of [1 / 3, 2 / 3, 1]) {
        ctx.beginPath();
        for (let i = 0; i <= 6; i++) {
            const [x, y] = pt(i % 6, ring);
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
        }
        ctx.stroke();
    }
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const [x, y] = pt(i, 1);
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.beginPath();
    axes.forEach(([, v], i) => {
        const [x, y] = pt(i, Math.max(v, 0.05));
        if (i) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(85, 96, 255, 0.3)';
    ctx.fill();
    ctx.strokeStyle = '#5560ff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Axis label + real figure, placed outward from each vertex
    axes.forEach(([label, , value], i) => {
        const [x, y] = pt(i, 1.12);
        ctx.textAlign = x < cx - 5 ? 'right' : (x > cx + 5 ? 'left' : 'center');
        const top = i === 0;
        const labelY = top ? y - 13 : y + 3;
        ctx.fillStyle = '#8a90b8';
        ctx.font = '9px "Segoe UI", system-ui, sans-serif';
        ctx.fillText(label, x, labelY);
        ctx.fillStyle = '#e8eaf6';
        ctx.font = '600 10px "Segoe UI", system-ui, sans-serif';
        ctx.fillText(value, x, labelY + 11);
    });
    ctx.textAlign = 'left';
}

// BPM step timeline — soflan at a glance
function drawStatsBpm(canvas, stats) {
    const { ctx, w, h } = statsCanvasCtx(canvas);
    const base = h - 4;
    const { timing, start, duration, bpmMin, bpmMax } = stats;
    const pad = Math.max((bpmMax - bpmMin) * 0.15, 1);
    const x = (t) => Math.min(Math.max(((t - start) / duration) * w, 0), w);
    const y = (bpm) => base - ((bpm - (bpmMin - pad)) / (bpmMax - bpmMin + 2 * pad)) * (base - 14);

    ctx.strokeStyle = '#5560ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, y(timing[0].bpm));
    for (let i = 1; i < timing.length; i++) {
        ctx.lineTo(x(timing[i].time), y(timing[i - 1].bpm));
        ctx.lineTo(x(timing[i].time), y(timing[i].bpm));
    }
    ctx.lineTo(w, y(timing[timing.length - 1].bpm));
    ctx.stroke();

    // Each plateau gets its BPM value when there are few enough changes
    if (timing.length <= 6) {
        ctx.fillStyle = '#e8eaf6';
        ctx.textAlign = 'center';
        for (let i = 0; i < timing.length; i++) {
            const x0 = i ? x(timing[i].time) : 0;
            const x1 = i + 1 < timing.length ? x(timing[i + 1].time) : w;
            ctx.fillText(String(Math.round(timing[i].bpm * 10) / 10), (x0 + x1) / 2,
                y(timing[i].bpm) - 4);
        }
        ctx.textAlign = 'left';
    }

    ctx.fillStyle = '#8a90b8';
    ctx.fillText(bpmMin === bpmMax
        ? `${bpmMin} BPM (constant)`
        : `min ${bpmMin} · max ${bpmMax} · ${timing.length - 1} change${timing.length > 2 ? 's' : ''}`,
    0, 10);
}

// Hand balance: left hand (A/B/FX-L) fills up from the midline, right hand down
function drawStatsHands(canvas, stats) {
    const { ctx, w, h } = statsCanvasCtx(canvas);
    const { left, right } = stats.handBins;
    const mid = h / 2;
    const amp = mid - 14;
    const max = Math.max(...left, ...right, 1);
    const n = left.length;
    const x = (i) => (i / (n - 1)) * w;

    const area = (bins, dir, color) => {
        ctx.beginPath();
        ctx.moveTo(0, mid);
        bins.forEach((v, i) => ctx.lineTo(x(i), mid + dir * (v / max) * amp));
        ctx.lineTo(w, mid);
        ctx.closePath();
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.45;
        ctx.fill();
        ctx.globalAlpha = 1;
    };
    area(left, -1, '#00ffff');
    area(right, 1, '#ff0090');

    ctx.strokeStyle = '#262b4a';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, Math.round(mid) + 0.5);
    ctx.lineTo(w, Math.round(mid) + 0.5);
    ctx.stroke();

    const totalL = left.reduce((a, b) => a + b, 0);
    const totalR = right.reduce((a, b) => a + b, 0);
    const pct = Math.round((totalL / Math.max(totalL + totalR, 1)) * 100);
    ctx.fillStyle = '#8a90b8';
    ctx.fillText(`L ${pct}%`, 0, 10);
    ctx.fillText(`R ${100 - pct}%`, 0, h - 3);
}

// Laser coverage: % of chart time with an active laser, per side
function drawStatsLaser(canvas, stats) {
    const { ctx, w, h } = statsCanvasCtx(canvas);
    const rows = [['L', stats.coverage[0], '#00ffff'], ['R', stats.coverage[1], '#ff0090']];
    const barH = 12, gap = 10;
    const top = (h - (2 * barH + gap)) / 2;
    const trackX = 16, trackW = w - trackX - 46;

    rows.forEach(([label, cov, color], i) => {
        const y = top + i * (barH + gap);
        ctx.fillStyle = '#8a90b8';
        ctx.fillText(label, 2, y + barH - 2);
        ctx.fillStyle = 'rgba(38, 43, 74, 0.8)';
        ctx.fillRect(trackX, y, trackW, barH);
        ctx.fillStyle = color;
        ctx.globalAlpha = 0.85;
        ctx.fillRect(trackX, y, trackW * cov, barH);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#e8eaf6';
        ctx.fillText(`${Math.round(cov * 100)}%`, trackX + trackW + 6, y + barH - 2);
    });
}

function addStatFigure(dl, label, value) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    div.append(dt, dd);
    dl.appendChild(div);
}

export function openStatsModal(chart) {
    const stats = computeStats(chart);

    el('stats-title').textContent = chart.meta.title || 'Chart stats';
    el('stats-subtitle').textContent =
        `${difficultyShortName(chart.meta.difficulty)} ${chart.meta.level}`
        + (chart.meta.effect ? ` · effector: ${chart.meta.effect}` : '');

    const dl = el('stats-figures');
    dl.textContent = '';
    addStatFigure(dl, 'Duration', formatTime(stats.duration));
    addStatFigure(dl, 'Measures', String(stats.measures));
    addStatFigure(dl, 'BPM', stats.bpmMin === stats.bpmMax
        ? String(stats.bpmMin) : `${stats.bpmMin}–${stats.bpmMax}`);
    addStatFigure(dl, 'Total notes', String(stats.total));
    addStatFigure(dl, 'BT chips / holds', `${stats.btChips} / ${stats.btHolds}`);
    addStatFigure(dl, 'FX chips / holds', `${stats.fxChips} / ${stats.fxHolds}`);
    addStatFigure(dl, 'Laser sections', String(stats.lasers));
    addStatFigure(dl, 'Slams', String(stats.slams));
    addStatFigure(dl, 'Spins', String(stats.spins));
    addStatFigure(dl, 'Avg NPS', stats.avgNps.toFixed(2));
    addStatFigure(dl, 'Peak NPS (1 s)', `${stats.peakNps} · #${stats.peakMeasure}`);

    // "other" snap bucket itemized as whole-note fractions
    el('stats-snap-note').textContent = stats.snapOther.length
        ? `other = ${stats.snapOther.map(({ label, count }) => `${label} ×${count}`).join(' · ')}`
        : '';

    el('stats-modal').hidden = false;
    // Canvases need layout before drawing
    requestAnimationFrame(() => {
        drawStatsRadar(el('stats-radar'), stats);
        drawStatsNps(el('stats-nps'), stats);
        drawStatsBpm(el('stats-bpm'), stats);
        drawStatsHands(el('stats-hands'), stats);
        drawStatsBars(el('stats-lanes'), [
            { label: 'A', value: stats.lanes[0], color: '#e8eaf6' },
            { label: 'B', value: stats.lanes[1], color: '#e8eaf6' },
            { label: 'C', value: stats.lanes[2], color: '#e8eaf6' },
            { label: 'D', value: stats.lanes[3], color: '#e8eaf6' },
            { label: 'FX-L', value: stats.lanes[4], color: '#ff7a1a' },
            { label: 'FX-R', value: stats.lanes[5], color: '#ff7a1a' },
        ]);
        drawStatsLaser(el('stats-laser'), stats);
        drawStatsBars(el('stats-snap'), stats.snap.map(([label, value]) => ({
            label, value, color: '#5560ff',
        })));
    });
}

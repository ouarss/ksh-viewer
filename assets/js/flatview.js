/**
 * Flat 2D chart view (right panel): editor-style rendering of the loaded
 * chart on a single canvas, chartlab-style. Time flows bottom -> top within
 * a fixed-height column (the panel height), then continues in the next
 * column to the right; the strip of columns scrolls horizontally. Layout is
 * in quarters (beats) so measures keep a constant height regardless of BPM.
 *
 * The scroll is internal (no giant DOM/scrollbar): the canvas only ever
 * draws the visible columns, so chart length is unlimited. While "Follow"
 * is checked the strip scrolls right to keep the playhead anchored; wheel
 * or drag detaches it, a click seeks.
 */

import { lastIndexAt } from './ksh-parser.js';

const DEFAULT_PX_PER_QUARTER = 28; // vertical pixels per beat (Zoom slider changes it)
const COL_W = 132;            // fixed column width (px)
const GUTTER = 12;            // per-column side room for extended lasers + labels
const FOLLOW_ANCHOR_X = 0.3;  // playhead column position (fraction of width) while following
const CHIP_H = 5;
const LASER_W = 5;

/** m:ss.mmm — precise time display shared with the seek bar tooltip. */
export function formatTimeMs(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    const ms = Math.floor((s % 1) * 1000);
    return `${m}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

const COLORS = {
    background: '#0b0d18',
    track: '#11131f',
    laneLine: '#2a2e45',
    beatLine: 'rgba(42, 46, 69, 0.55)',
    measureLine: '#8890b0',
    columnLine: '#262b4a',
    text: '#8890b0',
    bpm: '#5560ff',
    btChip: '#ffffff',
    btHold: 'rgba(255, 246, 176, 0.42)',
    fxChip: '#ff7a1a',
    fxHold: 'rgba(255, 144, 48, 0.30)',
    laser: ['#00ffff', '#ff0090'],
    playhead: '#ff3355',
};

export class FlatView {
    /**
     * @param canvas   target <canvas>
     * @param followEl "Follow" checkbox controlling playhead tracking
     * @param onSeek   callback(chartTime) invoked when the user clicks the view
     */
    constructor(canvas, followEl, onSeek) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.followEl = followEl;
        this.onSeek = onSeek;

        this.chart = null;
        this.timingQ = [];   // chart.timing + cumulative quarters
        this.measures = [];  // {q, n} — measure starts in quarters
        this.totalQ = 0;
        this.scrollX = 0;    // horizontal offset into the column strip (px)
        this.hover = null;   // {x, y} canvas position of the pointer
        this.pxPerQuarter = DEFAULT_PX_PER_QUARTER;
        this.lastTime = -1;
        this.dirty = true;
        this.width = 0;
        this.height = 0;

        followEl.addEventListener('change', () => { this.dirty = true; });

        canvas.addEventListener('wheel', (e) => {
            e.preventDefault();
            if (!this.chart) return;
            this.scrollBy(e.deltaY);
        }, { passive: false });

        // Drag pans horizontally (content follows the pointer), a plain click seeks
        let dragging = false, moved = 0, lastX = 0;
        canvas.addEventListener('pointerdown', (e) => {
            dragging = true; moved = 0; lastX = e.clientX;
            canvas.setPointerCapture(e.pointerId);
        });
        canvas.addEventListener('pointermove', (e) => {
            const rect = canvas.getBoundingClientRect();
            this.hover = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            this.dirty = true;
            if (!dragging || !this.chart) return;
            const dx = e.clientX - lastX;
            moved += Math.abs(dx);
            lastX = e.clientX;
            if (moved > 4) this.scrollBy(-dx);
        });
        canvas.addEventListener('pointerleave', () => {
            this.hover = null;
            this.dirty = true;
        });
        canvas.addEventListener('pointerup', (e) => {
            dragging = false;
            if (!this.chart || moved > 4) return;
            const rect = canvas.getBoundingClientRect();
            const x = e.clientX - rect.left, y = e.clientY - rect.top;
            const col = Math.floor((x + this.scrollX) / COL_W);
            const q = col * this.columnQ() + (this.height - y) / this.pxPerQuarter;
            this.onSeek(this.timeAt(Math.max(q, 0)));
        });
    }

    columnQ() {
        return this.height / this.pxPerQuarter;
    }

    /** Vertical zoom: pixels per beat (Zoom slider). */
    setZoom(pxPerQuarter) {
        this.pxPerQuarter = Math.min(Math.max(pxPerQuarter, 6), 48);
        this.dirty = true;
    }

    scrollBy(dx) {
        this.scrollX += dx;
        this.followEl.checked = false;
        this.dirty = true;
    }

    setChart(chart) {
        this.chart = chart;

        this.timingQ = [];
        let q = 0;
        for (let i = 0; i < chart.timing.length; i++) {
            const seg = chart.timing[i];
            if (i > 0) q += (seg.time - chart.timing[i - 1].time) * chart.timing[i - 1].bpm / 60;
            this.timingQ.push({ time: seg.time, bpm: seg.bpm, quarters: q });
        }

        let end = 0;
        for (const n of chart.btNotes) end = Math.max(end, n.endTime);
        for (const n of chart.fxNotes) end = Math.max(end, n.endTime);
        for (const s of chart.lasers) end = Math.max(end, s.points[s.points.length - 1].time);
        if (chart.measures.length) end = Math.max(end, chart.measures[chart.measures.length - 1].time);
        this.totalQ = this.quartersAt(end) + 4;

        this.measures = chart.measures.map((m, i) => ({ q: this.quartersAt(m.time), n: i + 1 }));
        this.scrollX = 0;
        this.lastTime = -1;
        this.dirty = true;
    }

    quartersAt(t) {
        const seg = this.timingQ[Math.max(lastIndexAt(this.timingQ, t), 0)];
        return seg.quarters + (t - seg.time) * seg.bpm / 60;
    }

    timeAt(q) {
        let lo = -1, hi = this.timingQ.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.timingQ[mid].quarters <= q) lo = mid;
            else hi = mid - 1;
        }
        const seg = this.timingQ[Math.max(lo, 0)];
        return seg.time + (q - seg.quarters) * 60 / seg.bpm;
    }

    /** Called from the main rAF loop with the current chart time (s). */
    render(t) {
        const cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
        if (!cw || !ch) return; // panel hidden
        if (cw !== this.width || ch !== this.height) {
            this.width = cw;
            this.height = ch;
            const dpr = window.devicePixelRatio || 1;
            this.canvas.width = Math.round(cw * dpr);
            this.canvas.height = Math.round(ch * dpr);
            this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            this.dirty = true;
        }
        if (!this.chart) {
            if (!this.dirty) return;
            this.drawEmpty();
            this.dirty = false;
            return;
        }

        const colQ = this.columnQ();
        const qNow = this.quartersAt(Math.max(t, 0));
        const totalW = Math.ceil(this.totalQ / colQ) * COL_W;
        if (this.followEl.checked) {
            this.scrollX = (qNow / colQ) * COL_W - this.width * FOLLOW_ANCHOR_X;
        }
        this.scrollX = Math.min(Math.max(this.scrollX, 0), Math.max(totalW - this.width, 0));

        if (!this.dirty && t === this.lastTime) return;
        this.lastTime = t;
        this.dirty = false;

        const { ctx } = this;
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, this.width, this.height);

        const first = Math.floor(this.scrollX / COL_W);
        const last = Math.floor((this.scrollX + this.width) / COL_W);
        for (let col = first; col <= last; col++) {
            this.drawColumn(col * COL_W - this.scrollX, col * colQ, qNow);
        }

        // Column separators
        ctx.strokeStyle = COLORS.columnLine;
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let col = Math.max(first, 1); col <= last; col++) {
            const x = Math.round(col * COL_W - this.scrollX);
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.height);
        }
        ctx.stroke();

        if (this.hover) this.drawHover();
    }

    /** Crosshair + measure/time label under the pointer. */
    drawHover() {
        const { ctx } = this;
        const { x, y } = this.hover;
        const col = Math.floor((x + this.scrollX) / COL_W);
        if (col < 0) return;
        const q = col * this.columnQ() + (this.height - y) / this.pxPerQuarter;
        if (q < 0 || q > this.totalQ) return;
        const x0 = col * COL_W - this.scrollX;
        const ly = Math.round(y) + 0.5;

        ctx.save();
        ctx.strokeStyle = 'rgba(232, 234, 246, 0.55)';
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(x0, ly);
        ctx.lineTo(x0 + COL_W, ly);
        ctx.stroke();
        ctx.setLineDash([]);

        // Measure number at q (last measure start <= q)
        let lo = -1, hi = this.measures.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (this.measures[mid].q <= q) lo = mid;
            else hi = mid - 1;
        }
        const measureN = lo >= 0 ? this.measures[lo].n : 1;
        const tAudio = this.timeAt(q) + this.chart.meta.offsetMs / 1000;
        const label = `#${measureN} · ${formatTimeMs(tAudio)}`;

        ctx.font = '11px "Segoe UI", system-ui, sans-serif';
        const tw = ctx.measureText(label).width;
        const bx = Math.min(Math.max(x + 10, 2), this.width - tw - 12);
        const by = Math.max(y - 24, 2);
        ctx.fillStyle = 'rgba(22, 26, 48, 0.92)';
        ctx.strokeStyle = COLORS.columnLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(bx, by, tw + 10, 18);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#e8eaf6';
        ctx.fillText(label, bx + 5, by + 13);
        ctx.restore();
    }

    /** Render the whole strip (every column side by side) to a PNG blob. */
    exportPNG(scale = 2) {
        if (!this.chart || !this.height) return Promise.resolve(null);
        const colQ = this.columnQ();
        const cols = Math.max(Math.ceil(this.totalQ / colQ), 1);
        const fullW = cols * COL_W;

        const off = document.createElement('canvas');
        off.width = fullW * scale;
        off.height = this.height * scale;
        const offCtx = off.getContext('2d');
        offCtx.scale(scale, scale);

        // drawColumn reads ctx/width/scrollX/hover from the instance: swap them
        // in for the offscreen pass, then restore
        const saved = { ctx: this.ctx, width: this.width, scrollX: this.scrollX, hover: this.hover };
        this.ctx = offCtx;
        this.width = fullW;
        this.scrollX = 0;
        this.hover = null;

        offCtx.fillStyle = COLORS.background;
        offCtx.fillRect(0, 0, fullW, this.height);
        for (let col = 0; col < cols; col++) {
            this.drawColumn(col * COL_W, col * colQ, -1); // qNow -1: no playhead
        }
        offCtx.strokeStyle = COLORS.columnLine;
        offCtx.lineWidth = 2;
        offCtx.beginPath();
        for (let col = 1; col < cols; col++) {
            offCtx.moveTo(col * COL_W, 0);
            offCtx.lineTo(col * COL_W, this.height);
        }
        offCtx.stroke();

        this.ctx = saved.ctx;
        this.width = saved.width;
        this.scrollX = saved.scrollX;
        this.hover = saved.hover;

        return new Promise((resolve) => off.toBlob(resolve, 'image/png'));
    }

    drawEmpty() {
        const { ctx } = this;
        ctx.fillStyle = COLORS.background;
        ctx.fillRect(0, 0, this.width, this.height);
        ctx.fillStyle = COLORS.text;
        ctx.font = '12px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('No chart loaded', this.width / 2, this.height / 2);
        ctx.textAlign = 'left';
    }

    /** Draw the window [qb, qb + columnQ] into the x range [x0, x0 + COL_W]. */
    drawColumn(x0, qb, qNow) {
        const { ctx } = this;
        const h = this.height;
        const qt = qb + this.columnQ();
        const trackW = COL_W - 2 * GUTTER;
        const laneW = trackW / 4;
        const y = (q) => h - (q - qb) * this.pxPerQuarter;

        ctx.save();
        ctx.beginPath();
        ctx.rect(x0, 0, COL_W, h);
        ctx.clip();

        ctx.fillStyle = COLORS.track;
        ctx.fillRect(x0 + GUTTER, 0, trackW, h);

        this.drawLaneGrid(x0, trackW, laneW);

        // Beat grid
        ctx.strokeStyle = COLORS.beatLine;
        ctx.beginPath();
        for (let q = Math.max(Math.ceil(qb), 0); q <= qt; q++) {
            const ly = Math.round(y(q)) + 0.5;
            ctx.moveTo(x0 + GUTTER, ly);
            ctx.lineTo(x0 + GUTTER + trackW, ly);
        }
        ctx.stroke();

        // Measure lines + numbers
        ctx.strokeStyle = COLORS.measureLine;
        ctx.fillStyle = COLORS.text;
        ctx.font = '9px "Segoe UI", system-ui, sans-serif';
        ctx.beginPath();
        for (const m of this.measures) {
            if (m.q < qb - 1 || m.q > qt + 1) continue;
            const ly = Math.round(y(m.q)) + 0.5;
            ctx.moveTo(x0 + GUTTER, ly);
            ctx.lineTo(x0 + GUTTER + trackW, ly);
            ctx.fillText(String(m.n), x0 + 1, ly - 2);
        }
        ctx.stroke();

        // BPM changes (right gutter)
        ctx.fillStyle = COLORS.bpm;
        ctx.textAlign = 'right';
        for (const seg of this.timingQ) {
            if (seg.quarters < qb - 1 || seg.quarters > qt + 1) continue;
            ctx.fillText(String(Math.round(seg.bpm * 10) / 10), x0 + COL_W - 1, y(seg.quarters) - 2);
        }
        ctx.textAlign = 'left';

        this.drawColumnContent(x0, qb, qt, y, trackW, laneW);

        // Playhead
        if (qNow >= qb && qNow <= qt) {
            const ly = Math.round(y(qNow)) + 0.5;
            ctx.strokeStyle = COLORS.playhead;
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x0, ly);
            ctx.lineTo(x0 + COL_W, ly);
            ctx.stroke();
        }

        ctx.restore();
    }

    /** Vertical lane separators (4 BT lanes). */
    drawLaneGrid(x0, trackW, laneW) {
        const { ctx } = this;
        ctx.strokeStyle = COLORS.laneLine;
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let lane = 0; lane <= 4; lane++) {
            const x = Math.round(x0 + GUTTER + lane * laneW) + 0.5;
            ctx.moveTo(x, 0);
            ctx.lineTo(x, this.height);
        }
        ctx.stroke();
    }

    /** Column payload: holds, chips and lasers of the window. */
    drawColumnContent(x0, qb, qt, y, trackW, laneW) {
        const { ctx } = this;
        const laserX = (pos) => x0 + Math.min(Math.max(GUTTER + pos * trackW, 2), COL_W - 2);

        // Holds under chips, FX under BT
        ctx.fillStyle = COLORS.fxHold;
        for (const n of this.chart.fxNotes) {
            if (n.endQuarters <= n.quarters || n.endQuarters < qb || n.quarters > qt) continue;
            const x = x0 + GUTTER + n.lane * 2 * laneW;
            ctx.fillRect(x + 1, y(n.endQuarters), 2 * laneW - 2, (n.endQuarters - n.quarters) * this.pxPerQuarter);
        }
        ctx.fillStyle = COLORS.btHold;
        for (const n of this.chart.btNotes) {
            if (n.endQuarters <= n.quarters || n.endQuarters < qb || n.quarters > qt) continue;
            const x = x0 + GUTTER + n.lane * laneW;
            ctx.fillRect(x + 2, y(n.endQuarters), laneW - 4, (n.endQuarters - n.quarters) * this.pxPerQuarter);
        }
        ctx.fillStyle = COLORS.fxChip;
        for (const n of this.chart.fxNotes) {
            if (n.endQuarters > n.quarters || n.quarters < qb || n.quarters > qt) continue;
            const x = x0 + GUTTER + n.lane * 2 * laneW;
            ctx.fillRect(x + 1, y(n.quarters) - CHIP_H, 2 * laneW - 2, CHIP_H);
        }
        // BT chips slightly narrower than the lane so a simultaneous FX chip
        // (spanning two lanes) stays visible underneath
        ctx.fillStyle = COLORS.btChip;
        for (const n of this.chart.btNotes) {
            if (n.endQuarters > n.quarters || n.quarters < qb || n.quarters > qt) continue;
            const x = x0 + GUTTER + n.lane * laneW;
            ctx.fillRect(x + 3, y(n.quarters) - CHIP_H, laneW - 6, CHIP_H);
        }

        // Lasers (slam segments are near-horizontal by construction)
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        for (const section of this.chart.lasers) {
            const pts = section.points;
            if (pts[pts.length - 1].quarters < qb - 2 || pts[0].quarters > qt + 2) continue;
            ctx.strokeStyle = COLORS.laser[section.side];
            ctx.globalAlpha = 0.8;
            ctx.lineWidth = LASER_W;
            ctx.beginPath();
            ctx.moveTo(laserX(pts[0].pos), y(pts[0].quarters));
            for (let p = 1; p < pts.length; p++) {
                ctx.lineTo(laserX(pts[p].pos), y(pts[p].quarters));
            }
            ctx.stroke();
            ctx.globalAlpha = 1;
        }
    }
}

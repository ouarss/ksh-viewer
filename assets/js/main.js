/**
 * Viewer glue: song list, chart + audio loading, controls.
 */

import { parseKsh, bpmAt, measureAt, difficultyShortName } from './ksh-parser.js';
import { Viewer3D, DEFAULT_SPEED } from './viewer3d.js';
import { FlatView } from './flatview.js';
import { openStatsModal } from './stats.js';

const el = (id) => document.getElementById(id);

const canvas = el('viewer-canvas');
const viewer = new Viewer3D(canvas);

const seekToChartTime = (chartT) => {
    if (!audio || !chart) return;
    const target = chartT + chart.meta.offsetMs / 1000;
    audio.currentTime = Math.max(0, Math.min(audio.duration || 0, target));
};

const flatView = new FlatView(el('flat-canvas'), el('flat-follow'), seekToChartTime);

let audio = null;
let chart = null;
let seeking = false;

const songUrl = (folder, file) => `songs/${encodeURIComponent(folder)}/${encodeURIComponent(file)}`;

function formatTime(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
}

function chartTime() {
    if (!audio || !chart) return 0;
    return audio.currentTime - chart.meta.offsetMs / 1000;
}

// ---- Render loop ----

// HUD elements are cached and only written when the text actually changes
const hud = {
    bpm: el('hud-bpm'),
    measure: el('hud-measure'),
    time: el('hud-time'),
    fill: el('progress-fill'),
    lastBpm: '', lastMeasure: '', lastTime: '',
};

// FPS counter over the render loop, refreshed twice a second
let fpsFrames = 0;
let fpsLast = performance.now();

function tick() {
    fpsFrames++;
    const fpsNow = performance.now();
    if (fpsNow - fpsLast >= 500) {
        el('hud-fps').textContent = String(Math.round((fpsFrames * 1000) / (fpsNow - fpsLast)));
        fpsFrames = 0;
        fpsLast = fpsNow;
    }
    if (chart) {
        const t = chartTime();
        viewer.setTime(t);
        const bpm = String(Math.round(bpmAt(chart, Math.max(t, 0)) * 10) / 10);
        if (bpm !== hud.lastBpm) { hud.bpm.textContent = bpm; hud.lastBpm = bpm; }
        const meas = String(measureAt(chart, Math.max(t, 0)));
        if (meas !== hud.lastMeasure) { hud.measure.textContent = meas; hud.lastMeasure = meas; }
        if (audio) {
            const timeStr = `${formatTime(audio.currentTime)} / ${formatTime(audio.duration)}`
                + ` · ${audio.currentTime.toFixed(3)}s`;
            if (timeStr !== hud.lastTime) { hud.time.textContent = timeStr; hud.lastTime = timeStr; }
            if (!seeking && audio.duration) {
                hud.fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
            }
        }
    }
    runAssistTicks();
    drawDensityPlayhead();
    // Background video chases the audio clock (play state, rate, drift > 0.3 s)
    if (localVideoUrl && audio) {
        if (audio.paused !== bgVideo.paused && !bgVideo.ended) {
            if (audio.paused) bgVideo.pause();
            else bgVideo.play().catch(() => {});
        }
        if (bgVideo.playbackRate !== audio.playbackRate) {
            bgVideo.playbackRate = audio.playbackRate;
        }
        if (!bgVideo.ended && Math.abs(bgVideo.currentTime - audio.currentTime) > 0.3) {
            bgVideo.currentTime = audio.currentTime;
        }
    }
    flatView.render(chart ? chartTime() : 0);
    viewer.render();
    requestAnimationFrame(tick);
}

// ---- Chart loading ----

// Object URLs of the files picked in the local preview form, revoked on every reload
let localAudioUrl = null;
let localVideoUrl = null;
const bgVideo = el('bg-video');

function releaseVideo() {
    if (localVideoUrl) { URL.revokeObjectURL(localVideoUrl); localVideoUrl = null; }
    bgVideo.pause();
    bgVideo.removeAttribute('src');
    bgVideo.hidden = true;
    viewer.setVideoBackground(false);
    el('remove-video').hidden = true;
}

// Cover video behind the transparent stage, synced to the audio clock in
// tick(). Background only: always muted (the DOM property, not just the
// attribute — some browsers ignore the static attribute), never started on
// its own (the sync loop is the only thing that plays/pauses it).
function applyVideo(videoFile) {
    releaseVideo();
    localVideoUrl = URL.createObjectURL(videoFile);
    bgVideo.src = localVideoUrl;
    bgVideo.muted = true;
    bgVideo.hidden = false;
    viewer.setVideoBackground(true);
    el('remove-video').hidden = false;
}

function releaseAudio() {
    if (audio) { audio.pause(); audio = null; }
    if (localAudioUrl) { URL.revokeObjectURL(localAudioUrl); localAudioUrl = null; }
    releaseVideo();
}

function showError(message) {
    el('viewer-message').textContent = message;
    el('viewer-message').hidden = false;
}

// Shared by the server song list and the local preview form
function applyChart(parsedChart, audioSrc) {
    chart = parsedChart;

    audio = new Audio(audioSrc);
    audio.preload = 'auto';
    audio.addEventListener('ended', () => setPlayIcon(false));
    audio.addEventListener('error', () => showError('Audio file could not be decoded.'));
    audio.addEventListener('seeked', cancelScheduledTicks);
    audio.addEventListener('pause', cancelScheduledTicks);
    audio.addEventListener('loadedmetadata', refreshDensity);
    audio.playbackRate = parseFloat(el('rate').value);
    audio.volume = parseFloat(el('volume').value);

    buildTickTimes(chart);
    refreshDensity();

    viewer.loadChart(chart);
    flatView.setChart(chart);

    el('hud-title').textContent = chart.meta.title;
    el('hud-artist').textContent = chart.meta.artist;
    el('hud-diff').textContent = `${difficultyShortName(chart.meta.difficulty)} ${chart.meta.level}`;
    el('hud-diff').dataset.diff = chart.meta.difficulty;
    el('hud-effect').textContent = chart.meta.effect ? `EFFECT: ${chart.meta.effect}` : '';
    el('viewer-message').hidden = true;
    el('controls').classList.remove('is-disabled');
    setPlayIcon(false);

    document.querySelectorAll('.chart-btn.is-active').forEach((b) => b.classList.remove('is-active'));
}

async function loadChart(song, chartInfo) {
    releaseAudio();
    showError('Loading…');

    try {
        // no-store: regenerated charts must never be served from the
        // HTTP cache (stale versions survived even hard reloads)
        const resp = await fetch(songUrl(song.folder, chartInfo.file),
            { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status} on ${chartInfo.file}`);
        const parsed = parseKsh(await resp.text());

        applyChart(parsed, songUrl(song.folder, parsed.meta.audioFile));
        el(`chart-${song.folder}-${chartInfo.file}`)?.classList.add('is-active');
    } catch (err) {
        showError(`Loading error: ${err.message}`);
        console.error(err);
    }
}

// ---- Local preview (form in the top bar) ----
// Both files are read with the File API and never leave the browser.

const MAX_KSH_BYTES = 20 * 1024 * 1024;
const AUDIO_EXT = /\.(ogg|mp3|wav|m4a|flac)$/i;
const VIDEO_EXT = /\.(mp4|webm|mov|m4v)$/i;

const isVideoFile = (f) => f.type.startsWith('video/') || VIDEO_EXT.test(f.name);

async function loadLocalPreview(kshFile, audioFile) {
    releaseAudio();
    showError('Loading…');

    try {
        if (!kshFile.name.toLowerCase().endsWith('.ksh')) {
            throw new Error('The chart file must be a .ksh');
        }
        if (kshFile.size > MAX_KSH_BYTES) {
            throw new Error('Chart file too large (20 MB max)');
        }
        if (!audioFile.type.startsWith('audio/') && !AUDIO_EXT.test(audioFile.name)) {
            throw new Error('Unsupported audio file (ogg, mp3, wav, m4a, flac)');
        }

        const parsed = parseKsh(await kshFile.text());
        if (!parsed.measures.length) {
            throw new Error('Not a valid KSH chart (no measures found)');
        }
        // The m= audio reference in the header is ignored: the picked file wins
        localAudioUrl = URL.createObjectURL(audioFile);
        applyChart(parsed, localAudioUrl);
        if (!parsed.meta.title) el('hud-title').textContent = kshFile.name;
    } catch (err) {
        showError(`Loading error: ${err.message}`);
        console.error(err);
    }
}

el('local-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const kshFile = el('local-ksh').files[0];
    const audioFile = el('local-audio').files[0];
    if (!kshFile || !audioFile) {
        showError('Pick both an audio file and a .ksh chart first.');
        return;
    }
    closePopovers();
    loadLocalPreview(kshFile, audioFile);
});

// Video popover: the picker applies to the loaded chart as soon as a file is
// chosen (one-shot input — the active state is the "Remove video" button)
el('local-video').addEventListener('change', () => {
    const videoFile = el('local-video').files[0];
    el('local-video').value = '';
    if (!videoFile) return;
    if (!chart) {
        showError('Load a chart first — the video attaches to it.');
        return;
    }
    if (!isVideoFile(videoFile)) {
        showError('Unsupported video file (mp4, webm, mov, m4v)');
        return;
    }
    closePopovers();
    applyVideo(videoFile);
});

el('remove-video').addEventListener('click', () => {
    releaseVideo();
    closePopovers();
});

// ---- Popovers (Load…, Settings) ----

function closePopovers() {
    document.querySelectorAll('.popover').forEach((p) => { p.hidden = true; });
    document.querySelectorAll('[aria-haspopup="true"]')
        .forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

function bindPopover(buttonId, popoverId) {
    const btn = el(buttonId), pop = el(popoverId);
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const show = pop.hidden;
        closePopovers();
        pop.hidden = !show;
        btn.setAttribute('aria-expanded', String(show));
    });
    pop.addEventListener('click', (e) => e.stopPropagation());
}

bindPopover('open-load', 'load-popover');
bindPopover('open-video', 'video-popover');
bindPopover('open-settings', 'settings-popover');
document.addEventListener('click', closePopovers);

el('browse-songs').addEventListener('click', () => {
    closePopovers();
    el('sidebar').classList.add('is-open');
    viewer.resize();
});

// ---- Side panel toggles ----

function bindToggle(buttonId, panelId) {
    el(buttonId).addEventListener('click', () => {
        const open = el(panelId).classList.toggle('is-open');
        el(buttonId).setAttribute('aria-expanded', String(open));
        viewer.resize();
    });
}

bindToggle('toggle-flat', 'flatpanel');

function closeSidebar() {
    el('sidebar').classList.remove('is-open');
    viewer.resize();
}

el('close-sidebar').addEventListener('click', closeSidebar);

// The error/loading overlay stays up until dismissed — a click hides it
el('viewer-message').addEventListener('click', () => {
    el('viewer-message').hidden = true;
});

// ---- Panel resize (drag the left edge; more width = more columns) ----

function bindPanelResize(panelId, resizerId, storageKey) {
    const panel = el(panelId);
    const resizer = el(resizerId);
    const savedWidth = parseInt(localStorage.getItem(storageKey), 10);
    if (savedWidth >= 220) panel.style.width = `${savedWidth}px`;

    resizer.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        resizer.setPointerCapture(e.pointerId);
        const startX = e.clientX;
        const startW = panel.offsetWidth;
        const move = (ev) => {
            const w = Math.min(Math.max(startW + (startX - ev.clientX), 220),
                Math.round(window.innerWidth * 0.75));
            panel.style.width = `${w}px`;
            viewer.resize();
        };
        const up = () => {
            resizer.removeEventListener('pointermove', move);
            resizer.removeEventListener('pointerup', up);
            localStorage.setItem(storageKey, String(panel.offsetWidth));
        };
        resizer.addEventListener('pointermove', move);
        resizer.addEventListener('pointerup', up);
    });
}

bindPanelResize('flatpanel', 'flat-resizer', 'viewer-flat-width');

// ---- Song list ----

// Song list sources, in order: songs.php scans songs/ live, but a static host
// (GitHub Pages, python -m http.server) has no PHP and either 404s or serves the
// source as text — both end up here as a failed fetch or a failed JSON parse, so
// we fall back to songs.json (regenerate it with `php songs.php > songs.json`).
async function fetchSongList() {
    let lastError = null;
    for (const url of ['songs.php', 'songs.json']) {
        try {
            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            return await resp.json();
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error('no song list available');
}

let serverSongs = [];
let localSongs = [];

// One sidebar entry; local songs carry File objects instead of URLs
function makeSongItem(song, isLocal) {
    const item = document.createElement('div');
    item.className = 'song-item';

    const jacket = document.createElement('div');
    jacket.className = 'song-jacket';
    const jacketSrc = isLocal
        ? (song.jacketFile ? URL.createObjectURL(song.jacketFile) : null)
        : (song.jacket ? songUrl(song.folder, song.jacket) : null);
    if (jacketSrc) {
        const img = document.createElement('img');
        img.src = jacketSrc;
        img.alt = '';
        img.loading = 'lazy';
        jacket.appendChild(img);
    }
    item.appendChild(jacket);

    const info = document.createElement('div');
    info.className = 'song-info';
    const title = document.createElement('div');
    title.className = 'song-title';
    title.textContent = song.title;
    const artist = document.createElement('div');
    artist.className = 'song-artist';
    artist.textContent = song.artist;
    const charts = document.createElement('div');
    charts.className = 'song-charts';
    for (const c of song.charts) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chart-btn';
        btn.id = `chart-${isLocal ? 'local-' : ''}${song.folder}-${c.file}`;
        btn.dataset.diff = c.difficulty;
        btn.textContent = `${difficultyShortName(c.difficulty)} ${c.level}`;
        btn.addEventListener('click', () => {
            if (isLocal) loadLocalChart(song, c);
            else loadChart(song, c);
            closeSidebar();
        });
        charts.appendChild(btn);
    }
    info.append(title, artist, charts);
    item.appendChild(info);
    return item;
}

function renderSongList() {
    const list = el('song-list');
    list.textContent = '';
    for (const song of serverSongs) list.appendChild(makeSongItem(song, false));
    if (localSongs.length) {
        const divider = document.createElement('div');
        divider.className = 'song-list-divider';
        divider.textContent = 'Local folder';
        list.appendChild(divider);
        for (const song of localSongs) list.appendChild(makeSongItem(song, true));
    }
    if (!serverSongs.length && !localSongs.length) {
        list.textContent = 'No songs in songs/.';
    }
}

async function loadSongList() {
    const list = el('song-list');
    try {
        serverSongs = await fetchSongList();
        renderSongList();

        // Deep link: ?song=<folder>&chart=<file> auto-loads a chart.
        // Values are only matched against the fetched list, never used as paths.
        const params = new URLSearchParams(location.search);
        const wantSong = params.get('song');
        if (wantSong) {
            const song = serverSongs.find((s) => s.folder === wantSong);
            const chartInfo = song && (song.charts.find((c) => c.file === params.get('chart'))
                || song.charts[song.charts.length - 1]);
            if (chartInfo) loadChart(song, chartInfo);
        }
    } catch (err) {
        list.textContent = `Could not list songs (songs.php / songs.json): ${err.message}`;
        console.error(err);
    }
}

// ---- Local songs folder (Load… popover) ----
// webkitdirectory hands over every file with its relative path; any directory
// that directly contains .ksh files is a song (one .ksh = one difficulty).
// Only chart headers are read up front — audio stays untouched until a chart
// is actually loaded, so picking a big library is cheap.

function parseKshHeaderOnly(text) {
    const meta = { title: '', artist: '', difficulty: '', level: 0, audioFile: '', jacket: '' };
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.replace(/^\uFEFF/, '');
        if (line.startsWith('--')) break;
        const eq = line.indexOf('=');
        if (eq < 0) continue;
        const key = line.slice(0, eq);
        const value = line.slice(eq + 1).trim();
        if (key === 'title') meta.title = value;
        else if (key === 'artist') meta.artist = value;
        else if (key === 'difficulty') meta.difficulty = value;
        else if (key === 'level') meta.level = parseInt(value, 10) || 0;
        else if (key === 'm') meta.audioFile = value.split(';')[0].trim();
        else if (key === 'jacket') meta.jacket = value;
    }
    return meta;
}

async function buildLocalLibrary(files) {
    const byDir = new Map();
    for (const f of files) {
        const path = f.webkitRelativePath || f.name;
        const dir = path.slice(0, path.lastIndexOf('/'));
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir).push(f);
    }

    const songs = [];
    for (const [dir, dirFiles] of byDir) {
        const kshFiles = dirFiles.filter((f) => f.name.toLowerCase().endsWith('.ksh')
            && f.size <= MAX_KSH_BYTES);
        if (!kshFiles.length) continue;

        const charts = [];
        let songMeta = null;
        for (const kshFile of kshFiles) {
            try {
                const meta = parseKshHeaderOnly(await kshFile.text());
                songMeta = songMeta || meta;
                charts.push({
                    file: kshFile.name,
                    difficulty: meta.difficulty,
                    level: meta.level,
                    kshFile,
                    dirFiles,
                });
            } catch (err) {
                console.error(`Unreadable chart skipped: ${dir}/${kshFile.name}`, err);
            }
        }
        if (!charts.length) continue;

        charts.sort((a, b) => a.level - b.level);
        const folderName = dir.slice(dir.lastIndexOf('/') + 1);
        songs.push({
            folder: folderName || dir,
            title: songMeta.title || folderName,
            artist: songMeta.artist,
            jacketFile: songMeta.jacket
                ? dirFiles.find((f) => f.name === songMeta.jacket) || null
                : null,
            charts,
        });
    }
    songs.sort((a, b) => a.title.localeCompare(b.title));
    return songs;
}

async function loadLocalChart(song, chartInfo) {
    releaseAudio();
    showError('Loading…');

    try {
        const parsed = parseKsh(await chartInfo.kshFile.text());
        if (!parsed.measures.length) {
            throw new Error('Not a valid KSH chart (no measures found)');
        }
        const wanted = (parsed.meta.audioFile || '').toLowerCase();
        const audioFile = chartInfo.dirFiles.find((f) => f.name.toLowerCase() === wanted)
            || chartInfo.dirFiles.find((f) => AUDIO_EXT.test(f.name));
        if (!audioFile) {
            throw new Error(`No audio file found next to ${chartInfo.file}`);
        }
        localAudioUrl = URL.createObjectURL(audioFile);
        applyChart(parsed, localAudioUrl);
        el(`chart-local-${song.folder}-${chartInfo.file}`)?.classList.add('is-active');
    } catch (err) {
        showError(`Loading error: ${err.message}`);
        console.error(err);
    }
}

el('pick-folder').addEventListener('click', () => el('local-folder').click());
el('local-folder').addEventListener('change', async () => {
    const files = Array.from(el('local-folder').files);
    el('local-folder').value = '';
    if (!files.length) return;
    localSongs = await buildLocalLibrary(files);
    renderSongList();
    closePopovers();
    el('sidebar').classList.add('is-open');
    if (!localSongs.length) {
        showError('No .ksh chart found in the picked folder.');
    }
});

// ---- Controls ----

function setPlayIcon(playing) {
    el('play').textContent = playing ? 'Pause' : 'Play';
}

function togglePlay() {
    if (!audio) return;
    if (audio.paused) {
        if (assistOn) ensureAudioCtx(); // play click is a user gesture
        audio.play();
        setPlayIcon(true);
    } else {
        audio.pause();
        setPlayIcon(false);
    }
}

el('play').addEventListener('click', togglePlay);

// Progress bar: wide, precise, hover shows seconds + measure; click/drag seeks
const progress = el('progress');
const progressTip = el('progress-tip');

// Shared with the density canvas below the bar: the tip is positioned along
// the bar from a 0-1 fraction, whatever element the pointer is over.
function showSeekTip(frac) {
    if (!audio || !audio.duration || !chart) { progressTip.hidden = true; return; }
    const t = frac * audio.duration;
    const meas = measureAt(chart, Math.max(t - chart.meta.offsetMs / 1000, 0));
    progressTip.textContent = `${t.toFixed(2)}s · M${meas}`;
    progressTip.style.left = `${frac * progress.getBoundingClientRect().width}px`;
    progressTip.hidden = false;
}

function barFrac(e) {
    const rect = progress.getBoundingClientRect();
    return Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
}

function seekToFrac(frac) {
    audio.currentTime = frac * audio.duration;
    hud.fill.style.width = `${frac * 100}%`;
}

let barDrag = false;
progress.addEventListener('pointerdown', (e) => {
    if (!audio || !audio.duration) return;
    barDrag = true;
    seeking = true;
    progress.setPointerCapture(e.pointerId);
    seekToFrac(barFrac(e));
    showSeekTip(barFrac(e));
});
progress.addEventListener('pointermove', (e) => {
    showSeekTip(barFrac(e));
    if (barDrag && audio && audio.duration) seekToFrac(barFrac(e));
});
progress.addEventListener('pointerup', () => { barDrag = false; seeking = false; });
progress.addEventListener('pointerleave', () => {
    if (!barDrag) progressTip.hidden = true;
});

function applySpeed(value) {
    const input = el('speed');
    const clamped = Math.min(Math.max(value, parseFloat(input.min)), parseFloat(input.max));
    input.value = String(clamped);
    viewer.setSpeed(clamped);
}

el('speed').addEventListener('change', () => {
    const value = parseFloat(el('speed').value);
    applySpeed(isFinite(value) ? value : viewer.speed);
});

function applyRate() {
    const rate = parseFloat(el('rate').value);
    el('rate-value').textContent = `${rate.toFixed(2)}×`;
    if (audio) audio.playbackRate = rate;
}

el('rate').addEventListener('input', applyRate);

el('volume').addEventListener('input', () => {
    if (audio) audio.volume = parseFloat(el('volume').value);
    localStorage.setItem('viewer-volume', el('volume').value);
});
const savedVolume = localStorage.getItem('viewer-volume');
if (savedVolume !== null) el('volume').value = savedVolume;

// Camera FX On/Off toggle button
function setEffectsEnabled(on) {
    el('effects').setAttribute('aria-pressed', String(on));
    el('effects').textContent = on ? 'On' : 'Off';
    viewer.setEffectsEnabled(on);
}

el('effects').addEventListener('click', () => {
    setEffectsEnabled(el('effects').getAttribute('aria-pressed') !== 'true');
});

// The reset button floats bottom-left of the stage, only while the camera
// has been moved away from its default orbit
el('camera-reset').addEventListener('click', () => {
    viewer.resetCamera();
    el('camera-reset').hidden = true;
});

el('fullscreen').addEventListener('click', () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen();
});
document.addEventListener('fullscreenchange', () => {
    el('fullscreen').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
    viewer.resize();
});

el('hud-toggle').addEventListener('click', () => {
    const on = el('hud-toggle').getAttribute('aria-pressed') !== 'true';
    el('hud-toggle').setAttribute('aria-pressed', String(on));
    el('hud-toggle').textContent = on ? 'On' : 'Off';
    document.querySelector('.hud').hidden = !on;
});

document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePopovers(); hideStats(); return; }
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
    else if (e.code === 'ArrowLeft' && audio) audio.currentTime = Math.max(0, audio.currentTime - 5);
    else if (e.code === 'ArrowRight' && audio) audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 5);
    else if (e.code === 'ArrowUp') { e.preventDefault(); applySpeed(viewer.speed + 10); }
    else if (e.code === 'ArrowDown') { e.preventDefault(); applySpeed(viewer.speed - 10); }
});

// Mouse drag orbits the camera, wheel zooms
let dragging = false, lastX = 0, lastY = 0;
canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    viewer.orbit((e.clientY - lastY) * 0.004, (e.clientX - lastX) * -0.004);
    lastX = e.clientX; lastY = e.clientY;
    el('camera-reset').hidden = false;
});
canvas.addEventListener('pointerup', () => { dragging = false; });
canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    viewer.zoom(e.deltaY * 0.004);
    el('camera-reset').hidden = false;
}, { passive: false });

window.addEventListener('resize', () => viewer.resize());

// ---- Assist tick (Settings option): a click on every BT/FX note ----
// Ticks are scheduled ~150 ms ahead on the WebAudio clock for precise timing;
// scheduled sources are cancelled on pause/seek ('seeked'/'pause' listeners).

let assistOn = false;
let audioCtx = null;
let tickTimes = [];   // {time, fx} chart-time note starts, deduped per instant
let tickIdx = 0;
let lastAssistT = -Infinity;
const scheduledTicks = [];

function buildTickTimes(loadedChart) {
    const byTime = new Map();
    for (const n of loadedChart.btNotes) {
        byTime.set(Math.round(n.time * 1000), false);
    }
    for (const n of loadedChart.fxNotes) {
        const key = Math.round(n.time * 1000);
        if (!byTime.has(key)) byTime.set(key, true); // BT tone wins on chords
    }
    tickTimes = [...byTime.entries()]
        .map(([ms, fx]) => ({ time: ms / 1000, fx }))
        .sort((a, b) => a.time - b.time);
    tickIdx = 0;
    lastAssistT = -Infinity;
}

function ensureAudioCtx() {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
}

function cancelScheduledTicks() {
    for (const src of scheduledTicks) {
        try { src.stop(); } catch { /* already ended */ }
    }
    scheduledTicks.length = 0;
    lastAssistT = -Infinity; // forces the index to re-seek on the next frame
}

function scheduleTick(atCtxTime, isFx) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = isFx ? 880 : 1760;
    gain.gain.setValueAtTime(0.1, atCtxTime);
    gain.gain.exponentialRampToValueAtTime(0.001, atCtxTime + 0.03);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(atCtxTime);
    osc.stop(atCtxTime + 0.035);
    scheduledTicks.push(osc);
    if (scheduledTicks.length > 64) scheduledTicks.splice(0, 32);
}

function runAssistTicks() {
    if (!assistOn || !audioCtx || !audio || !chart || audio.paused) return;
    const t = chartTime();
    if (t < lastAssistT) {
        // Seek backwards: binary search the first note at or after t
        let lo = 0, hi = tickTimes.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (tickTimes[mid].time < t) lo = mid + 1;
            else hi = mid;
        }
        tickIdx = lo;
    }
    lastAssistT = t;
    const horizon = t + 0.15 * audio.playbackRate;
    while (tickIdx < tickTimes.length && tickTimes[tickIdx].time <= horizon) {
        const note = tickTimes[tickIdx];
        if (note.time >= t - 0.02) {
            const at = audioCtx.currentTime + Math.max(note.time - t, 0) / audio.playbackRate;
            scheduleTick(at, note.fx);
        }
        tickIdx++;
    }
}

function setAssistTick(on) {
    assistOn = on;
    el('assist-tick').setAttribute('aria-pressed', String(on));
    el('assist-tick').textContent = on ? 'On' : 'Off';
    localStorage.setItem('viewer-assist-tick', on ? '1' : '0');
    if (on) ensureAudioCtx(); // toggle click is a user gesture
    else cancelScheduledTicks();
}

el('assist-tick').addEventListener('click', () => setAssistTick(!assistOn));

// ---- Density bar under the seek bar (Settings option) ----
// Sequential single-hue bars (accent), notes/s over the audio timeline.

const densityCanvas = el('density');
let densityOn = false;
let densityBins = [];
let densityDuration = 0;
let densityPlayheadPx = -1;

function audioDurationEstimate() {
    if (audio && audio.duration) return audio.duration;
    if (!chart) return 0;
    let end = 0;
    for (const n of chart.btNotes) end = Math.max(end, n.endTime);
    for (const n of chart.fxNotes) end = Math.max(end, n.endTime);
    return end + chart.meta.offsetMs / 1000;
}

function refreshDensity() {
    if (!densityOn || !chart) return;
    densityDuration = audioDurationEstimate();
    const w = densityCanvas.clientWidth;
    if (!densityDuration || !w) return;
    const binCount = Math.max(Math.floor(w / 3), 10);
    densityBins = new Array(binCount).fill(0);
    const offset = chart.meta.offsetMs / 1000;
    for (const notes of [chart.btNotes, chart.fxNotes]) {
        for (const n of notes) {
            const bin = Math.floor(((n.time + offset) / densityDuration) * binCount);
            if (bin >= 0 && bin < binCount) densityBins[bin]++;
        }
    }
    densityPlayheadPx = -1;
    drawDensity();
}

function drawDensity() {
    const w = densityCanvas.clientWidth, h = densityCanvas.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (densityCanvas.width !== Math.round(w * dpr)) {
        densityCanvas.width = Math.round(w * dpr);
        densityCanvas.height = Math.round(h * dpr);
    }
    const ctx = densityCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const max = Math.max(...densityBins, 1);
    const binW = w / densityBins.length;
    ctx.fillStyle = '#5560ff';
    for (let i = 0; i < densityBins.length; i++) {
        if (!densityBins[i]) continue;
        const bh = Math.max((densityBins[i] / max) * (h - 2), 1);
        ctx.fillRect(i * binW, h - bh, Math.max(binW - 1, 1), bh);
    }

    if (densityPlayheadPx >= 0) {
        ctx.fillStyle = '#e8eaf6';
        ctx.fillRect(densityPlayheadPx, 0, 1.5, h);
    }
}

function drawDensityPlayhead() {
    if (!densityOn || !audio || !audio.duration || densityCanvas.hidden) return;
    const px = Math.round((audio.currentTime / audio.duration) * densityCanvas.clientWidth);
    if (px === densityPlayheadPx) return;
    densityPlayheadPx = px;
    drawDensity();
}

function setDensityEnabled(on) {
    densityOn = on;
    el('density-toggle').setAttribute('aria-pressed', String(on));
    el('density-toggle').textContent = on ? 'On' : 'Off';
    densityCanvas.hidden = !on;
    localStorage.setItem('viewer-density', on ? '1' : '0');
    if (on) requestAnimationFrame(refreshDensity); // wait for layout
}

el('density-toggle').addEventListener('click', () => setDensityEnabled(!densityOn));
window.addEventListener('resize', () => refreshDensity());

densityCanvas.addEventListener('mousemove', (e) => {
    const rect = densityCanvas.getBoundingClientRect();
    showSeekTip(Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1));
});
densityCanvas.addEventListener('mouseleave', () => { progressTip.hidden = true; });
densityCanvas.addEventListener('click', (e) => {
    if (!audio || !audio.duration) return;
    const rect = densityCanvas.getBoundingClientRect();
    const frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
    audio.currentTime = frac * audio.duration;
});

// ---- Chart stats modal (computation + charts live in stats.js) ----

function hideStats() {
    el('stats-modal').hidden = true;
}

el('open-stats').addEventListener('click', () => {
    if (chart) openStatsModal(chart);
});
el('close-stats').addEventListener('click', hideStats);
el('stats-modal').addEventListener('click', (e) => {
    if (e.target === el('stats-modal')) hideStats();
});

// ---- Flat 2D vertical zoom (px per beat, persisted) ----

const savedFlatZoom = parseInt(localStorage.getItem('viewer-flat-zoom'), 10);
if (savedFlatZoom) {
    el('flat-zoom').value = String(savedFlatZoom);
    flatView.setZoom(savedFlatZoom);
}

el('flat-zoom').addEventListener('input', () => {
    const zoom = parseInt(el('flat-zoom').value, 10);
    flatView.setZoom(zoom);
    localStorage.setItem('viewer-flat-zoom', String(zoom));
});

// ---- Flat 2D strip PNG export ----

el('export-png').addEventListener('click', async () => {
    const blob = await flatView.exportPNG();
    if (!blob) return;
    const name = chart
        ? `${chart.meta.title} ${difficultyShortName(chart.meta.difficulty)}.png`
        : 'chart.png';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name.replace(/[\\/:*?"<>|]+/g, '_');
    a.click();
    URL.revokeObjectURL(url);
});

// ---- Startup ----

// Defaults are enforced here: browsers may restore previous form values on reload
applySpeed(DEFAULT_SPEED);
el('rate').value = '1';
applyRate();
el('flat-follow').checked = true;
setEffectsEnabled(true);
// Persisted opt-ins (AudioContext creation waits for a user gesture)
assistOn = localStorage.getItem('viewer-assist-tick') === '1';
el('assist-tick').setAttribute('aria-pressed', String(assistOn));
el('assist-tick').textContent = assistOn ? 'On' : 'Off';
setDensityEnabled(localStorage.getItem('viewer-density') !== '0');
loadSongList();
requestAnimationFrame(tick);

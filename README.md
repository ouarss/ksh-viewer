# KSH Viewer — web-based 3D chart viewer

Standalone web viewer for the game's KShootMania charts (`.ksh`): it renders the
3D note highway (BT, FX, lasers) synchronized with the music, camera effects
included, like the actual game.

**Live demo**: https://ouarss.github.io/ksh-viewer/ (auto-deployed from `main`
by GitHub Actions — see `.github/workflows/pages.yml`).

**Run locally**: any web server will do, e.g. `php -S 127.0.0.1:8000` or
`python -m http.server 8000` from this folder, then open `http://127.0.0.1:8000/`.
A server is required because ES modules do not load over `file://`, but **PHP is
optional**: it only powers `songs.php`, which scans `songs/` live. Without PHP the
viewer falls back to `songs.json`, so it also runs on any static host.

Drop a song in `songs/` and `songs.php` picks it up on its own. Only the static
list needs a refresh, with `php songs.php > songs.json`.

## Structure

| File | Purpose |
|---|---|
| `index.html` | Single page (top bar + song list + 3D stage + controls) |
| `songs.php` | Scans `songs/` and returns the song/difficulty list as JSON |
| `songs.json` | Same list, pre-generated for static hosts (see below) |
| `.htaccess` | Hardening: no directory listing, `*.md` and dotfiles blocked |
| `assets/js/ksh-parser.js` | `.ksh` parser: header, BT/FX notes, lasers, timing (variable BPM, time signatures), camera effect curves, spins, stops |
| `assets/js/viewer3d.js` | Three.js scene: track, instanced notes, laser ribbons, scrolling, camera effect engine |
| `assets/js/flatview.js` | Flat 2D chart panel: editor-style vertical view on a canvas, synced to playback |
| `assets/js/stats.js` | Stats modal: figures + canvas charts (radar, NPS, BPM, hands, lanes, lasers, snap) |
| `assets/js/main.js` | Glue: song list, audio, HUD, keyboard/mouse controls |
| `assets/css/viewer.css` | Dark theme |
| `lib/three.module.js` | Vendored Three.js r160 (no network dependency) |
| `songs/` | Sample songs (one folder = one song, one `.ksh` = one difficulty) |

## UI layout

Top bar: **Load…** (popover with the local preview form, a local songs-folder
picker and a shortcut to the songs sidebar, which closes via its own **Close**
button) and **Video**
(popover managing the background video) on the left; **Settings** (popover)
and **Chart 2D** pinned top right.
Bottom bar: **Play** and **Stats** on the left, the precise seek bar filling
the rest. Settings and Chart 2D stay usable before any chart is loaded;
popovers close on outside click or Escape. On narrow screens the bars wrap,
the side panels are width-capped and the seek bar gets its own full-width row.

Floating on the stage: **Reset camera** (bottom left, appears only once the
camera has been orbited/zoomed away from its default) and **Fullscreen**
(bottom right, toggles browser fullscreen).

Settings options: approach speed (default 700), volume, playback rate,
Camera FX On/Off, HUD info On/Off (the top-left/top-right overlays), plus two
persisted toggles — **Assist tick** (opt-in: a WebAudio click on every BT/FX
note, higher pitch for BT, scheduled ahead on the audio clock for precise
timing) and **Density bar** (on by default: notes/s histogram under the seek
bar, clickable, with the same precise tooltip and a playhead cursor).

**Stats** opens a modal with the chart's figures (note counts by type, laser
sections, slams, spins, BPM range, average and peak NPS with its measure) and
seven charts: an approximated SDVX-style profile radar (notes / peak /
tsumami / one-hand / hand-trip / tricky, each vertex labeled with its real
figure), notes/s over time (labeled y grid, dashed average, time + measure
x references), BPM timeline (plateaus labeled, soflan at a glance), hand
balance over time (left hand = A/B/FX-L vs right hand), notes per lane,
laser coverage per side, and note-spacing (snap) distribution with the
"other" bucket itemized as whole-note fractions (e.g. `3/16 ×42`).

## On-the-fly preview (local files)

The **Load…** popover holds a form with an audio file (ogg/mp3/wav/m4a/flac)
and a `.ksh` chart. **Preview** loads both directly in the browser (File API
/ object URLs) — nothing is uploaded to the server. In this mode the `m=`
audio reference of the KSH header is ignored: the picked audio file wins.

## Local songs folder

The same popover can also load a whole library: **Pick a songs/ folder**
opens a directory picker (`webkitdirectory` — Chrome, Edge and Firefox).
Every subfolder that directly contains `.ksh` files becomes a song in the
sidebar list (several `.ksh` = several difficulties, sorted by level), under
a "Local folder" divider. Only chart headers are read up front; the audio
(matched by the `m=` header reference, else the first audio file of the
folder) and the jacket are read when a chart is actually loaded. Everything
stays in the browser.

## Background video

The **Video** popover attaches a video (mp4/webm/mov/m4v) to whatever chart
is currently loaded (local or from the songs sidebar) — applied as soon as
the file is picked, removable with its **Remove video** button (shown only
while one is active). Background only: muted (DOM property enforced), never
interactive (no controls, `pointer-events: none`, PiP disabled), centered
cover behind the transparent 3D stage, dimmed for readability, and driven
exclusively by the audio clock (play/pause/rate/seeks). Loading another
chart drops it.

## Flat 2D chart view (right panel)

The **Chart 2D** button toggles a right-side panel with a chartlab-style flat
view of the loaded chart: time flows bottom → top within a fixed-height
column (the panel height), then continues in the next column to the right —
the strip of columns scrolls horizontally. Layout is in beats (constant
measure height regardless of BPM), with measure numbers, beat grid, BT/FX
chips and holds, lasers (slams included) and BPM change labels.

The scroll is internal and virtualized (only the visible columns are drawn),
so chart length is unlimited. While **Follow** is checked (default, re-forced
on every startup) the strip scrolls right to keep the playhead anchored near
the left edge; wheel or drag detaches the follow, a click seeks the audio to
that point. Hovering shows a crosshair with the exact measure and audio time
(ms precision); the same precise `time · #measure` tooltip appears over the
bottom seek bar, on hover and while dragging it.

The panel is resizable: drag its left edge (width persisted); more width
simply fits more columns. The **Zoom** slider sets the vertical scale
(pixels per beat, persisted) — left shows more measures per column, right
fewer but bigger. The **PNG** button exports the whole strip (every column
side by side, 2× resolution) as a PNG download.

## Deep link

`?song=<folder>&chart=<file>` auto-loads a chart on startup, e.g.
`index.html?song=song-1&chart=nov.ksh` (omitting `chart` picks the
highest difficulty). Values are matched against the song list, never used as paths.

## Adding a song

Copy a song folder into `songs/<name>/` with, per difficulty: the
`.ksh`, the audio file referenced by its `m=` key (ogg/mp3) and the jacket
(`jacket=`). The folder shows up automatically in the list (scanned by
`songs.php`, nothing to declare).

## Controls

- **Space**: play / pause — **←/→**: ±5 s — **↑/↓**: approach speed ±10
- **Drag on the stage**: orbit camera — **wheel**: zoom — *Camera* button: reset
- **Approach speed**: the in-game 3-4 digit number (~BPM × hispeed); on-screen
  scroll speed is constant regardless of the current BPM
- **Playback**: 0.5× / 0.75× audio to study a passage
- **Camera FX**: toggles the chart's camera effects (zoom, tilt, spins, split)

## KSH format — what is implemented

- `key=value` header up to the first `--`: `title`, `artist`, `difficulty`,
  `level`, `t` (BPM, possibly a "189-216" range), `m` (audio), `o` (offset ms,
  chart start position within the audio), `jacket`…
- Body split into measures by `--`; a measure's time resolution = its line
  count. Chart line: `BBBB|FF|LL`.
- BT: `0` none, `1` chip, `2` hold. FX: `0` none, `2` chip, other char = hold.
- Lasers: `-` none, `:` interpolation, otherwise base-51 position (`0-9A-Za-o`);
  `laserrange_l/r=2x` widens the range to [-0.5, 1.5]; two points at most 1/32
  of a whole note apart = slam (rendered horizontally). Entry/exit tails with a
  big L/R marker show where each laser section starts.
- Body changes: `t=` (BPM) and `beat=n/d` (time signature) are applied.
- **Camera effects** (formulas ported from the reference implementation):
  `zoom_bottom` (highway distance),
  `zoom_top` (pitch), `zoom_side` (X offset), `tilt` (manual roll + automatic
  laser-following roll with `normal`/`bigger`/`biggest`/`zero`/`keep_*`
  intensities), spins `@( @) @< @>` and lateral bounce `S< S>` on slams,
  `center_split` (track halves pushed apart), `stop` (frozen scroll), plus a
  camera shake on each laser slam.

## Known limitations (v2 ideas)

- `lane_toggle` (track fade-out) is not handled.
- Spin background rotation is not rendered (no chart background layer).
- FX hold audio effects are not simulated (the original audio file is played).
- The zoom_bottom translation magnitude is an approximation (the viewer's
  world scale differs from the game's; see `ZOOM_SCALE` in viewer3d.js).

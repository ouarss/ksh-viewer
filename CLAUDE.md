# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## KSH Viewer

Standalone web-based 3D viewer for KShootMania `.ksh` charts (Three.js). No build step, no package manager — Three.js r160 is vendored in `lib/three.module.js`.

**Run**: needs a web server, ES modules do not load over `file://` — e.g. `php -S 127.0.0.1:8000` or `python -m http.server 8000` from this folder (note: `.htaccess` rules apply to neither). PHP is optional: it only powers `songs.php`; without it the song list falls back to `songs.json`.

**Checks**: no test suite — verify by loading a chart in the browser; run `php -l songs.php` after PHP edits.

## Architecture (data flow)

Two chart sources converge on one shared path (`applyChart()` in `main.js`):

1. **Server songs** — `songs.php` (the only server-side code) scans `songs/` (one folder = one song, one `.ksh` = one difficulty), parses KSH headers, returns JSON; `main.js` renders the sidebar list and fetches the chosen `.ksh` + audio from `songs/`. On a host without PHP, `fetchSongList()` falls back to the pre-generated `songs.json`. Adding a song locally needs nothing (`songs.php` scans live); only the static list needs `php songs.php > songs.json`.
2. **Local preview** — the top-bar **Load…** popover loads an audio file + `.ksh` (+ optional background video, cover behind the transparent 3D stage, synced to the audio clock) entirely in the browser (File API + `URL.createObjectURL`, nothing uploaded); the `m=` audio reference in the KSH header is ignored in this mode.

Then: `assets/js/ksh-parser.js` (pure parser: KSH text → chart object with meta/notes/lasers/timing/camera events) → synced renderers fed the same parsed chart: `assets/js/viewer3d.js` (Three.js scene, instanced notes, laser ribbons, camera-effect engine ported from the game's `Camera.cpp`/`Track.cpp`) and `assets/js/flatview.js` (right panel: chartlab-style flat 2D canvas laid out in beats — fixed-height columns side by side, horizontally scrolling strip, virtualized rendering, follow/detach + click-to-seek, hover crosshair with precise measure/time, resizable via its left-edge handle) — glued by `main.js` (audio sync, HUD, controls, panel toggles, Load…/Settings popovers, assist tick via WebAudio lookahead scheduling, density bar, 2D strip PNG export). The Stats modal (figures + hand-drawn canvas charts, incl. the approximated SDVX profile radar) lives in `assets/js/stats.js`.

The sidebar (song list, left) is hidden by default (opened via **Load… → browse the songs list**, closed by its own **Close** button); the flat 2D panel (right) is shown by default and toggled by the **Chart 2D** button, bottom right. Call `viewer.resize()` after anything that changes the canvas size. Deep link `?song=<folder>&chart=<file>` auto-loads a chart (values matched against the song list only — keep it that way).

## Security rules (this folder is web-served)

- **No upload endpoint, ever** — local preview stays 100% client-side.
- `songs.php` must never take user input (no query params, paths, filenames).
- All chart-derived strings go into the DOM via `textContent`, never `innerHTML`.
- Keep `.htaccess` hardening in place (no indexes; `*.md`, dotfiles blocked).

## Docs

| File | Content |
|---|---|
| `README.md` | Structure, controls, KSH format coverage, known limitations |

Working notes (camera-effect formulas, security audit) live in `docs/`, kept out
of the repository via `.gitignore`.

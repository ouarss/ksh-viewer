<?php

// Lists the songs in _VIEWER/songs/: one folder = one song,
// one .ksh file = one difficulty. Returns everything as JSON for the front end.

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

const DIFFICULTY_ORDER = ['light' => 0, 'challenge' => 1, 'extended' => 2, 'infinite' => 3];

function parseKshHeader(string $path): array
{
    $header = [];
    $handle = fopen($path, 'r');
    if ($handle === false) {
        return $header;
    }

    $firstLine = true;
    while (($line = fgets($handle)) !== false) {
        if ($firstLine) {
            // Strip the UTF-8 BOM
            $line = preg_replace('/^\xEF\xBB\xBF/', '', $line);
            $firstLine = false;
        }
        $line = rtrim($line, "\r\n");
        if ($line === '--') {
            break;
        }
        $eq = strpos($line, '=');
        if ($eq > 0) {
            $header[substr($line, 0, $eq)] = substr($line, $eq + 1);
        }
    }
    fclose($handle);

    return $header;
}

$songsDir = __DIR__ . '/songs';
$songs = [];

// Missing songs/ folder (or unreadable) simply yields an empty list
$songDirs = is_dir($songsDir) ? (glob($songsDir . '/*', GLOB_ONLYDIR) ?: []) : [];

foreach ($songDirs as $dir) {
    $folder = basename($dir);
    $charts = [];
    $songTitle = $folder;
    $songArtist = '';
    $songJacket = '';

    foreach (glob($dir . '/*.ksh') ?: [] as $kshFile) {
        $header = parseKshHeader($kshFile);
        if (!isset($header['title'])) {
            continue;
        }

        $difficulty = $header['difficulty'] ?? '';
        $jacket = $header['jacket'] ?? '';
        // Jackets referenced outside the folder (e.g. "../icon.png") are ignored
        if ($jacket !== '' && (str_contains($jacket, '..') || !is_file($dir . '/' . $jacket))) {
            $jacket = '';
        }

        $charts[] = [
            'file' => basename($kshFile),
            'difficulty' => $difficulty,
            'level' => (int) ($header['level'] ?? 0),
        ];

        $songTitle = $header['title'];
        $songArtist = $header['artist'] ?? '';
        if ($songJacket === '' && $jacket !== '') {
            $songJacket = $jacket;
        }
    }

    if (!$charts) {
        continue;
    }

    usort($charts, function (array $a, array $b): int {
        $oa = DIFFICULTY_ORDER[$a['difficulty']] ?? 99;
        $ob = DIFFICULTY_ORDER[$b['difficulty']] ?? 99;
        return $oa <=> $ob ?: $a['level'] <=> $b['level'];
    });

    $songs[] = [
        'folder' => $folder,
        'title' => $songTitle,
        'artist' => $songArtist,
        'jacket' => $songJacket,
        'charts' => $charts,
    ];
}

usort($songs, fn (array $a, array $b): int => strcasecmp($a['title'], $b['title']));

echo json_encode($songs, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);

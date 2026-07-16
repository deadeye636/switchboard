const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { getFolderIndexMtimeMs } = require('../index/folder-index-state');
// Direct path import (NOT the backends registry): this is a worker_thread and must stay Electron-free,
// and the registry can transitively reach electron. folder-reader only requires session-reader +
// derive-project-path, both Electron-free (#188).
const { readFolderSessions } = require('../backends/claude/folder-reader');

const PROJECTS_DIR = workerData.projectsDir;

function readFolderFromFilesystem(folder) {
  // Capture the index mtime before reading sessions so a concurrent index
  // write during the read still triggers the next refresh.
  const indexMtimeMs = getFolderIndexMtimeMs(path.join(PROJECTS_DIR, folder));
  const { projectPath, sessions } = readFolderSessions(PROJECTS_DIR, folder);
  if (!projectPath) return null;
  return { folder, projectPath, sessions, indexMtimeMs };
}

// Scan all folders
try {
  const folders = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== '.git')
    .map(d => d.name);

  const results = [];
  for (let i = 0; i < folders.length; i++) {
    if (i % 5 === 0 || i === folders.length - 1) {
      parentPort.postMessage({ type: 'progress', text: `Scanning projects (${i + 1}/${folders.length})\u2026` });
    }
    const result = readFolderFromFilesystem(folders[i]);
    if (result) results.push(result);
  }
  parentPort.postMessage({ ok: true, results });
} catch (err) {
  parentPort.postMessage({ ok: false, error: err.message });
}

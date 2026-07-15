const path = require('path');
const { deriveProjectPath } = require('../../derive-project-path');
const { readSessionFile, enumerateSessionFiles } = require('./session-reader');

// Shared, Electron-free core of "read one ~/.claude/projects folder from the
// filesystem": derive the project path, then read every session jsonl in the
// folder (#79). Used by both the scan worker and the main-process session
// cache — keep it free of Electron and DB dependencies.
// Returns { folderPath, projectPath, sessions }; projectPath is null (with
// empty sessions) when no project path can be derived from the folder.
function readFolderSessions(projectsDir, folder) {
  const folderPath = path.join(projectsDir, folder);
  const projectPath = deriveProjectPath(folderPath);
  const sessions = [];
  if (!projectPath) return { folderPath, projectPath: null, sessions };

  for (const { filePath, parentSessionId } of enumerateSessionFiles(folderPath)) {
    const s = readSessionFile(filePath, folder, projectPath, { parentSessionId });
    if (s) sessions.push(s);
  }

  return { folderPath, projectPath, sessions };
}

module.exports = { readFolderSessions };

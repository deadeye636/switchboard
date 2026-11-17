const path = require('path');
const { deriveProjectPath } = require('../../session/derive-project-path');
const { readSessionFile, enumerateSessionFiles } = require('./session-reader');

// Shared, Electron-free core of "read one ~/.claude/projects folder from the
// filesystem": derive the project path, then read every session jsonl in the
// folder (#79). Used by both the scan worker and the main-process session
// cache — keep it free of Electron and DB dependencies.
// Returns { folderPath, projectPath, sessions }; projectPath is null (with
// empty sessions) when no project path can be derived from the folder.
// `known.projectPath` (optional): a caller that has already derived it (the scan worker, which must decide
// removed-or-not before reading) hands it in rather than deriving twice.
function readFolderSessions(projectsDir, folder, known) {
  const folderPath = path.join(projectsDir, folder);
  const projectPath = known && known.projectPath ? known.projectPath : deriveProjectPath(folderPath);
  const sessions = [];
  if (!projectPath) return { folderPath, projectPath: null, sessions };

  for (const { filePath, parentSessionId } of enumerateSessionFiles(folderPath)) {
    const s = readSessionFile(filePath, folder, projectPath, { parentSessionId });
    if (s) sessions.push(s);
  }

  return { folderPath, projectPath, sessions };
}

module.exports = { readFolderSessions };

// #114: node-pty's `useConptyDll` option loads conpty.dll from a `conpty/` folder
// next to the loaded conpty.node. node-pty's shipped prebuilds contain that folder,
// but a local source build (build/Release — which node-pty prefers at require time)
// does not: binding.gyp has no copy step. Copy the bundled DLL in after every
// rebuild so useConptyDll works in dev and in the packaged app.
//
// Runs as: npm postinstall step + electron-builder beforePack hook (a rebuild during
// packaging wipes build/Release, so postinstall alone is not enough).
const fs = require('fs');
const path = require('path');

function ensureConptyDll() {
  if (process.platform !== 'win32') return;
  const ptyDir = path.join(__dirname, '..', 'node_modules', 'node-pty');
  const releaseDir = path.join(ptyDir, 'build', 'Release');
  if (!fs.existsSync(path.join(releaseDir, 'conpty.node'))) return; // no local build → prebuilds already ship the DLL
  const target = path.join(releaseDir, 'conpty', 'conpty.dll');
  if (fs.existsSync(target)) return;

  const archDir = process.arch === 'arm64' ? 'win10-arm64' : 'win10-x64';
  const thirdParty = path.join(ptyDir, 'third_party', 'conpty');
  let source = null;
  if (fs.existsSync(thirdParty)) {
    for (const version of fs.readdirSync(thirdParty)) {
      const candidate = path.join(thirdParty, version, archDir, 'conpty.dll');
      if (fs.existsSync(candidate)) { source = candidate; break; }
    }
  }
  // Fallback: the prebuilds folder carries the same DLL.
  if (!source) {
    const prebuilt = path.join(ptyDir, 'prebuilds', `win32-${process.arch}`, 'conpty', 'conpty.dll');
    if (fs.existsSync(prebuilt)) source = prebuilt;
  }
  if (!source) {
    console.warn('[ensure-conpty-dll] no bundled conpty.dll found in node-pty package — useConptyDll will fail');
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log(`[ensure-conpty-dll] copied ${path.relative(ptyDir, source)} -> build/Release/conpty/conpty.dll`);
}

module.exports = async function () { ensureConptyDll(); };
if (require.main === module) ensureConptyDll();

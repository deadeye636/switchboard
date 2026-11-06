// What Electron's spell check does on this machine (#815, spec 32). Writes nothing outside its own temp profile.
//
//   node_modules/electron/dist/electron scripts/measure-spell-check.js de-DE,en-US
//   node_modules/electron/dist/electron scripts/measure-spell-check.js off
//
// Starts from a fresh profile, types words, right-clicks each one for real and prints what `context-menu`
// reports, plus the dictionary events and files. `off` switches the check off first and reports any download.
const { app, BrowserWindow, session } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const arg = process.argv[process.argv.length - 1];
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-spell-'));
app.setPath('userData', profile);
app.on('quit', () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* the OS cleans temp */ } });
const out = (key, value) => console.log(`${key}: ${JSON.stringify(value)}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TEXT = 'Hauss Haus hosue house Rechtschreibprüfung Rechtschreibprufung ';
const PAGE = `<!DOCTYPE html><body style="margin:20px"><textarea id="t" rows="3" cols="80" style="font:16px monospace;padding:5px"></textarea>
<span id="m" style="font:16px monospace;position:absolute;visibility:hidden">0000000000</span></body>`;

app.whenReady().then(async () => {
  const ses = session.defaultSession;
  for (const ev of ['initialized', 'download-begin', 'download-success', 'download-failure']) {
    ses.on(`spellcheck-dictionary-${ev}`, (_e, lang) => out(ev, lang));
  }
  out('system', { preferred: app.getPreferredSystemLanguages(), available: ses.availableSpellCheckerLanguages.length });
  if (arg === 'off') ses.setSpellCheckerEnabled(false);
  else ses.setSpellCheckerLanguages(arg.split(','));

  const win = new BrowserWindow({ width: 900, height: 300 });
  let last = null;
  win.webContents.on('context-menu', (_e, p) => { last = { word: p.misspelledWord, suggestions: p.dictionarySuggestions }; });
  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`);
  win.focus();
  win.webContents.focus();
  const js = (code) => win.webContents.executeJavaScript(code);
  await sleep(25000); // the dictionaries
  await js(`document.getElementById('t').focus(); 0`);
  await win.webContents.insertText(TEXT);
  await sleep(2000);
  const at = await js(`(() => { const b = document.getElementById('t').getBoundingClientRect(); return { x: b.x, y: b.y, w: document.getElementById('m').getBoundingClientRect().width / 10 }; })()`);
  let column = 0;
  for (const word of TEXT.trim().split(' ')) {
    const x = Math.round(at.x + 6 + at.w * (column + word.length / 2));
    const y = Math.round(at.y + 14);
    last = null;
    win.webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'right', clickCount: 1 });
    await sleep(40);
    win.webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'right', clickCount: 1 });
    await sleep(500);
    out(word, last);
    column += word.length + 1;
  }
  const dictionaries = path.join(profile, 'Dictionaries');
  out('dictionary files', fs.existsSync(dictionaries) ? fs.readdirSync(dictionaries) : []);
  app.quit();
});

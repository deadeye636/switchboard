// app/spell-check.js — the spell check of a text field (#815).
//
// Chromium marks the words; what the app adds is the switch, the languages and the right-click menu, because
// Electron draws no menu of its own. Applies to every window: a field that opts out with `spellcheck="false"`
// never reports a word here.
//
// What a right click on a marked word can offer depends on who knows the language. Measured on Windows with
// Electron 41 (`scripts/measure-spell-check.js`, spec 32): a language with an OS spell checker installed is
// marked by that checker, and Electron reports no suggestions for it; a language without one is checked by a
// Hunspell dictionary, downloaded from the Chromium CDN on first use, and has suggestions. The menu says so
// rather than leaving the list out.
//
// Electron-free like settings.js, so its decisions can be required by a test.

let ctx;

// What an empty setting means: the owner's choice, not the system's languages (#815).
const DEFAULT_LANGUAGES = ['de-DE', 'en-US'];

// The stored list, or with none the default, as codes this build has. Asking for a code it does not have throws
// (measured), so nothing outside `available` may reach setSpellCheckerLanguages. On macOS `available` is empty,
// the OS decides and there is nothing to set.
function resolveLanguages(stored, available) {
  const known = new Map((available || []).map((code) => [code.toLowerCase(), code]));
  const typed = String(stored || '').split(/[\s,;]+/).filter(Boolean);
  const asked = typed.length ? typed : DEFAULT_LANGUAGES;
  const languages = [];
  const unknown = [];
  for (const code of asked) {
    const hit = known.get(code.toLowerCase());
    if (hit && !languages.includes(hit)) languages.push(hit);
    else if (!hit && typed.length) unknown.push(code);
  }
  return { languages, unknown };
}

function currentLanguages() {
  const g = ctx.getSetting('global') || {};
  return resolveLanguages(g.spellCheckLanguages, ctx.session.defaultSession.availableSpellCheckerLanguages);
}

// Called at start and by the settings write door, so a change holds at once and in every window.
function apply() {
  const ses = ctx.session.defaultSession;
  const g = ctx.getSetting('global') || {};
  const enabled = g.spellCheck !== false;
  ses.setSpellCheckerEnabled(enabled);
  if (!enabled) return;
  const { languages, unknown } = currentLanguages();
  if (unknown.length) ctx.log.warn('[spell-check] languages this build does not have:', unknown.join(', '));
  if (languages.length) ses.setSpellCheckerLanguages(languages);
}

function menuTemplate(params, actions) {
  const flags = params.editFlags || {};
  const suggestions = params.dictionarySuggestions || [];
  return [
    ...(suggestions.length
      ? suggestions.map((word) => ({ label: word, click: () => actions.replace(word) }))
      : [{ label: 'No suggestions', enabled: false }]),
    { type: 'separator' },
    { label: 'Add to dictionary', click: () => actions.addWord(params.misspelledWord) },
    { type: 'separator' },
    { role: 'cut', enabled: !!flags.canCut },
    { role: 'copy', enabled: !!flags.canCopy },
    { role: 'paste', enabled: !!flags.canPaste },
  ];
}

// A window that keeps the right click for itself has to know which click this was, and a marked word cannot be
// asked for beforehand: the renderer's own check knows only the Hunspell half (measured). So it leaves the DOM
// event alone and this answers, with the menu or without.
function onContextMenu(contents, params) {
  if (!params.isEditable || contents.isDestroyed()) return;
  const marked = !!params.misspelledWord;
  contents.send('editable-context-menu', marked);
  if (!marked) return;
  ctx.Menu.buildFromTemplate(menuTemplate(params, {
    replace: (word) => { if (!contents.isDestroyed()) contents.replaceMisspelling(word); },
    addWord: (word) => ctx.session.defaultSession.addWordToSpellCheckerDictionary(word),
  })).popup({ window: ctx.BrowserWindow.fromWebContents(contents) || undefined });
}

/**
 * @param {object} context
 * @param {Electron.App} context.app
 * @param {typeof Electron.session} context.session
 * @param {typeof Electron.Menu} context.Menu
 * @param {typeof Electron.BrowserWindow} context.BrowserWindow
 * @param {(key: string) => any} context.getSetting
 * @param {object} context.log
 */
function init(context) {
  ctx = context;
  ctx.app.on('web-contents-created', (_event, contents) => {
    if (contents.getType() === 'window') contents.on('context-menu', (_e, params) => onContextMenu(contents, params));
  });
  ctx.app.whenReady().then(() => {
    try { apply(); } catch (err) { ctx.log.warn('[spell-check] could not apply the setting:', err?.message || err); }
  });
}

function registerIpc(ipc) {
  // The settings field names what is in use and what this build does not have. Asked with the field's text, so
  // it answers for what is typed there before anything is saved.
  ipc.handle('spell-check-languages', (_event, stored) => {
    const ses = ctx.session.defaultSession;
    const available = ses.availableSpellCheckerLanguages;
    return { osDecides: !available.length, ...resolveLanguages(stored, available) };
  });
}

module.exports = { init, registerIpc, apply, resolveLanguages, menuTemplate, DEFAULT_LANGUAGES };

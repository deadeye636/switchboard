// app/spell-check.js — the spell check of a text field (#815).
//
// Chromium marks the words; what the app adds is the switch, the languages and the right-click menu, because
// Electron draws no menu of its own. Applies to every window: a field that opts out with `spellcheck="false"`
// never reports a word here.
//
// Who knows the language decides where its corrections come from. Measured on Windows with Electron 41
// (`scripts/measure-spell-check.js`, spec 32): a language with an OS spell checker installed is marked by that
// checker, and Electron reports no suggestions for it, so `spell-suggest-windows.js` asks the checker itself; a
// language without one is checked by a Hunspell dictionary, downloaded from the Chromium CDN on first use, and has
// suggestions. A word nobody has anything for says so rather than leaving the list out.
//
// Electron-free like settings.js, so its decisions can be required by a test.

let ctx;

const { mergeSuggestions } = require('./spell-suggest-windows');

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
//
// The corrections may take a moment the first time, and the menu must not land on a caret that has moved since: it opens
// at the pointer and a pick replaces what is selected then. So the latest right click wins, and any key or mouse press
// during the wait drops the menu. With Hunspell's words in hand and the OS checker still cold, the menu does not wait.
const latestClick = new WeakMap();
async function onContextMenu(contents, params) {
  if (!params.isEditable || contents.isDestroyed()) return;
  const click = (latestClick.get(contents) || 0) + 1;
  latestClick.set(contents, click);
  const marked = !!params.misspelledWord;
  contents.send('editable-context-menu', marked);
  if (!marked) return;
  let suggestions = params.dictionarySuggestions || [];
  if (ctx.suggestFromOs) {
    const tags = currentLanguages().languages;
    if (suggestions.length && ctx.osAnswersAtOnce && !ctx.osAnswersAtOnce(tags)) {
      ctx.suggestFromOs(params.misspelledWord, tags); // warms it for the next one
    } else {
      let interrupted = false;
      const onInput = (_event, input) => {
        if (input && /^(mouseDown|keyDown|rawKeyDown)$/.test(input.type)) interrupted = true;
      };
      contents.on('input-event', onInput);
      const fromOs = await ctx.suggestFromOs(params.misspelledWord, tags);
      if (contents.isDestroyed()) return;
      contents.removeListener('input-event', onInput);
      if (interrupted || latestClick.get(contents) !== click) return;
      suggestions = mergeSuggestions(fromOs, suggestions);
    }
  }
  ctx.Menu.buildFromTemplate(menuTemplate({ ...params, dictionarySuggestions: suggestions }, {
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
 * @param {(word: string, tags: string[]) => Promise<string[]>} [context.suggestFromOs]
 * @param {(tags: string[]) => boolean} [context.osAnswersAtOnce]
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

module.exports = { init, registerIpc, apply, onContextMenu, resolveLanguages, menuTemplate, DEFAULT_LANGUAGES };

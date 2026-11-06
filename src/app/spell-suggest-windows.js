// app/spell-suggest-windows.js — corrections from the Windows spell checker (#818, spec 32).
//
// On Windows Chromium marks a word with the OS checker where that language is installed, and Electron reports no
// suggestions for such a word: German was marked and its menu said "No suggestions". The same checker can be asked
// directly through its COM interface, which needs no dictionary, no download and no dependency, and it agrees with the
// marks because it drew them. Measured against nspell with dictionary-de: for `Rechtschreibprufung` the OS answers
// `Rechtschreibprüfung` and nspell nothing, and that dictionary is GPL where this app is MIT.
//
// COM with these interfaces needs a native module or a language that can declare them, so this is one long-lived
// Windows PowerShell started at the first right click on a marked word. Its first answer takes as long as compiling the
// declarations; later ones are milliseconds. It holds about 130 MB, so it is not kept for nothing: it ends after a while
// unused, once no asked language has a checker on this machine, and a start that gave no answer is not tried again for
// a while, so a machine whose policy refuses it pays once rather than on every click.
//
// The word travels as JSON on stdin, so it is never part of a command line. The file is ours, in the app's data
// directory, and rewritten at each start. No project is its working directory (CLAUDE.md reflex 10).
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const FIRST_ANSWER_MS = 8000;
const ANSWER_MS = 1500;
const MAX_SUGGESTIONS = 6;
const OTHER_ROOM = 2;
const IDLE_MS = 10 * 60 * 1000;
const RETRY_AFTER_MS = 10 * 60 * 1000;

const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SwitchboardWinSpell {
  [ComImport, Guid("00000101-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IEnumString {
    [PreserveSig] int Next(uint celt, [MarshalAs(UnmanagedType.LPWStr)] out string rgelt, out uint fetched);
  }
  [ComImport, Guid("B6FD0B71-E2BC-4653-8D05-F197E412770B"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISpellChecker {
    [PreserveSig] int get_LanguageTag([MarshalAs(UnmanagedType.LPWStr)] out string v);
    [PreserveSig] int Check([MarshalAs(UnmanagedType.LPWStr)] string text, out IntPtr e);
    [PreserveSig] int Suggest([MarshalAs(UnmanagedType.LPWStr)] string word, out IEnumString e);
  }
  [ComImport, Guid("8E018A9D-2415-4677-BF08-794EA61F94BB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface ISpellCheckerFactory {
    [PreserveSig] int get_SupportedLanguages(out IEnumString e);
    [PreserveSig] int IsSupported([MarshalAs(UnmanagedType.LPWStr)] string tag, out int ok);
    [PreserveSig] int CreateSpellChecker([MarshalAs(UnmanagedType.LPWStr)] string tag, out ISpellChecker c);
  }
  [ComImport, Guid("7AB36653-1796-484B-BDFA-E74F1DB7C1DC")] class Factory {}
  static readonly Dictionary<string, ISpellChecker> checkers = new Dictionary<string, ISpellChecker>();
  static ISpellCheckerFactory factory;
  static ISpellChecker CheckerFor(string tag) {
    if (factory == null) factory = (ISpellCheckerFactory)new Factory();
    ISpellChecker c;
    if (!checkers.TryGetValue(tag, out c)) {
      int ok;
      if (factory.IsSupported(tag, out ok) != 0 || ok == 0 || factory.CreateSpellChecker(tag, out c) != 0) c = null;
      checkers[tag] = c;
    }
    return c;
  }
  public static int Supported(string[] tags) {
    int n = 0;
    foreach (var tag in tags) if (CheckerFor(tag) != null) n++;
    return n;
  }
  // Turn about per language, so a full German list leaves room for what English knows.
  public static string[] Suggest(string[] tags, string word, int max) {
    var lists = new List<List<string>>();
    foreach (var tag in tags) {
      var list = new List<string>();
      var c = CheckerFor(tag);
      IEnumString e;
      if (c != null && c.Suggest(word, out e) == 0 && e != null) {
        string s; uint n;
        while (list.Count < max && e.Next(1, out s, out n) == 0 && n == 1) list.Add(s);
      }
      lists.Add(list);
    }
    var found = new List<string>();
    for (int i = 0; i < max; i++) {
      foreach (var list in lists) if (i < list.Count && !found.Contains(list[i])) found.Add(list[i]);
    }
    return found.ToArray();
  }
}
'@
while ($null -ne ($line = [Console]::In.ReadLine())) {
  try {
    $q = $line | ConvertFrom-Json
    $tags = [string[]]@($q.tags)
    $words = [SwitchboardWinSpell]::Suggest($tags, [string]$q.word, [int]$q.max)
    $supported = [SwitchboardWinSpell]::Supported($tags)
    [Console]::Out.WriteLine((ConvertTo-Json -Compress @{ id = $q.id; words = @($words); supported = $supported }))
  } catch {
    [Console]::Out.WriteLine((ConvertTo-Json -Compress @{ id = $q.id; words = @() }))
  }
  [Console]::Out.Flush()
}
`;

// The OS's first, because it knows the language the word was marked in, but not all the room: a word can be marked by
// both, and for the English typo `hosue` the German checker alone would fill the menu and push out `house`. No word twice.
function mergeSuggestions(fromOs, fromElectron, limit = MAX_SUGGESTIONS) {
  const clean = (list) => (list || []).filter((word) => typeof word === 'string' && word);
  const os = clean(fromOs);
  const other = clean(fromElectron);
  const hold = other.length ? Math.max(1, limit - OTHER_ROOM) : limit;
  const out = [];
  for (const word of [...os.slice(0, hold), ...other, ...os.slice(hold)]) {
    if (!out.includes(word)) out.push(word);
    if (out.length === limit) break;
  }
  return out;
}

let ctx;
let child = null;
let lines = null;
let answered = false;
let nextId = 1;
let idleTimer = null;
let retryAfter = 0;
let noCheckerFor = '';
const waiting = new Map();
const now = () => (ctx && ctx.now ? ctx.now() : Date.now());
const tagsKey = (tags) => tags.join(',');

function settle(id, words) {
  const w = waiting.get(id);
  if (!w) return;
  waiting.delete(id);
  clearTimeout(w.timer);
  w.resolve(words);
}

// A process that never answered is not tried again for a while. Anything else ends quietly and starts on the next word.
function noteDead(reason) {
  if (child && !answered) {
    retryAfter = now() + RETRY_AFTER_MS;
    if (ctx.log) ctx.log.info(`[spell-suggest] the Windows checker is not reachable (${reason}), so a language it holds gets no corrections`);
  }
}

function stop() {
  const c = child;
  child = null;
  answered = false;
  clearTimeout(idleTimer);
  idleTimer = null;
  if (lines) lines.close();
  lines = null;
  for (const id of [...waiting.keys()]) settle(id, []);
  if (c) { try { c.kill(); } catch { /* it has gone */ } }
}

function start() {
  const scriptPath = path.join(ctx.dataDir(), 'win-spell-suggest.ps1');
  // A BOM, or Windows PowerShell reads the file as the system's code page.
  fs.writeFileSync(scriptPath, `\uFEFF${SCRIPT}`);
  const env = ctx.env || process.env;
  const exe = path.win32.join(env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const started = (ctx.spawn || spawn)(exe, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
    cwd: ctx.dataDir(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  child = started;
  const gone = (reason) => { if (child === started) { noteDead(reason); stop(); } };
  started.on('error', (err) => gone(err.code || 'it failed to start'));
  started.on('exit', (code) => gone(`it exited with ${code}`));
  started.stdin.on('error', () => gone('its input closed'));
  started.stdout.on('error', () => gone('its output closed'));
  lines = readline.createInterface({ input: started.stdout });
  lines.on('line', (line) => {
    let answer;
    try { answer = JSON.parse(line.replace(/^\uFEFF/, '')); } catch { return; }
    if (!answer || typeof answer !== 'object') return;
    answered = true;
    const held = waiting.get(answer.id);
    settle(answer.id, Array.isArray(answer.words) ? answer.words : typeof answer.words === 'string' ? [answer.words] : []);
    // Nothing here to ask for these languages, so the process has no reason to stay.
    if (held && answer.supported === 0) { noCheckerFor = held.key; stop(); }
  });
}

// Never rejects. No answer in time, a refused start and an unsupported language all mean no words here.
function suggest(word, tags) {
  if (!ctx || (ctx.platform || process.platform) !== 'win32' || !word || !tags || !tags.length) return Promise.resolve([]);
  if (noCheckerFor === tagsKey(tags) || now() < retryAfter) return Promise.resolve([]);
  return new Promise((resolve) => {
    try {
      if (!child) start();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(stop, IDLE_MS);
      if (idleTimer.unref) idleTimer.unref();
      const id = nextId++;
      // A process that does not answer in time is ended, or every later click would wait the same again.
      const timer = setTimeout(() => {
        settle(id, []);
        noteDead('it did not answer');
        stop();
      }, answered ? ANSWER_MS : FIRST_ANSWER_MS);
      waiting.set(id, { resolve, timer, key: tagsKey(tags) });
      child.stdin.write(`${JSON.stringify({ id, word, tags, max: MAX_SUGGESTIONS })}\n`);
    } catch (err) {
      noteDead(err.code || 'it failed to start');
      stop();
      resolve([]);
    }
  });
}

// Will an answer come without the wait of a start? True where nothing would be asked at all.
function ready(tags) {
  if (!ctx || (ctx.platform || process.platform) !== 'win32') return true;
  if (!tags || !tags.length || noCheckerFor === tagsKey(tags) || now() < retryAfter) return true;
  return !!child && answered;
}

/**
 * @param {object} context
 * @param {() => string} context.dataDir  the app's data directory
 * @param {object} [context.log]
 * @param {Electron.App} [context.app]  its `will-quit` ends the process
 */
function init(context) {
  ctx = context;
  retryAfter = 0;
  noCheckerFor = '';
  if (ctx.app) ctx.app.on('will-quit', stop);
}

module.exports = { init, suggest, ready, stop, mergeSuggestions, MAX_SUGGESTIONS };

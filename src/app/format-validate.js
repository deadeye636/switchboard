// app/format-validate.js — is this text still the format the file claims to be? (#441)
//
// The app can now write a CLI's own configuration, and the failure mode that matters is not a bad edit:
// it is a bad edit the CLI discovers at its next start, in a file the user has since forgotten about.
// So a save is refused when the text no longer parses, with the parser's own line and column in the
// message — that is the one thing that makes the refusal actionable.
//
// **Syntax only, never schema.** Four CLIs change their own settings schema whenever they like; a schema
// check here would be wrong within a release and would refuse a file the CLI is perfectly happy with.
// This answers exactly one question: can it still be parsed.
//
// Which parser is chosen by EXTENSION, not by backend — TOML is TOML for everyone, and a backend that
// invents a new format gets a new entry here rather than a rule of its own. What a backend does own is
// WHICH files may be written at all, and that is a descriptor declaration (`resourceEditing`), not this.
//
// Electron-free and dependency-light: `smol-toml` and `js-yaml` are the only two, both pure JS, both
// main-process only.
'use strict';

const path = require('path');

const yaml = require('js-yaml');
const toml = require('smol-toml');

const BOM = '﻿';

const strip = (text) => (typeof text === 'string' && text.startsWith(BOM) ? text.slice(1) : text || '');

/** The parser's message, trimmed to what a person can act on. Never a path — these files are the user's. */
function reason(err, what) {
  const raw = (err && err.message ? String(err.message) : '').split('\n').slice(0, 2).join(' ').trim();
  return raw ? `Not valid ${what}: ${raw}` : `Not valid ${what}.`;
}

function validateJson(text) {
  // JSON.parse rejects a BOM outright, and a BOM'd settings.json is perfectly fine for the CLI reading
  // it — so the check sees the logical text and the write puts the bytes back as they were.
  try { JSON.parse(strip(text)); return { ok: true }; } catch (err) { return { ok: false, error: reason(err, 'JSON') }; }
}

function validateToml(text) {
  try { toml.parse(strip(text)); return { ok: true }; } catch (err) { return { ok: false, error: reason(err, 'TOML') }; }
}

function validateYaml(text) {
  try { yaml.load(strip(text)); return { ok: true }; } catch (err) { return { ok: false, error: reason(err, 'YAML') }; }
}

/**
 * Markdown: only the frontmatter block is checked, and only for being parseable YAML.
 *
 * A skill's frontmatter is what its CLI reads to know the skill exists at all, so a broken block is the
 * one markdown error worth refusing. The body is prose — there is nothing to be wrong about.
 */
function validateMarkdown(text) {
  const body = strip(text);
  if (!body.startsWith('---')) return { ok: true };
  const end = body.indexOf('\n---', 3);
  if (end === -1) {
    return { ok: false, error: 'The frontmatter block is not closed — it needs a line with only `---`.' };
  }
  const block = body.slice(body.indexOf('\n') + 1, end);
  try {
    const parsed = yaml.load(block);
    if (parsed !== null && parsed !== undefined && typeof parsed !== 'object') {
      return { ok: false, error: 'The frontmatter block must be a set of `key: value` lines.' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: reason(err, 'frontmatter') };
  }
}

const BY_EXT = {
  '.json': validateJson,
  '.toml': validateToml,
  '.yaml': validateYaml,
  '.yml': validateYaml,
  '.md': validateMarkdown,
  '.markdown': validateMarkdown,
};

/** Whether this app can check a file of this name at all. */
function canValidate(filePath) {
  return Object.prototype.hasOwnProperty.call(BY_EXT, path.extname(String(filePath || '')).toLowerCase());
}

/**
 * `{ ok: true }`, or `{ ok: false, error }` naming what the parser objected to.
 *
 * A format with no parser here answers `ok` — refusing a file this app cannot check would make it
 * unwritable for no reason. The caller says so in the UI instead, because "saved without a check" is a
 * different promise from "checked and fine".
 */
function validateContent(filePath, text) {
  const check = BY_EXT[path.extname(String(filePath || '')).toLowerCase()];
  return check ? check(text) : { ok: true, unchecked: true };
}

module.exports = { validateContent, canValidate, _validateJson: validateJson, _validateToml: validateToml, _validateYaml: validateYaml, _validateMarkdown: validateMarkdown };

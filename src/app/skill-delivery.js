// app/skill-delivery.js — what one skill is to one target backend (#803, spec 40 F2).
//
// The skills view of the Plugins manager shows ONE row per skill file and, on its detail page, what each
// backend makes of it. That answer is decided here, in main, from facts the descriptors already declare;
// the renderer gets a state and a sentence and never a backend id (reflex 5).
//
// `resource-sources.resolve` is the launch's answer and stays the only one: it is asked here for the
// target and the source the target is configured with, and the skill FILE is matched by containment
// under the directories it hands back. A second reading of `sharedResources` here would be how the
// detail page and the launch start to disagree.
//
// States:
//   - `text`     a Switchboard skill: no CLI owns it, the skill picker hands it over as text;
//   - `native`   the target's own CLI owns the skill;
//   - `shared`   the target takes it over through "Resources from";
//   - `declined` the source offers it, this target does not take it with its current options;
//   - `none`     the target does not get it, with the reason.
//
// Pure apart from what it is handed: the registry facts, the target's options and the resolver arrive as
// arguments, so `node --test` reaches every state without a settings store or a backend on disk.
'use strict';

const path = require('path');

const { isAtOrInside } = require('./path-containment');

/**
 * Is the skill file under one of the directories the resolver named? Asked BOTH ways and either answer
 * counts: the file was joined onto the listed directory by the backend's expander, so the lexical answer
 * is the namespace the listing speaks (backends.md, #544), and a skill folder that is a junction to
 * somewhere else is under it lexically while its real path is not. The real-path half covers a listing
 * spelled through a link. This is a MATCH, not a guard — nothing is read or written on its answer.
 */
function under(file, dir) {
  const rel = path.relative(dir, file);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  return isAtOrInside(file, dir);
}

function sentenceCase(text) {
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}

// The `configFields` token a target's source select declares (`resource-sources.js`, SOURCE_CHOICES).
// Asked by the token rather than by a field id, because the id is the target's own word.
const SOURCE_CHOICES = 'sharedResourceSources';

// The listing source `skills.js` stamps on the app's own skills — core vocabulary, not a backend's.
const SWITCHBOARD_SOURCE = 'switchboard-skills';

/** The option id under which a target keeps the backend it takes resources from, or null. */
function sourceOptionId(target) {
  const fields = target && Array.isArray(target.configFields) ? target.configFields : [];
  const field = fields.find((f) => f && f.choicesFrom === SOURCE_CHOICES);
  return field ? field.id : null;
}

function takesSkills(target) {
  return !!(target && Array.isArray(target.acceptsSharedResources) && target.acceptsSharedResources.includes('skill'));
}

/** The target's own invocation for the skill, or null — the same hook the picker asks. */
function invocationFor(target, row) {
  if (!target || typeof target.skillInvocation !== 'function') return null;
  try {
    const answer = target.skillInvocation({ name: row.name, filePath: row.filePath, scope: row.scope, source: row.source || null });
    return (typeof answer === 'string' && answer.trim()) ? answer.trim() : null;
  } catch { return null; }
}

const DECLINE_SENTENCES = {
  'untrusted-project': 'Not passed: this backend does not take a project\'s resources here.',
};

/** Every backend that reported the file, with its listing source. A row without `owners` has its one owner. */
function ownersOf(row) {
  if (Array.isArray(row.owners)) return row.owners.filter(o => o && o.backendId);
  return row.backendId ? [{ backendId: row.backendId, source: row.source || null }] : [];
}

/**
 * One target's answer for one skill row of the inventory.
 *
 * `row` is a main-side inventory row (`owners`, `filePath`, `name`, `scope`). `ownerOf(b)` names the CLI
 * a descriptor belongs to, so a driver of a CLI (a native GUI backend) counts as that CLI. `labelOf(id)`
 * gives a backend's label. `options` are the target's effective options for the project. `resolve` is
 * `resource-sources.resolve`.
 *
 * Returns `{ state, sentence, invocation }`; `invocation` only for `native` and `shared`.
 */
async function deliveryFor({ row, target, ownerOf, labelOf, options = {}, projectPath = null, resolve }) {
  if (row.source === SWITCHBOARD_SOURCE) {
    return { state: 'text', sentence: 'A Switchboard skill: the skill picker hands it over as text.', invocation: null };
  }
  const owners = ownersOf(row);
  if (!owners.length) {
    return { state: 'none', sentence: 'No backend reported this skill.', invocation: null };
  }
  const own = owners.find(o => o.backendId === ownerOf(target));
  if (own) {
    const invocation = invocationFor(target, { ...row, source: own.source });
    return { state: 'native', sentence: invocation ? `Its own skill, run with ${invocation}.` : 'Its own skill.', invocation };
  }
  const ownerLabel = owners.map(o => labelOf(o.backendId) || o.backendId).join(' or ');
  const optionId = sourceOptionId(target);
  if (!takesSkills(target) || !optionId) {
    return { state: 'none', sentence: 'Takes no skills from another CLI.', invocation: null };
  }
  const sourceId = typeof options[optionId] === 'string' ? options[optionId].trim() : '';
  if (!sourceId) {
    return { state: 'none', sentence: 'Takes resources from no other CLI here ("Resources from" is unset).', invocation: null };
  }
  const from = owners.find(o => o.backendId === sourceId);
  if (!from) {
    const chosen = labelOf(sourceId) || sourceId;
    return { state: 'none', sentence: `Takes resources from ${chosen} here, not from ${ownerLabel}.`, invocation: null };
  }
  const fromLabel = labelOf(from.backendId) || from.backendId;

  let resolved = null;
  try {
    resolved = await resolve({ target, sourceId, projectPath, options });
  } catch { resolved = null; }
  if (!resolved || resolved.ok === false) {
    const why = resolved && resolved.reason ? ` ${resolved.reason}` : '';
    return { state: 'none', sentence: `Could not tell what ${fromLabel} hands over.${why}`, invocation: null };
  }
  if ((resolved.skills || []).some((s) => s && s.path && under(row.filePath, s.path))) {
    return {
      state: 'shared', sentence: `Taken over from ${fromLabel} through "Resources from".`,
      invocation: invocationFor(target, { ...row, source: from.source }),
    };
  }
  const dropped = (resolved.dropped || []).find((d) => d && d.kind === 'skill' && d.path && under(row.filePath, d.path));
  if (dropped) {
    const sentence = sentenceCase(dropped.note) || DECLINE_SENTENCES[dropped.reason] || 'Not passed with this backend\'s current options.';
    return { state: 'declined', sentence, invocation: null };
  }
  return { state: 'none', sentence: `${fromLabel} does not share the directory this skill is in.`, invocation: null };
}

module.exports = { deliveryFor, sourceOptionId };

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { encodeProjectPath } = require('../encode-project-path');

test('replaces non-alphanumerics with dashes (mirrors the Claude CLI naming)', () => {
  assert.equal(encodeProjectPath('/Users/x/My Project'), '-Users-x-My-Project');
  assert.equal(encodeProjectPath('D:\\Projekte\\switchboard'), 'D--Projekte-switchboard');
  assert.equal(encodeProjectPath('/a/b/c'), '-a-b-c');
});

test('short paths (<=200 sanitized chars) are returned unhashed', () => {
  const p = '/' + 'a'.repeat(199); // sanitized = 200 chars exactly
  const out = encodeProjectPath(p);
  assert.equal(out.length, 200);
  assert.equal(out, '-' + 'a'.repeat(199));
});

test('paths >200 sanitized chars get a deterministic base36 hash suffix', () => {
  const long = '/' + 'a'.repeat(250); // sanitized = 251 chars → hash branch
  const out = encodeProjectPath(long);
  assert.ok(out.length > 200);
  assert.match(out, /^.{200}-[0-9a-z]+$/); // 200 chars + '-' + hash
  assert.equal(encodeProjectPath(long), out); // deterministic
});

test('different long paths produce different hashes', () => {
  const a = encodeProjectPath('/' + 'a'.repeat(250));
  const b = encodeProjectPath('/' + 'b'.repeat(250));
  assert.notEqual(a, b);
});

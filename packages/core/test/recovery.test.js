import { test } from 'node:test';
import assert from 'node:assert/strict';
import { draftLines } from '../src/recovery.js';

test('manual recovery copies unfinished edits and selections instead of silently restoring the previously committed answer', () => {
  const grill = { questions: [{ n: 3 }, { n: 8, multi: true, choices: [{ name: 'A' }, { name: 'B' }] }] };
  const saved = { answers: [{ kind: 'own', text: 'Previous answer' }, { kind: 'choice', choice: ['A'] }], drafts: { 0: 'New unfinished answer' }, choiceDrafts: { 1: ['B'] } };
  assert.equal(draftLines(grill, saved), 'Q3 - New unfinished answer\nQ8 - B');
  saved.drafts[0] = ''; saved.choiceDrafts[1] = [];
  assert.equal(draftLines(grill, saved), 'Q3 - skip for now, ask again later\nQ8 - skip for now, ask again later');
  assert.equal(saved.answers[0].text, 'Previous answer', 'copy never commits or changes the live draft');
});

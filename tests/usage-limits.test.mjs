import assert from 'node:assert/strict';
import test from 'node:test';
import { limitAfterError } from '../server/usage-limits.ts';

test('Claude session and weekly limits count as usage limits with their reset time', () => {
  const now = new Date(2026, 8, 27, 19, 44).getTime();
  const expected = new Date(2026, 8, 27, 20, 10).getTime();
  for (const kind of ['session', 'weekly', 'Opus']) {
    const limit = limitAfterError(`You've hit your ${kind} limit · resets 8:10pm (Europe/Madrid)`, true, now);
    assert.deepEqual(limit, { at: now, resetsAt: expected, resume: true });
  }
});

import './fixtures/isolated-data.mjs';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { store } from '../server/store.ts';
import { providerLimits } from '../server/usage.ts';

test('usage limits use each selected account and invalidate changed launch settings', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'citropy-usage-accounts-'));
  t.after(async () => {
    store.providerInstances.delete('first');
    store.providerInstances.delete('second');
    await rm(directory, { recursive: true, force: true });
  });
  const fixture = join(directory, 'provider.mjs');
  const calls = join(directory, 'calls');
  await writeFile(fixture, `
    import { createInterface } from 'node:readline';
    import { appendFileSync } from 'node:fs';
    const lines = createInterface({ input: process.stdin });
    lines.on('line', line => {
      const message = JSON.parse(line);
      if (message.id === 1) {
        appendFileSync(process.env.TEST_CALLS, process.env.TEST_ALLOWANCE + '\\n');
        process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\\n');
      }
      if (message.id === 2) process.stdout.write(JSON.stringify({ id: 2, result: { rateLimits: { primary: { usedPercent: Number(process.env.TEST_ALLOWANCE), windowDurationMins: 300 } } } }) + '\\n');
    });
    await new Promise(() => {});
  `);
  const account = (id, allowance) => ({ id, name: id, provider: 'codex', binary: process.execPath, environment: {
    NODE_OPTIONS: `--import=${pathToFileURL(fixture).href}`,
    TEST_ALLOWANCE: String(allowance),
    TEST_CALLS: calls,
  } });
  store.providerInstances.set('first', account('first', 12));
  store.providerInstances.set('second', account('second', 100));
  const [first, second, duplicate] = await Promise.all([
    providerLimits('codex', 'first'), providerLimits('codex', 'second'), providerLimits('codex', 'first'),
  ]);
  assert.equal(first.windows[0]?.usedPercent, 12, first.error);
  assert.equal(second.windows[0]?.usedPercent, 100, second.error);
  assert.equal(first, duplicate);
  assert.equal(await providerLimits('codex', 'first'), first);
  assert.deepEqual((await readFile(calls, 'utf8')).trim().split('\n').sort(), ['100', '12']);
  const now = Date.now;
  Date.now = () => now() + 31_000;
  try {
    await providerLimits('codex', 'second');
    const source = await readFile(fixture, 'utf8');
    await writeFile(fixture, 'process.exit(1);');
    const unavailable = await providerLimits('codex', 'first');
    assert.ok(unavailable.error);
    assert.equal(unavailable.windows[0]?.usedPercent, 12);
    await writeFile(fixture, source);
  } finally {
    Date.now = now;
  }
  store.providerInstances.set('second', account('second', 25));
  assert.equal((await providerLimits('codex', 'second')).windows[0]?.usedPercent, 25);
  await assert.rejects(providerLimits('claude', 'first'), /account is unavailable/);
  await assert.rejects(providerLimits('codex', 'missing'), /account is unavailable/);
});

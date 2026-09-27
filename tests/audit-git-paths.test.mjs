import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { discard, fileDiff, manage, stage, status, workingDiff } from '../server/git.ts';
import { parseUnifiedDiff } from '../server/diff.ts';

/** Create an isolated real Git repository; every destructive operation targets this fixture. */
async function fixture(t, files = { 'keep.txt': 'original\n' }, commit = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'citropy-audit-paths-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 15000 });
  git('init', '-q');
  for (const [key, value] of Object.entries({
    'user.name': 'Citropy audit', 'user.email': 'audit@example.invalid',
    'commit.gpgSign': 'false', 'core.autocrlf': 'false', 'core.quotePath': 'true',
    'core.filemode': 'false', 'diff.renames': 'true',
  })) git('config', '--local', key, value);
  for (const [name, text] of Object.entries(files)) await writeFile(join(cwd, name), text);
  git('add', '-A');
  if (commit) git('commit', '-qm', 'test fixture');
  const names = cached => git('diff', ...(cached ? ['--cached'] : []), '--name-only', '--no-renames', '-z').split('\0').filter(Boolean).sort();
  return { cwd, git, names };
}

const posixOnly = { skip: process.platform === 'win32' ? 'Windows filenames cannot contain pathspec magic or these control characters.' : false };

test('staging a pathspec-magic filename never stages neighboring files', posixOnly, async t => {
  const path = ':(glob)*.txt';
  const { cwd, names } = await fixture(t, { [path]: 'base\n', 'keep.txt': 'base\n' });
  for (const name of [path, 'keep.txt']) await writeFile(join(cwd, name), 'edited\n');
  await stage(cwd, path, true);
  assert.deepEqual(names(true), [path]);
});

test('unstaging a pathspec-magic filename preserves the other staged changes', posixOnly, async t => {
  const path = ':(glob)*.txt';
  const { cwd, git, names } = await fixture(t, { [path]: 'base\n', 'keep.txt': 'base\n' });
  for (const name of [path, 'keep.txt']) await writeFile(join(cwd, name), 'edited\n');
  git('add', '-A');
  await stage(cwd, path, false);
  assert.deepEqual(names(true), ['keep.txt']);
});

test('discarding a pathspec-magic filename cannot reset or delete unrelated work', posixOnly, async t => {
  const path = ':(glob)*.txt';
  const { cwd } = await fixture(t, { [path]: 'base\n', 'keep.txt': 'base\n' });
  for (const name of [path, 'keep.txt', 'untracked.txt']) await writeFile(join(cwd, name), 'valuable edits\n');
  await discard(cwd, path);
  assert.equal(await readFile(join(cwd, path), 'utf8'), 'base\n');
  assert.equal(await readFile(join(cwd, 'keep.txt'), 'utf8'), 'valuable edits\n');
  assert.equal(await readFile(join(cwd, 'untracked.txt'), 'utf8'), 'valuable edits\n');
});

test('staging a deleted bracket filename does not stage a matching sibling', async t => {
  const path = 'item[0-9].txt';
  const { cwd, names } = await fixture(t, { [path]: 'base\n', 'item0.txt': 'base\n' });
  await rm(join(cwd, path));
  await writeFile(join(cwd, 'item0.txt'), 'valuable edits\n');
  await stage(cwd, path, true);
  assert.deepEqual(names(true), [path]);
});

test('fileDiff returns the selected bracket filename rather than a glob match', async t => {
  const path = 'item[0-9].txt';
  const { cwd } = await fixture(t, { [path]: 'base\n', 'item0.txt': 'base\n' });
  await writeFile(join(cwd, path), 'selected\n');
  await writeFile(join(cwd, 'item0.txt'), 'not selected\n');
  const patch = await fileDiff(cwd, path, false);
  assert.equal(patch?.path, path);
  assert.ok(patch.hunks.flatMap(hunk => hunk.lines).some(line => line.text === 'selected'));
  assert.ok(!patch.hunks.flatMap(hunk => hunk.lines).some(line => line.text === 'not selected'));
});

test('unstaging in an unborn repository affects only the selected filename', posixOnly, async t => {
  const path = ':(glob)*.txt';
  const { cwd, git } = await fixture(t, { [path]: 'base\n', 'keep.txt': 'base\n' }, false);
  await stage(cwd, path, false);
  assert.deepEqual(git('ls-files', '-z').split('\0').filter(Boolean), ['keep.txt']);
  assert.equal(await readFile(join(cwd, path), 'utf8'), 'base\n');
});

test('status combines staged and unstaged counts for a Unicode filename', async t => {
  const path = 'café-猫.txt';
  const { cwd, git } = await fixture(t, { [path]: 'first\nsecond\n' });
  await writeFile(join(cwd, path), 'staged\nsecond\n');
  git('add', '-A');
  await writeFile(join(cwd, path), 'staged\nunstaged\n');
  const entry = (await status(cwd)).files.find(file => file.path === path);
  assert.ok(entry);
  assert.equal(entry.added, 2);
  assert.equal(entry.removed, 2);
});

test('status parses tabs and newlines in filenames without losing numstat records', posixOnly, async t => {
  const paths = ['tab\tfile.txt', 'line\nfile.txt'];
  const { cwd } = await fixture(t, Object.fromEntries(paths.map(path => [path, 'base\n'])));
  for (const path of paths) await writeFile(join(cwd, path), 'edited\n');
  const result = await status(cwd);
  for (const path of paths) {
    const entry = result.files.find(file => file.path === path);
    assert.ok(entry);
    assert.equal(entry.added, 1);
    assert.equal(entry.removed, 1);
  }
});

test('status assigns rename statistics to the literal destination filename', async t => {
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}\n`).join('');
  const path = 'renamed-猫.txt';
  const { cwd, git } = await fixture(t, { 'old.txt': before });
  git('mv', 'old.txt', path);
  await writeFile(join(cwd, path), before.replace('line 15\n', 'changed\n'));
  git('add', '-A');
  const entry = (await status(cwd)).files.find(file => file.path === path);
  assert.equal(entry?.index, 'R');
  assert.equal(entry.added, 1);
  assert.equal(entry.removed, 1);
});

test('binary files retain finite zero line counts', async t => {
  const { cwd } = await fixture(t, { 'binary.bin': Buffer.from([0, 1, 2]) });
  await writeFile(join(cwd, 'binary.bin'), Buffer.from([0, 3, 4]));
  const entry = (await status(cwd)).files.find(file => file.path === 'binary.bin');
  assert.equal(entry?.added, 0);
  assert.equal(entry?.removed, 0);
});

test('status reports tracking counts and branch state from one porcelain response', async t => {
  const { cwd, git } = await fixture(t);
  const branch = git('symbolic-ref', '--short', 'HEAD').trim();
  git('branch', 'upstream');
  git('branch', '--set-upstream-to=upstream');
  await writeFile(join(cwd, 'keep.txt'), 'ahead\n');
  git('commit', '-qam', 'ahead');
  let result = await status(cwd);
  assert.equal(result.branch, branch);
  assert.equal(result.upstream, 'upstream');
  assert.equal(result.ahead, 1);
  assert.equal(result.behind, 0);
  assert.equal(result.clean, true);
  git('checkout', '-q', 'upstream');
  await writeFile(join(cwd, 'behind.txt'), 'behind\n');
  git('add', '--', 'behind.txt');
  git('commit', '-qm', 'behind');
  git('checkout', '-q', branch);
  result = await status(cwd);
  assert.equal(result.ahead, 1);
  assert.equal(result.behind, 1);
  git('checkout', '-q', '--detach');
  result = await status(cwd);
  assert.equal(result.branch, 'detached');
  assert.equal(result.upstream, null);
  assert.equal(result.ahead, 0);
  assert.equal(result.behind, 0);
});

test('status preserves filenames and conflict codes in an unmerged index', async t => {
  const path = ' conflicting file.txt';
  const { cwd, git } = await fixture(t, { [path]: 'base\n' });
  const branch = git('symbolic-ref', '--short', 'HEAD').trim();
  git('checkout', '-qb', 'other');
  await writeFile(join(cwd, path), 'other\n');
  git('commit', '-qam', 'other');
  git('checkout', '-q', branch);
  await writeFile(join(cwd, path), 'current\n');
  git('commit', '-qam', 'current');
  assert.throws(() => git('merge', 'other'));
  const result = await status(cwd);
  assert.equal(result.clean, false);
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].path, path);
  assert.equal(result.files[0].index, 'U');
  assert.equal(result.files[0].work, 'U');
  assert.equal(result.files[0].staged, true);
});

test('status keeps the unborn branch and untracked paths', async t => {
  const { cwd, git } = await fixture(t, { 'space name.txt': 'new\n' }, false);
  git('rm', '--cached', '--', 'space name.txt');
  const result = await status(cwd);
  assert.equal(result.branch, git('symbolic-ref', '--short', 'HEAD').trim());
  assert.equal(result.upstream, null);
  assert.deepEqual(result.files, [{ path: 'space name.txt', index: '?', work: '?', added: 0, removed: 0, staged: false, untracked: true }]);
});

test('real Git patches round-trip Unicode, whitespace, and escaped paths', async t => {
  const paths = ['café-猫.txt', 'space name.txt', 'item[0-9].txt'];
  if (process.platform !== 'win32') paths.push(' leading.txt', 'trailing.txt ', 'tab\tfile.txt', 'line\nfile.txt', 'quote"file.txt', 'back\\slash.txt');
  const { cwd, git } = await fixture(t, Object.fromEntries(paths.map(path => [path, 'old\n'])));
  for (const path of paths) await writeFile(join(cwd, path), 'new\n');
  for (const quotePath of ['true', 'false']) {
    git('config', '--local', 'core.quotePath', quotePath);
    const patches = parseUnifiedDiff(await workingDiff(cwd, false));
    assert.deepEqual(patches.map(patch => patch.path).sort(), [...paths].sort());
    assert.ok(patches.every(patch => patch.added === 1 && patch.removed === 1));
  }
});

test('inherited Git glob and case-folding modes cannot broaden a file selection', async t => {
  const path = 'item[0-9].txt';
  const { cwd, git, names } = await fixture(t, { [path]: 'base\n', 'item0.txt': 'base\n' });
  await rm(join(cwd, path));
  await writeFile(join(cwd, 'item0.txt'), 'valuable edits\n');
  const module = new URL('../server/git.ts', import.meta.url).href;
  for (const variable of ['GIT_GLOB_PATHSPECS', 'GIT_NOGLOB_PATHSPECS', 'GIT_ICASE_PATHSPECS']) {
    git('reset', '-q', 'HEAD');
    execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
      `import { stage } from ${JSON.stringify(module)}; await stage(process.argv[1], process.argv[2], true);`, cwd, path],
    { env: { ...process.env, [variable]: '1' }, encoding: 'utf8', timeout: 15000, stdio: 'pipe' });
    assert.deepEqual(names(true), [path], variable);
  }
});


test('Source-control discardWorktree preserves unrelated tracked and untracked files', posixOnly, async t => {
  const path = ':(glob)*.txt';
  const tracked = await fixture(t, { [path]: 'base\n', 'keep.txt': 'base\n' });
  for (const name of [path, 'keep.txt']) await writeFile(join(tracked.cwd, name), 'valuable edits\n');
  await manage(tracked.cwd, 'discardWorktree', path);
  assert.equal(await readFile(join(tracked.cwd, path), 'utf8'), 'base\n');
  assert.equal(await readFile(join(tracked.cwd, 'keep.txt'), 'utf8'), 'valuable edits\n');
  const untracked = await fixture(t);
  for (const name of [path, 'untracked.txt']) await writeFile(join(untracked.cwd, name), 'valuable edits\n');
  await manage(untracked.cwd, 'discardWorktree', path);
  await assert.rejects(readFile(join(untracked.cwd, path)), { code: 'ENOENT' });
  assert.equal(await readFile(join(untracked.cwd, 'untracked.txt'), 'utf8'), 'valuable edits\n');
});

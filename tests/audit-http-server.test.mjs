import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { WebSocket } from 'ws';

/** Reserve an ephemeral loopback port for the isolated backend child process. */
async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Send an unnormalized request target, with a deadline and response-error handling. */
function exchange(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, agent: false }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('error', error => { clearTimeout(timer); reject(error); });
      res.on('end', () => { clearTimeout(timer); resolve({ status: res.statusCode, body }); });
    });
    const timer = setTimeout(() => req.destroy(new Error('Backend request timed out')), 5000);
    req.once('error', error => { clearTimeout(timer); reject(error); });
    req.end();
  });
}

test('the real backend survives malformed HTTP requests and WebSocket frames', { timeout: 30000 }, async t => {
  const home = await mkdtemp(join(tmpdir(), 'citropy-http-server-'));
  await mkdir(join(home, 'data'));
  await writeFile(join(home, 'data', 'settings.json'), JSON.stringify({ disabledProviders: ['claude', 'codex', 'opencode', 'cursor', 'pi'] }));
  const port = await freePort();
  let log = '';
  const child = spawn(process.execPath, ['--experimental-strip-types', 'server/main.ts', '--packaged'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      LOCALAPPDATA: join(home, 'AppData', 'Local'),
      CITROPY_DATA_DIR: join(home, 'data'),
      CITROPY_PORT: String(port),
      CITROPY_HOST: '127.0.0.1',
      CITROPY_REMOTE_ID: '',
      CITROPY_REMOTE_TOKEN: '',
      ELECTRON_RUN_AS_NODE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  child.stdout.on('data', chunk => { log = (log + chunk).slice(-16000); });
  child.stderr.on('data', chunk => { log = (log + chunk).slice(-16000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      await new Promise(resolve => {
        const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    await rm(home, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Backend startup timed out:\n${log}`)), 20000);
    const finish = error => {
      clearTimeout(timer);
      child.off('message', message);
      child.off('exit', exit);
      child.off('error', finish);
      error ? reject(error) : resolve();
    };
    const message = value => { if (value?.t === 'ready') finish(); };
    const exit = code => finish(new Error(`Backend exited (${code}):\n${log}`));
    child.on('message', message);
    child.once('exit', exit);
    child.once('error', finish);
  });
  for (const path of ['//[', '//', 'http://[', '/%', '/%E0%A4%A', '/%00', '/%5cfile', '/api/health#fragment']) {
    assert.equal((await exchange(port, path)).status, 400, path);
    const health = await exchange(port, '/api/health');
    assert.equal(health.status, 200, log);
    assert.equal(JSON.parse(health.body).ok, true);
  }
  assert.equal((await exchange(port, '/%', 'HEAD')).status, 400);
  assert.equal((await exchange(port, '//[', 'POST')).status, 400);
  for (const send of [
    socket => socket._socket.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0])),
    socket => socket.send(Buffer.alloc(2 * 1024 * 1024 + 1)),
  ]) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
    socket.on('error', () => {});
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('Malformed client was not closed')); }, 5000);
      socket.once('close', () => { clearTimeout(timer); resolve(); });
      send(socket);
    });
    assert.equal((await exchange(port, '/api/health')).status, 200, log);
  }
  assert.equal(child.exitCode, null, log);
  assert.equal(child.signalCode, null, log);
});

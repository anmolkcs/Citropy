import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { faviconFor } from '../server/favicons.ts';

async function site(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('favicon discovery fetches the origin and caps candidate requests', async t => {
  const requests = [];
  const origin = await site(t, (req, res) => {
    requests.push(req.url);
    if (req.url === '/') res.writeHead(200, { 'content-type': 'text/html' }).end(
      Array.from({ length: 20 }, (_, i) => `<link rel="icon" href="/missing-${i}.png">`).join(''));
    else res.writeHead(404).end();
  });
  assert.equal(await faviconFor(`${origin}/action?value=private`), undefined);
  assert.deepEqual(requests, ['/', '/missing-0.png', '/missing-1.png', '/missing-2.png', '/favicon.ico']);
  assert.equal(await faviconFor(`${origin}/another-link`), undefined);
  assert.equal(requests.length, 5);
});

test('one favicon consumer can cancel without aborting another consumer', async t => {
  let release;
  let started;
  const requested = new Promise(resolve => { started = resolve; });
  let requests = 0;
  const origin = await site(t, (req, res) => {
    requests++;
    if (req.url === '/') {
      release = () => res.writeHead(200, { 'content-type': 'text/html' }).end('');
      started();
    } else res.writeHead(200, { 'content-type': 'image/png' }).end('icon');
  });
  const controller = new AbortController();
  const first = faviconFor(origin, controller.signal);
  const second = faviconFor(origin);
  await requested;
  controller.abort();
  assert.equal(await first, undefined);
  release();
  assert.equal((await second).body.toString(), 'icon');
  assert.equal((await faviconFor(origin)).body.toString(), 'icon');
  assert.equal(requests, 2);
});

test('favicon work stops when its last consumer leaves and can be retried', async t => {
  let started;
  let closed;
  let waiting = true;
  const requested = new Promise(resolve => { started = resolve; });
  const disconnected = new Promise(resolve => { closed = resolve; });
  const origin = await site(t, (req, res) => {
    if (waiting) {
      res.once('close', closed);
      started();
    } else if (req.url === '/') res.writeHead(200, { 'content-type': 'text/html' }).end('');
    else res.writeHead(200, { 'content-type': 'image/png' }).end('retry');
  });
  const controller = new AbortController();
  const result = faviconFor(origin, controller.signal);
  await requested;
  controller.abort();
  assert.equal(await result, undefined);
  await disconnected;
  waiting = false;
  assert.equal((await faviconFor(origin)).body.toString(), 'retry');
});

test('favicon discovery bounds concurrent origins and releases cancelled slots', async t => {
  let requests = 0;
  t.mock.method(globalThis, 'fetch', (_url, { signal }) => {
    requests++;
    return new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  });
  const controllers = Array.from({ length: 16 }, () => new AbortController());
  const pending = controllers.map((controller, index) => faviconFor(`https://icon-limit-${index}.invalid`, controller.signal));
  assert.equal(await faviconFor('https://icon-overflow.invalid'), undefined);
  assert.equal(requests, 16);
  for (const controller of controllers) controller.abort();
  assert.deepEqual(await Promise.all(pending), Array(16).fill(undefined));
  const retry = new AbortController();
  const result = faviconFor('https://icon-overflow.invalid', retry.signal);
  assert.equal(requests, 17);
  retry.abort();
  assert.equal(await result, undefined);
});

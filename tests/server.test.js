import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../server.js';

test('server serves application modules, readiness and protects private files', async () => {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(base + '/health');
    assert.deepEqual(await health.json(), { status: 'ok', application: 'simulator-jednotky' });
    const home = await fetch(base);
    assert.equal(home.status, 200);
    assert.match(await home.text(), /id="gear-value"/);
    const module = await fetch(base + '/src/app.js');
    assert.equal(module.status, 200);
    assert.match(module.headers.get('content-type'), /javascript/);
    assert.match(await module.text(), /VehicleSimulator/);
    for (const path of ['/.git/config', '/package.json', '/README.md', '/src/..%2f.git/config']) {
      assert.equal((await fetch(base + path)).status, 404);
    }
    assert.equal((await fetch(base, { method: 'POST' })).status, 405);
    assert.equal((await fetch(base, { method: 'HEAD' })).status, 200);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from '../server.js';

test('live USB MOSFET diagnosis remains independent of simulation and detects lost telemetry', { timeout: 30000 }, async () => {
  const server = process.env.SIMULATOR_E2E_URL ? null : createServer();
  if (server) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseURL = process.env.SIMULATOR_E2E_URL || `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  let browser;
  try {
    browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      let controller;
      window.serialWrites = 0;
      const port = {
        readable: new ReadableStream({ start(value) { controller = value; } }),
        get writable() { window.serialWrites++; throw new Error('USB monitor must only read'); },
        open: async options => { window.serialBaud = options.baudRate; },
        close: async () => { window.serialClosed = true; },
      };
      Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => port } });
      window.emitSerial = text => controller.enqueue(new TextEncoder().encode(text));
      window.endSerial = () => controller.close();
    });
    await page.goto(baseURL);
    const status = () => page.locator('#mosfet-status').getAttribute('data-status');
    const waitStatus = value => page.waitForFunction(value => document.getElementById('mosfet-status').dataset.status === value, value);
    await waitStatus('waiting');
    await page.locator('#connect-btn').evaluate(element => element.closest('details').open = true);
    await page.locator('#connect-btn').click();
    await page.waitForFunction(() => !document.getElementById('disconnect-btn').disabled);
    await page.evaluate(() => window.emitSerial('ID is 1536\nData byte 0 = 64\nData byte 1 = 31\n'));
    await page.waitForTimeout(180);
    assert.equal(await status(), 'waiting', 'CAN traffic cannot validate MOSFET outputs');
    await page.locator('#pause-btn').click();
    await page.locator('#monitor-paused-btn').click();
    await page.evaluate(() => window.emitSerial('MOSFET,1,gpio,0,0,0,'));
    assert.equal(await status(), 'waiting', 'partial lines do not constitute telemetry');
    await page.evaluate(() => window.emitSerial('0\nMOSFET,1,gpio,1,100000,1,0\nMOSFET,1,gpio,2,200000,0,0\nMOSFET,1,gpio,3,300000,0,1\nMOSFET,1,gpio,4,350000,0,0\n'));
    await waitStatus('pass');
    assert.match(await page.locator('#mosfet-scope').textContent(), /řídicí registr GPIO/);
    assert.match(await page.locator('#mosfet-fet1-pulses').textContent(), /1 dokončených impulzů.*100 ms/);
    assert.match(await page.locator('#mosfet-fet2-pulses').textContent(), /1 dokončených impulzů.*50 ms/);
    assert.equal(await page.locator('#mosfet-fet1').textContent(), 'Vypnuto');
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));

    const downloadPromise = page.waitForEvent('download');
    await page.locator('#mosfet-export-btn').click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    let content = '';
    for await (const chunk of stream) content += chunk;
    const report = JSON.parse(content);
    assert.equal(report.diagnostic.scope, 'gpio');
    assert.equal(report.diagnostic.status, 'pass');

    await page.evaluate(() => window.emitSerial('MOSFET,1,gpio,5,400000,1,1\n'));
    await waitStatus('fail');
    await page.evaluate(() => window.emitSerial('MOSFET,1,gpio,6,450000,0,0\n'));
    await page.locator('#reset-btn').click();
    assert.equal(await status(), 'fail', 'resetting the simulation must not erase observed output faults');
    await page.locator('#mosfet-reset-btn').click();
    await waitStatus('waiting');
    await page.evaluate(() => window.emitSerial('MOSFET,1,gpio,100,1000000,0,0\nMOSFET,1,gpio,102,1100000,1,0\n'));
    await waitStatus('inconclusive');
    await waitStatus('stale');
    assert.equal(await page.locator('#mosfet-fet1').textContent(), 'Neznámý');
    await page.evaluate(() => window.endSerial());
    await waitStatus('disconnected');
    assert.equal(await page.evaluate(() => window.serialWrites), 0);
    assert.equal(await page.evaluate(() => window.serialBaud), 115200);
    assert.equal(await page.evaluate(() => window.serialClosed), true);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
});

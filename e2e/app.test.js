import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createServer } from '../server.js';

test('functional browser workflow', { timeout: 60000 }, async t => {
  const server = process.env.SIMULATOR_E2E_URL ? null : createServer();
  if (server) await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const baseURL = process.env.SIMULATOR_E2E_URL || `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  let browser;
  try {
    browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); });
    await page.goto(baseURL);
    const pedal = (name, value) => page.locator(`#${name}-input`).evaluate((element, value) => {
      element.value = value;
      element.dispatchEvent(new Event('input', { bubbles: true }));
    }, String(value));

    await t.test('dashboard loads, periodic CAN telemetry is generated', async () => {
      await page.waitForFunction(() => Number(document.getElementById('can-count').textContent.replace(/\D/g, '')) >= 3);
      assert.equal(await page.locator('#gear-value').textContent(), 'N');
      assert.equal(await page.locator('#speed-value').textContent(), '0.0');
      assert.match(await page.locator('#log-body').textContent(), /0x600/);
      assert.match(await page.locator('.demo-notice').textContent(), /demonstrační/);
    });

    await t.test('start, paddle shift, clutch release, throttle and braking drive the model', async () => {
      await page.locator('#ignition-btn').click();
      await page.waitForFunction(() => document.getElementById('unit-cooldown').textContent === '0 ms');
      await page.locator('#shift-up-btn').click();
      await page.waitForFunction(() => document.getElementById('gear-value').textContent === '1');
      await pedal('clutch', 0);
      await pedal('throttle', 100);
      await page.waitForFunction(() => Number(document.getElementById('speed-value').textContent) > 15, null, { timeout: 12000 });
      assert.match(await page.locator('#engine-status').textContent(), /běží/);
      await pedal('throttle', 0);
      await pedal('brake', 100);
      await page.waitForFunction(() => Number(document.getElementById('speed-value').textContent) === 0);
      await pedal('brake', 0);
      assert.match(await page.locator('#log-body').textContent(), /SIM TX/);
    });

    await t.test('keyboard request respects RPM protection; neutral and pedal keys work', async () => {
      await page.keyboard.press('KeyE');
      await page.waitForFunction(() => document.getElementById('status-message').textContent.includes('odmítnuto'));
      assert.equal(await page.locator('#gear-value').textContent(), '1');
      await page.waitForFunction(() => document.getElementById('unit-cooldown').textContent === '0 ms' && document.getElementById('unit-latch').textContent === 'Připraveno');
      await page.keyboard.press('KeyN');
      await page.waitForFunction(() => document.getElementById('gear-value').textContent === 'N');
      await page.locator('h1').click();
      await pedal('throttle', 25);
      await page.keyboard.down('Space');
      assert.equal(await page.locator('#throttle-input').inputValue(), '100');
      await page.keyboard.up('Space');
      assert.equal(await page.locator('#throttle-input').inputValue(), '25');
      await pedal('throttle', 0);
    });

    await t.test('screenshot RPM and shared steering flags decode without inventing a gear request', async () => {
      await page.locator('#import-log-input').setInputFiles({ name: 'ecu.log', mimeType: 'text/plain', buffer: Buffer.from('(1700000000.5) can0 600#401F000000000000\n(1700000001.5) can0 666#0014DC0108000800\n') });
      await page.waitForFunction(() => document.getElementById('status-message').textContent.includes('Importováno 2'));
      await page.locator('#direction-filter').selectOption('rx');
      await page.locator('#filter-input').fill('600');
      await page.waitForFunction(() => document.getElementById('log-body').textContent.includes('rpm: 8000'));
      await page.locator('#filter-input').fill('666');
      await page.waitForFunction(() => document.getElementById('log-body').textContent.includes('resetFuel: 2'));
      assert.match(await page.locator('#log-body').textContent(), /maskedCommand: 0/);
      await page.locator('#direction-filter').selectOption('all');
      await page.locator('#filter-input').fill('');
    });

    await t.test('pause, import real-format frames, filter and export capture', async () => {
      await page.locator('#pause-btn').click();
      const speed = await page.locator('#speed-value').textContent();
      await page.waitForTimeout(200);
      assert.equal(await page.locator('#speed-value').textContent(), speed);
      await page.locator('#import-log-input').setInputFiles({ name: 'capture.log', mimeType: 'text/plain', buffer: Buffer.from('(1700000000.123456) can0 123#AABB\n(1700000001.123456) can0 001ABCDE#010203\n') });
      await page.waitForFunction(() => document.getElementById('status-message').textContent.includes('Importováno 2'));
      await page.locator('#direction-filter').selectOption('rx');
      await page.locator('#filter-input').fill('0x123');
      await page.waitForFunction(() => document.querySelectorAll('#log-body tr').length === 1 && document.getElementById('log-body').textContent.includes('0x123'));
      assert.match(await page.locator('#log-body').textContent(), /SOUBOR can0/);
      const downloadPromise = page.waitForEvent('download');
      await page.locator('#export-log-btn').click();
      const download = await downloadPromise;
      assert.equal(download.suggestedFilename(), 'can-zaznam.log');
      const stream = await download.createReadStream();
      let content = '';
      for await (const chunk of stream) content += chunk;
      assert.match(content, /123#AABB/);
      assert.match(content, /001ABCDE#010203/);
      assert.match(content, /600#/);
      assert.match(content, /sim0 600#/);
      assert.match(content, /can0 123#AABB/);
    });

    await t.test('malformed profile is rejected without replacing working one; valid profile applies', async () => {
      await page.locator('#profile-name').evaluate(element => element.closest('details').open = true);
      const oldName = await page.locator('#profile-name').textContent();
      await page.locator('#profile-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"name":"bad"}') });
      await page.waitForFunction(() => document.getElementById('status-message').textContent.includes('Profil nebyl změněn'));
      assert.equal(await page.locator('#profile-name').textContent(), oldName);
      const profile = { name: 'Testovací vlastní profil', bitrate: 250000, frames: [{ name: 'Otáčky', id: 0x321, dlc: 2, trigger: 'periodic', periodMs: 50, signals: [{ name: 'rpm', source: 'rpm', startByte: 0, byteLength: 2 }] }] };
      await page.locator('#profile-input').setInputFiles({ name: 'custom.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(profile)) });
      await page.waitForFunction(() => document.getElementById('profile-name').textContent.includes('Testovací'));
      await page.locator('#direction-filter').selectOption('all');
      await page.locator('#filter-input').fill('321');
      await page.locator('#pause-btn').click();
      await page.waitForFunction(() => document.getElementById('log-body').textContent.includes('0x321'));
      assert.equal(await page.locator('#status-message').evaluate(element => element.classList.contains('is-error')), false);
    });

    await t.test('model settings reset state, mobile layout has no horizontal page overflow', async () => {
      await page.locator('#model-form').evaluate(element => element.closest('details').open = true);
      await page.locator('[name="massKg"]').fill('320');
      await page.locator('[name="gearRatio1"]').fill('3');
      await page.locator('#model-form button').click();
      assert.equal(await page.locator('#gear-value').textContent(), 'N');
      assert.equal(await page.locator('#throttle-input').inputValue(), '0');
      assert.match(await page.locator('#engine-status').textContent(), /vypnutý/);
      mkdirSync('artifacts', { recursive: true });
      await page.screenshot({ path: 'artifacts/dashboard-desktop.png', fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.locator('h1').scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'page must fit mobile viewport');
      await page.screenshot({ path: 'artifacts/dashboard-mobile.png', fullPage: true });
      assert.deepEqual(errors, [], 'no browser script or CSP errors');
    });

    await t.test('unit calibration exports and reimports atomically; old parser exposes incompatibility', async () => {
      await page.setViewportSize({ width: 1440, height: 1100 });
      await page.locator('#unit-form').evaluate(element => element.closest('details').open = true);
      const downloaded = page.waitForEvent('download');
      await page.locator('#export-config-btn').click();
      const file = await downloaded;
      const stream = await file.createReadStream();
      let calibration = '';
      for await (const chunk of stream) calibration += chunk;
      const raw = JSON.parse(calibration);
      assert.equal(raw.shiftingUnit.actuationMs, 100);
      assert.equal(raw.shiftingUnit.protocol, 'current-car');
      assert.equal(raw.shiftingUnit.ratios[0], 500 * 3 / raw.shiftingUnit.rpmLowerLimit);
      assert.equal(raw.shiftingUnit.ratios[1], raw.vehicle.gearRatios[0]);
      raw.vehicle.massKg = 340;
      await page.locator('#calibration-input').setInputFiles({ name: 'calibration.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(raw)) });
      await page.waitForFunction(() => document.getElementById('status-message').textContent.includes('Kalibrace načtena'));
      assert.equal(await page.locator('[name="massKg"]').inputValue(), '340');
      raw.vehicle.gearRatios[0] = 5;
      await page.locator('#calibration-input').setInputFiles({ name: 'bad-calibration.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(raw)) });
      await page.waitForFunction(() => document.getElementById('status-message').textContent.includes('Kalibrace nebyla změněna'));
      assert.equal(await page.locator('[name="massKg"]').inputValue(), '340');
      await page.locator('#unit-mode').selectOption('firmware-parser');
      await page.locator('#ignition-btn').click();
      await page.locator('#shift-up-btn').click();
      assert.equal(await page.locator('#gear-value').textContent(), 'N');
      assert.match(await page.locator('#unit-status').textContent(), /0x642/);
    });

    await t.test('USB connection consumes real-format serial mirror without writing commands', async () => {
      const usbPage = await browser.newPage();
      await usbPage.addInitScript(() => {
        let controller;
        window.serialWrites = 0;
        const port = {
          readable: new ReadableStream({ start(value) { controller = value; } }),
          writable: new WritableStream({ write() { window.serialWrites++; } }),
          open: async options => { window.serialBaud = options.baudRate; },
          close: async () => { window.serialClosed = true; },
        };
        Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => port } });
        window.emitSerial = text => controller.enqueue(new TextEncoder().encode(text));
      });
      await usbPage.goto(baseURL);
      await usbPage.locator('#connect-btn').evaluate(element => element.closest('details').open = true);
      await usbPage.locator('#connect-btn').click();
      await usbPage.waitForFunction(() => !document.getElementById('disconnect-btn').disabled);
      await usbPage.evaluate(() => window.emitSerial('Message received\nMessage is in Standard Format\nID is 1536\nData byte 0 = 64\nData byte 1 = 31\n'));
      await usbPage.locator('#direction-filter').selectOption('rx');
      await usbPage.locator('#filter-input').fill('600');
      await usbPage.waitForFunction(() => document.getElementById('log-body').textContent.includes('UART RX*'));
      assert.match(await usbPage.locator('#log-body').textContent(), /rpm: 8000/);
      assert.equal(await usbPage.evaluate(() => window.serialWrites), 0);
      assert.equal(await usbPage.evaluate(() => window.serialBaud), 115200);
      await usbPage.locator('#disconnect-btn').click();
      assert.equal(await usbPage.evaluate(() => window.serialClosed), true);
      await usbPage.close();
    });
  } finally {
    await browser?.close();
    if (server) await new Promise(resolve => server.close(resolve));
  }
});

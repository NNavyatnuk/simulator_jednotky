import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

test('SPUSTIT.html drives the simulator offline without external files or a server', { timeout: 30000 }, async () => {
  const executablePath = process.env.CHROMIUM_PATH || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ offline: true });
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    // Managed cloud Chromium blocks file:// navigation. Inject exactly the file's
    // contents in an offline page to test bundling without bypassing that policy.
    const html = await readFile(new URL('../SPUSTIT.html', import.meta.url), 'utf8');
    assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href="\/src\//i);
    await page.setContent(html);
    await page.waitForFunction(() => document.getElementById('unit-cooldown').textContent === '0 ms');
    await page.locator('#ignition-btn').click();
    await page.locator('#shift-up-btn').click();
    await page.waitForFunction(() => document.getElementById('gear-value').textContent === '1');
    for (const [pedal, value] of [['clutch', 0], ['throttle', 100]]) {
      await page.locator(`#${pedal}-input`).evaluate((element, next) => {
        element.value = next;
        element.dispatchEvent(new Event('input', { bubbles: true }));
      }, String(value));
    }
    await page.waitForFunction(() => Number(document.getElementById('speed-value').textContent) > 15);
    assert.match(await page.locator('#log-body').textContent(), /0x600/);
    await page.locator('#pause-btn').click();
    await page.locator('#import-log-input').setInputFiles({ name: 'ecu.log', mimeType: 'text/plain', buffer: Buffer.from('(1700000000) can0 600#401F000000000000\n') });
    await page.waitForFunction(() => document.getElementById('status-message').textContent.includes('Importováno 1'));
    await page.locator('#direction-filter').selectOption('rx');
    await page.locator('#filter-input').fill('600');
    await page.waitForFunction(() => document.getElementById('log-body').textContent.includes('rpm: 8000'));
    assert.deepEqual(errors, []);
    assert.deepEqual(requests, [], 'standalone simulation must not need any other file or HTTP request');
  } finally {
    await browser.close();
  }
});

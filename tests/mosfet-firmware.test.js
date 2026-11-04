import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));

test('portable MOSFET telemetry core preserves pulse edges, heartbeat, loss sequence and complete records', { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mosfet-firmware-test-'));
  const binary = join(directory, process.platform === 'win32' ? 'mosfet-core.exe' : 'mosfet-core');
  try {
    await execFileAsync(process.env.CXX || 'c++', [
      '-std=c++17', '-Wall', '-Wextra', '-Wpedantic', '-Werror',
      join(PROJECT, 'reference', 'mosfet-monitor', 'tests', 'core-test.cpp'),
      '-o', binary,
    ], { timeout: 20000 });
    // execFile rejects on assertion failure, signal or timeout. This is only a
    // host test; it does not imply an ESP32/Arduino target build or hardware test.
    await execFileAsync(binary, [], { timeout: 3000 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const execFileAsync = promisify(execFile);
const PROJECT = dirname(dirname(fileURLToPath(import.meta.url)));

function request(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, agent: false }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
      response.on('error', reject);
    });
    req.setTimeout(3000, () => req.destroy(new Error(`Native server request timed out: ${path}`)));
    req.on('error', reject);
    req.end();
  });
}

async function startServer(binary, args, cwd) {
  const child = spawn(binary, ['--port', '0', ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  let output = '';
  let errors = '';
  child.stdout.on('data', bytes => { output += bytes; });
  child.stderr.on('data', bytes => { errors += bytes; });
  let timer;
  try {
    const port = await new Promise((resolve, reject) => {
      const ready = () => {
        const match = /127\.0\.0\.1:(\d+)/.exec(output);
        if (match) resolve(Number(match[1]));
      };
      timer = setTimeout(() => reject(new Error(`Native server did not become ready. stdout: ${output}; stderr: ${errors}`)), 5000);
      child.stdout.on('data', ready);
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`Native server exited before readiness (${code ?? signal}). stdout: ${output}; stderr: ${errors}`)));
    });
    return {
      port,
      async stop() {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await closed;
      },
    };
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

test('native C++ entrypoint builds and serves the simulator without a Node server', { timeout: 40000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tul-native-test-'));
  const binary = join(directory, process.platform === 'win32' ? 'simulator.exe' : 'simulator');
  try {
    await execFileAsync(process.env.CXX || 'c++', [
      '-std=c++17', '-Wall', '-Wextra', '-Wpedantic', '-Werror', '-O2',
      join(PROJECT, 'src', 'main.cpp'), '-o', binary,
      ...(process.platform === 'win32' ? ['-lws2_32'] : []),
    ], { timeout: 20000 });

    await t.test('help succeeds and invalid options fail without starting a service', async () => {
      const help = await execFileAsync(binary, ['--help'], { timeout: 3000 });
      assert.match(help.stdout, /--port/);
      assert.match(help.stdout, /--root/);
      for (const args of [
        ['--port', '-1'], ['--port', '65536'], ['--port', '12invalid'],
        ['--port'], ['--unknown'], ['--root', join(directory, 'missing')],
      ]) {
        await assert.rejects(execFileAsync(binary, args, { timeout: 3000 }), error => {
          assert.equal(typeof error.code, 'number', `must reject invalid arguments rather than time out: ${args.join(' ')}`);
          assert.notEqual(error.code, 0);
          return true;
        });
      }
    });

    const server = await startServer(binary, ['--root', PROJECT], directory);
    try {
      await t.test('native readiness and actual HTML, CSS and modules are served intact', async () => {
        const health = await request(server.port, '/health');
        assert.equal(health.status, 200);
        assert.deepEqual(JSON.parse(health.body), { status: 'ok', application: 'simulator-jednotky' });
        for (const [path, mime] of [['/', /text\/html/], ['/src/app.js', /javascript/], ['/src/styles.css', /text\/css/], ['/src/tul-protocol.js', /javascript/]]) {
          const response = await request(server.port, path);
          assert.equal(response.status, 200, path);
          assert.match(response.headers['content-type'], mime);
          assert.equal(response.headers['x-content-type-options'], 'nosniff');
          assert.equal(Number(response.headers['content-length']), response.body.length);
          assert.deepEqual(response.body, await readFile(join(PROJECT, path === '/' ? 'index.html' : path.slice(1))));
        }
        assert.match((await request(server.port, '/')).body.toString(), /id="gear-value"/);
      });

      await t.test('HEAD preserves resource length but never sends the body; unsupported methods fail', async () => {
        const index = await readFile(join(PROJECT, 'index.html'));
        const head = await request(server.port, '/', 'HEAD');
        assert.equal(head.status, 200);
        assert.equal(head.body.length, 0);
        assert.equal(Number(head.headers['content-length']), index.length);
        const post = await request(server.port, '/', 'POST');
        assert.equal(post.status, 405);
        assert.match(post.headers.allow, /GET/);
        assert.equal((await request(server.port, '/favicon.ico')).status, 204);
      });

      await t.test('checkout metadata, C++ sources, traversal and missing assets are inaccessible', async () => {
        for (const path of [
          '/.git/config', '/src/main.cpp', '/package.json', '/README.md',
          '/src/../README.md', '/src/%2e%2e/README.md', '/src/..%2f.git/config',
          '/src/missing-module.js', '/missing',
        ]) {
          assert.equal((await request(server.port, path)).status, 404, path);
        }
        for (const path of ['/src/%ZZ.js', '/src/%00.js']) {
          assert.ok([400, 404].includes((await request(server.port, path)).status), path);
        }
      });
    } finally {
      await server.stop();
    }

    await t.test('source-based root discovery works from a different current directory', async () => {
      const discovered = await startServer(binary, [], directory);
      try {
        assert.equal((await request(discovered.port, '/src/app.js')).status, 200);
        assert.match((await request(discovered.port, '/')).body.toString(), /id="gear-value"/);
      } finally {
        await discovered.stop();
      }
    });

    await t.test('a moved build/Release binary discovers its new project before the compiled source tree', async () => {
      const relocatedProject = join(directory, 'moved-project');
      const release = join(relocatedProject, 'build', 'Release');
      await mkdir(release, { recursive: true });
      await mkdir(join(relocatedProject, 'src'));
      const marker = '<!doctype html><title>Relocated simulator fixture</title>';
      await writeFile(join(relocatedProject, 'index.html'), marker);
      await writeFile(join(relocatedProject, 'src', 'app.js'), '// relocated app marker');
      const relocatedBinary = join(release, process.platform === 'win32' ? 'simulator.exe' : 'simulator');
      await copyFile(binary, relocatedBinary);
      await chmod(relocatedBinary, 0o755);
      const relocated = await startServer(relocatedBinary, [], directory);
      try {
        const page = await request(relocated.port, '/');
        assert.equal(page.status, 200);
        assert.equal(page.body.toString(), marker);
        assert.equal((await request(relocated.port, '/src/app.js')).body.toString(), '// relocated app marker');
      } finally {
        await relocated.stop();
      }
    });

    await t.test('an allowed-looking asset symlink cannot expose files outside the selected root', async () => {
      const fixture = join(directory, 'fixture');
      await mkdir(join(fixture, 'src'), { recursive: true });
      await writeFile(join(fixture, 'index.html'), '<!doctype html><title>Fixture</title>');
      await writeFile(join(fixture, 'src', 'app.js'), '// fixture app');
      await writeFile(join(directory, 'private.js'), 'private outside root');
      await symlink(join(directory, 'private.js'), join(fixture, 'src', 'escape.js'));
      const isolated = await startServer(binary, ['--root', fixture], directory);
      try {
        assert.equal((await request(isolated.port, '/src/app.js')).status, 200);
        assert.equal((await request(isolated.port, '/src/escape.js')).status, 404);
      } finally {
        await isolated.stop();
      }
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

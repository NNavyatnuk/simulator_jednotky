import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SlcanMonitor } from '../src/slcan.js';

function adapter({ rejectListen = false, silent = false, closeAfterListen = false, closeGate = null } = {}) {
  let source;
  const commands = [];
  let closed = false;
  let ended = false;
  let closeCalls = 0;
  const port = {
    open: async options => assert.equal(options.baudRate, 115200),
    close: async () => { closeCalls++; if (closeGate) await closeGate; closed = true; },
    readable: new ReadableStream({ start(controller) { source = controller; } }),
    writable: new WritableStream({ write(bytes) {
      const command = new TextDecoder().decode(bytes);
      commands.push(command);
      if (!silent && !ended) source.enqueue(new TextEncoder().encode(command === 'L\r' && rejectListen ? '\x07' : '\r'));
      if (command === 'L\r' && closeAfterListen) { ended = true; source.close(); }
    } }),
  };
  return {
    serial: { requestPort: async () => port }, commands, port,
    get closed() { return closed; }, get closeCalls() { return closeCalls; },
    emit: line => source.enqueue(new TextEncoder().encode(line)),
    end: () => { ended = true; source.close(); },
  };
}

test('SLCAN waits for acknowledgements, selects bitrate, receives split frames and closes without transmitting', async () => {
  const mock = adapter();
  const monitor = new SlcanMonitor(mock.serial);
  const frames = [];
  await monitor.connect({ bitrate: 500000, onFrame: frame => frames.push(frame) });
  assert.equal(monitor.connected, true);
  assert.deepEqual(mock.commands, ['C\r', 'S6\r', 'L\r']);
  mock.emit('t1232AA');
  mock.emit('BB\rT001ABCDE1FF\r');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].id, 0x123);
  assert.deepEqual(Array.from(frames[0].data), [0xAA, 0xBB]);
  assert.equal(frames[1].extended, true);
  await monitor.disconnect();
  assert.equal(mock.closed, true);
  assert.equal(monitor.connected, false);
  assert.ok(mock.commands.every(command => /^[CSL]/.test(command)));
});

test('unsupported listen-only mode fails and cleans up; never falls back to O', async () => {
  const mock = adapter({ rejectListen: true });
  const monitor = new SlcanMonitor(mock.serial);
  await assert.rejects(monitor.connect({ bitrate: 500000, onFrame() {} }), /odmítl/);
  assert.equal(mock.closed, true);
  assert.equal(mock.commands.includes('O\r'), false);
});

test('missing acknowledgements time out and unsupported bitrates do not open a port', async () => {
  const mock = adapter({ silent: true });
  const monitor = new SlcanMonitor(mock.serial, 25);
  await assert.rejects(monitor.connect({ bitrate: 500000, onFrame() {} }), /nepotvrdil/);
  assert.equal(mock.closed, true);
  await assert.rejects(new SlcanMonitor().connect({ bitrate: 123, onFrame() {} }), /bitrate/);
});

test('EOF immediately after listen acknowledgement rejects setup and releases the port', async () => {
  const mock = adapter({ closeAfterListen: true });
  const monitor = new SlcanMonitor(mock.serial);
  const statuses = [];
  await assert.rejects(monitor.connect({ bitrate: 500000, onFrame() {}, onStatus: text => statuses.push(text) }), /ukončeno/);
  assert.equal(monitor.connected, false);
  assert.equal(monitor.port, null);
  assert.equal(mock.closed, true);
  assert.equal(mock.port.readable.locked, false);
  assert.equal(mock.port.writable.locked, false);
  assert.equal(statuses.includes('Připojeno · pouze příjem'), false);
});

test('concurrent disconnects share cleanup and reconnect is blocked until close settles', async () => {
  let releaseClose;
  const closeGate = new Promise(resolve => { releaseClose = resolve; });
  const first = adapter({ closeGate });
  const second = adapter();
  let requests = 0;
  const monitor = new SlcanMonitor({ requestPort: async () => (++requests === 1 ? first.port : second.port) });
  await monitor.connect({ bitrate: 500000, onFrame() {} });
  const a = monitor.disconnect();
  const b = monitor.disconnect();
  assert.equal(a, b);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitor.port, first.port);
  assert.equal(monitor.connected, false);
  await assert.rejects(monitor.connect({ bitrate: 500000, onFrame() {} }), /odpojuje/);
  assert.equal(requests, 1);
  releaseClose();
  await Promise.all([a, b]);
  assert.equal(first.closeCalls, 1);
  assert.equal(monitor.port, null);
  await monitor.connect({ bitrate: 500000, onFrame() {} });
  assert.equal(monitor.connected, true);
  assert.equal(monitor.port, second.port);
  await monitor.disconnect();
  assert.equal(second.closeCalls, 1);
});

test('automatic EOF cleanup retains the old port until closed and notifies after cleanup', async () => {
  let releaseClose;
  const closeGate = new Promise(resolve => { releaseClose = resolve; });
  const mock = adapter({ closeGate });
  const monitor = new SlcanMonitor(mock.serial);
  const disconnectedPorts = [];
  await monitor.connect({ bitrate: 500000, onFrame() {}, onStatus: text => {
    if (text.startsWith('Adaptér odpojen')) disconnectedPorts.push(monitor.port);
  } });
  mock.end();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitor.connected, false);
  assert.equal(monitor.port, mock.port);
  await assert.rejects(monitor.connect({ bitrate: 500000, onFrame() {} }), /odpojuje/);
  assert.deepEqual(disconnectedPorts, []);
  const cleanup = monitor.disconnect();
  releaseClose();
  await cleanup;
  assert.equal(mock.closeCalls, 1);
  assert.deepEqual(disconnectedPorts, [null]);
});

test('parallel connect calls do not open a second chooser while the first is pending', async () => {
  const mock = adapter();
  let choose;
  let requests = 0;
  const monitor = new SlcanMonitor({ requestPort: () => { requests++; return new Promise(resolve => { choose = resolve; }); } });
  const connecting = monitor.connect({ bitrate: 500000, onFrame() {} });
  await assert.rejects(monitor.connect({ bitrate: 500000, onFrame() {} }), /připojuje/);
  assert.equal(requests, 1);
  choose(mock.port);
  await connecting;
  await monitor.disconnect();
});

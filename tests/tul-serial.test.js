import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TulSerialParser, TulSerialMonitor } from '../src/tul-serial.js';

const printed = (id, data, extended = false) => [
  'Message received',
  extended ? 'Warning: Message received in extended format!' : 'Message is in Standard Format',
  `ID is ${id}`,
  ...data.map((byte, index) => `Data byte ${index} = ${byte}`),
].join('\n') + '\n';

test('TUL debug parser reconstructs split decimal fields and interleaved task output', () => {
  const parser = new TulSerialParser();
  assert.deepEqual(parser.push('Driver started\nMessage rece'), []);
  assert.deepEqual(parser.push('ived\nMessage is in Standard Format\nID is 1602\nData byte 0 = 0\nAnalysing message\nData byte 1 = 0\nData byte 2 = 0\nData byte 3 = 0\nData byte 4 = '), []);
  assert.deepEqual(parser.flush({ includePartial: false }), []);
  assert.deepEqual(parser.push('2\nCurrent Gear: data = 1\n'), []);
  const [frame] = parser.push('Message received\n');
  assert.equal(frame.id, 0x642);
  assert.equal(frame.extended, false);
  assert.deepEqual(frame.data, [0, 0, 0, 0, 2]);
  assert.equal(frame.reconstructed, true);
  assert.equal(frame.dlcInferred, true);
  assert.equal(frame.direction, 'rx');
});

test('eight bytes finish immediately while shorter frames need a boundary or explicit flush', () => {
  const parser = new TulSerialParser();
  const [full] = parser.push(printed(0x604, [3, 0, 0, 0, 0, 0, 0, 0]));
  assert.equal(full.completion, 'eight-bytes');
  assert.equal(full.data.length, 8);
  assert.deepEqual(parser.push(printed(0x604, [7])), []);
  const [short] = parser.flush({ reason: 'idle' });
  assert.deepEqual(short.data, [7]);
  assert.equal(short.completion, 'idle');
  assert.deepEqual(parser.flush(), []);
});

test('extended flag is scoped to its message and headers can be omitted when starting mid-log', () => {
  const parser = new TulSerialParser();
  const frames = parser.push(printed(0x18DAF110, [12, 34], true) + printed(0x604, [2]));
  frames.push(...parser.flush());
  assert.deepEqual(frames.map(frame => [frame.id, frame.extended]), [[0x18DAF110, true], [0x604, false]]);
  parser.push('ID is 1604\nData byte 0 = 3\nID is 1604\nData byte 0 = 4\n');
  const [last] = parser.flush();
  assert.deepEqual(last.data, [4]);
});

test('malformed, duplicate or noncontiguous bytes and out-of-range IDs are discarded atomically', () => {
  for (const body of [
    'ID is 1604\nData byte 1 = 1\n',
    'ID is 1604\nData byte 0 = 1\nData byte 0 = 2\n',
    'ID is 1604\nData byte 0 = 1\nData byte 2 = 2\n',
    'ID is 1604\nData byte 0 = 256\n',
    'ID is 1604\nData byte 0 = -1\n',
    'ID is 1604\nData byte 0 = 1 DEBUG\n',
    'ID is 2048\nData byte 0 = 1\n',
    'ID is nope\nData byte 0 = 1\n',
  ]) {
    const parser = new TulSerialParser();
    assert.deepEqual(parser.push(body), []);
    assert.deepEqual(parser.flush(), []);
    parser.push(printed(0x604, [3]));
    assert.deepEqual(parser.flush()[0].data, [3], 'must recover on next message');
  }
});

test('missing payload is never fabricated as an RTR or zero-length data frame', () => {
  const parser = new TulSerialParser();
  assert.deepEqual(parser.push('Message received\nID is 1604\nMessage received\nFailed to receive message\nID is 1602\n'), []);
  assert.deepEqual(parser.flush(), []);
});

test('explicit EOF supports an unterminated complete last line; idle does not consume it', () => {
  const parser = new TulSerialParser();
  parser.push('ID is 1604\r\nData byte 0 = 7');
  assert.deepEqual(parser.flush({ includePartial: false }), []);
  assert.deepEqual(parser.flush()[0].data, [7]);
  assert.throws(() => parser.push(null), /text/);
});

test('oversized serial lines are bounded and discard the affected record', () => {
  const parser = new TulSerialParser();
  parser.push('ID is 1604\nData byte 0 = 1\n' + 'x'.repeat(10000));
  assert.ok(parser._buffer.length <= 4096);
  assert.deepEqual(parser.flush(), []);
  parser.push(printed(0x604, [4]));
  assert.equal(parser.flush()[0].id, 0x604);
});

function serialMock({ immediateEof = false, closeGate = null } = {}) {
  let controller;
  let closeCalls = 0;
  let openCalls = 0;
  const port = {
    open: async options => { assert.deepEqual(options, { baudRate: 115200 }); openCalls++; },
    close: async () => { closeCalls++; if (closeGate) await closeGate; },
    readable: new ReadableStream({ start(source) { controller = source; if (immediateEof) source.close(); } }),
    get writable() { throw new Error('UART diagnostic monitor must never access writable'); },
  };
  return {
    serial: { requestPort: async () => port }, port,
    emit: text => controller.enqueue(new TextEncoder().encode(text)),
    end: () => controller.close(),
    get closeCalls() { return closeCalls; },
    get openCalls() { return openCalls; },
  };
}

test('USB UART monitor receives idle-delimited frames at115200 without any writes and releases locks', async () => {
  const mock = serialMock();
  const monitor = new TulSerialMonitor(mock.serial, 15);
  const frames = [];
  await monitor.connect({ onFrame: frame => frames.push(frame) });
  assert.equal(monitor.connected, true);
  mock.emit(printed(0x604, [4]));
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(frames.length, 1);
  assert.equal(frames[0].id, 0x604);
  assert.deepEqual(frames[0].data, [4]);
  assert.equal(frames[0].completion, 'idle');
  assert.ok(Number.isFinite(frames[0].timestamp));
  await monitor.disconnect();
  assert.equal(mock.closeCalls, 1);
  assert.equal(mock.port.readable.locked, false);
  assert.equal(monitor.port, null);
});

test('USB UART idle timer cannot consume a split byte; EOF flushes the last complete diagnostic line', async () => {
  const mock = serialMock();
  const monitor = new TulSerialMonitor(mock.serial, 10);
  const frames = [];
  await monitor.connect({ onFrame: frame => frames.push(frame) });
  mock.emit('ID is 1604\nData byte 0 = 2');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(frames.length, 0);
  mock.emit('55\nMessage received\nID is 1604\nData byte 0 = 7');
  mock.end();
  await new Promise(resolve => setImmediate(resolve));
  await monitor.disconnect();
  assert.deepEqual(frames.map(frame => frame.data), [[255], [7]]);
  assert.equal(mock.closeCalls, 1);
});

test('USB UART immediate EOF rejects startup instead of claiming a connected unit', async () => {
  const mock = serialMock({ immediateEof: true });
  const monitor = new TulSerialMonitor(mock.serial);
  const statuses = [];
  await assert.rejects(monitor.connect({ onFrame() {}, onStatus: value => statuses.push(value) }), /ukončeno/);
  assert.equal(monitor.connected, false);
  assert.equal(mock.closeCalls, 1);
  assert.ok(statuses.every(value => !value.startsWith('Připojeno')));
});

test('USB UART concurrent disconnect shares teardown and rejects reconnect until close completes', async () => {
  let release;
  const mock = serialMock({ closeGate: new Promise(resolve => { release = resolve; }) });
  const monitor = new TulSerialMonitor(mock.serial);
  await monitor.connect({ onFrame() {} });
  const first = monitor.disconnect();
  assert.equal(monitor.disconnect(), first);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(monitor.port, mock.port);
  await assert.rejects(monitor.connect({ onFrame() {} }), /odpojuje/);
  release();
  await first;
  assert.equal(mock.closeCalls, 1);
  assert.equal(monitor.port, null);
});

test('USB UART pending chooser cannot create parallel connections and aborting never opens the port', async () => {
  const mock = serialMock();
  let choose;
  const monitor = new TulSerialMonitor({ requestPort: () => new Promise(resolve => { choose = resolve; }) });
  const pending = monitor.connect({ onFrame() {} });
  await assert.rejects(monitor.connect({ onFrame() {} }), /připojuje/);
  await monitor.disconnect();
  choose(mock.port);
  await assert.rejects(pending, /ukončeno/);
  assert.equal(mock.openCalls, 0);
});

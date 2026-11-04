import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MosfetMonitor } from '../src/mosfet-diagnostics.js';

function producer(monitor, scope = 'gpio') {
  let seq = 0;
  return (timeMs, fet1 = 0, fet2 = 0, arrivalMs = timeMs) =>
    monitor.push(`MOSFET,1,${scope},${seq++},${Math.round(timeMs * 1000)},${fet1},${fet2}\n`, arrivalMs);
}

function completeBoth(monitor, scope = 'gpio') {
  const send = producer(monitor, scope);
  send(0); send(10, 1); send(60, 1); send(110);
  send(120, 0, 1); send(170);
  return monitor.snapshot(170);
}

test('CAN text cannot stand in for explicit output telemetry', () => {
  const monitor = new MosfetMonitor();
  const state = monitor.push('ID is 1638\nData byte 6 = 2\nFET1 on\n', 0);
  assert.equal(state.status, 'waiting');
  assert.equal(state.received, 0);
  assert.equal(state.scope, null);
  assert.equal(state.fet1, null);
  assert.ok(state.checks.every(check => check.passed === null));
  assert.equal(state.checks.at(-1).detail, 'Stav výstupů není znám.');
});

test('streamed protocol waits for complete records and accepts CRLF split across reads', () => {
  const monitor = new MosfetMonitor();
  monitor.push('MOSF', 0);
  monitor.push('ET,1,gpio,0,0,0', 0);
  assert.equal(monitor.snapshot(0).received, 0);
  monitor.push(',0\r', 0);
  monitor.push('\nMOSFET,1,gpio,1,10000,1,0\r\n', 10);
  const state = monitor.snapshot(10);
  assert.equal(state.status, 'monitoring');
  assert.equal(state.received, 2);
  assert.equal(state.fet1, true);
  assert.equal(state.fet2, false);
});

test('both complete 100ms/50ms pulses pass observed timing with explicit GPIO limitation', () => {
  const state = completeBoth(new MosfetMonitor());
  assert.equal(state.status, 'pass');
  assert.equal(state.scope, 'gpio');
  assert.deepEqual(state.channels.map(channel => channel.durationsMs), [[100], [50]]);
  assert.deepEqual(state.channels.map(channel => channel.pulses), [1, 1]);
  assert.ok(state.checks.every(check => check.passed === true));
  assert.match(state.summary, /řídicího registru GPIO/);
  assert.match(state.summary, /nepotvrzuje/);
});

test('independent load feedback has distinct scope and cannot be mistaken for GPIO', () => {
  const state = completeBoth(new MosfetMonitor(), 'load');
  assert.equal(state.status, 'pass');
  assert.equal(state.scope, 'load');
  assert.match(state.summary, /externího měřicího zařízení/);
});

test('a channel not exercised and a still-active pulse never pass', () => {
  const monitor = new MosfetMonitor();
  const send = producer(monitor);
  send(0); send(10, 1); send(60);
  assert.equal(monitor.snapshot(60).status, 'monitoring');
  send(70, 0, 1);
  assert.equal(monitor.snapshot(70).status, 'monitoring');
  assert.equal(monitor.snapshot(70).checks.at(-1).passed, null);
});

test('overlapping outputs fail immediately and remain faults after both go low', () => {
  const monitor = new MosfetMonitor();
  const send = producer(monitor);
  send(0); send(10, 1, 1); send(60);
  assert.equal(monitor.snapshot(60).status, 'fail');
  assert.ok(monitor.snapshot(60).issues.some(issue => /současně/.test(issue)));
  monitor.reset();
  assert.equal(monitor.snapshot(60).status, 'waiting');
});

test('heartbeat detects an output held on too long before a falling edge arrives', () => {
  const monitor = new MosfetMonitor();
  const send = producer(monitor);
  send(0); send(10, 1); send(60, 1); send(110, 1);
  assert.equal(monitor.snapshot(110).status, 'monitoring');
  send(121, 1);
  assert.equal(monitor.snapshot(121).status, 'fail');
  assert.match(monitor.snapshot(121).issues.join(' '), /zůstává aktivní/);
  assert.equal(monitor.snapshot(121).channels[0].pulses, 0);
});

test('wrong complete pulse duration fails while configured tolerance is honored', () => {
  const failed = new MosfetMonitor();
  const send = producer(failed);
  send(0); send(10, 1); send(35);
  assert.equal(failed.snapshot(35).status, 'fail');
  assert.deepEqual(failed.snapshot(35).channels[0].durationsMs, [25]);
  const custom = new MosfetMonitor({ actuationMs: 80, neutralActuationMs: 40, toleranceMs: 2 });
  const next = producer(custom);
  next(0); next(1, 1); next(83); next(90, 0, 1); next(128);
  assert.equal(custom.snapshot(128).status, 'pass');
});

test('active first record is partial and can never establish a full pulse', () => {
  const monitor = new MosfetMonitor();
  const send = producer(monitor);
  send(0, 1); send(50); send(60, 0, 1); send(110);
  const state = monitor.snapshot(110);
  assert.equal(state.status, 'inconclusive');
  assert.equal(state.channels[0].pulses, 0);
  assert.equal(state.channels[1].pulses, 1);
});

test('missing heartbeat goes stale without claiming that an output switched off', () => {
  const monitor = new MosfetMonitor();
  const send = producer(monitor);
  send(0); send(10, 1);
  assert.equal(monitor.snapshot(1010).status, 'monitoring');
  const state = monitor.snapshot(1011);
  assert.equal(state.status, 'stale');
  assert.equal(state.fet1, true);
  assert.equal(state.ageMs, 1001);
  assert.equal(state.channels[0].pulses, 0);
});

test('stale and disconnected statuses preserve previous definite faults', () => {
  const monitor = new MosfetMonitor();
  const send = producer(monitor);
  send(0); send(10, 1, 1);
  assert.equal(monitor.snapshot(2000).status, 'stale');
  assert.ok(monitor.snapshot(2000).checks.some(check => check.passed === false));
  monitor.disconnect();
  assert.equal(monitor.snapshot(2000).status, 'disconnected');
  send(20, 0, 0, 2001);
  assert.equal(monitor.snapshot(2001).status, 'fail');
});

test('sequence loss discards an open pulse instead of manufacturing its duration', () => {
  const monitor = new MosfetMonitor();
  monitor.push('MOSFET,1,gpio,0,0,0,0\nMOSFET,1,gpio,1,10000,1,0\n', 0);
  const state = monitor.push('MOSFET,1,gpio,3,110000,0,0\n', 110);
  assert.equal(state.status, 'inconclusive');
  assert.equal(state.channels[0].pulses, 0);
  assert.deepEqual(state.channels[0].durationsMs, []);
});

test('board restart, duplicate sequence and nonmonotonic device time break continuity', () => {
  for (const record of ['0,20000', '1,20000', '2,10000', '2,0']) {
    const monitor = new MosfetMonitor();
    monitor.push('MOSFET,1,gpio,0,0,0,0\nMOSFET,1,gpio,1,10000,1,0\n', 10);
    const state = monitor.push(`MOSFET,1,gpio,${record},0,0\n`, 20);
    assert.equal(state.status, 'inconclusive', record);
    assert.equal(state.channels[0].pulses, 0, record);
  }
});

test('contiguous sequence cannot hide a producer pause in device time', () => {
  const monitor = new MosfetMonitor();
  monitor.push('MOSFET,1,gpio,0,0,0,0\nMOSFET,1,gpio,1,10000,1,0\n', 10);
  const state = monitor.push('MOSFET,1,gpio,2,500000,0,0\n', 500);
  assert.equal(state.status, 'inconclusive');
  assert.equal(state.channels[0].pulses, 0);
  assert.match(state.issues.join(' '), /mezera/);
});

test('arrival-time outage breaks pulses even if the producer clock appears continuous', () => {
  const monitor = new MosfetMonitor();
  monitor.push('MOSFET,1,gpio,0,0,0,0\nMOSFET,1,gpio,1,10000,1,0\n', 10);
  const state = monitor.push('MOSFET,1,gpio,2,110000,0,0\n', 2000);
  assert.equal(state.status, 'inconclusive');
  assert.equal(state.channels[0].pulses, 0);
});

test('malformed prefixed records are rejected and break pulse continuity', () => {
  for (const invalid of [
    'MOSFET,2,gpio,2,100000,0,0', 'MOSFET,1,pin,2,100000,0,0',
    'MOSFET,1,gpio,-2,100000,0,0', 'MOSFET,1,gpio,2,1.5,0,0',
    'MOSFET,1,gpio,9007199254740992,100000,0,0',
    'MOSFET,1,gpio,2,100000,2,0', 'MOSFET,1,gpio,2,100000,true,0',
    'MOSFET,1,gpio,2,100000,0,0,extra', 'MOSFETgarbage',
  ]) {
    const monitor = new MosfetMonitor();
    monitor.push('MOSFET,1,gpio,0,0,0,0\nMOSFET,1,gpio,1,10000,1,0\n', 10);
    monitor.push(invalid + '\n', 20);
    const state = monitor.push('MOSFET,1,gpio,2,110000,0,0\n', 110);
    assert.equal(state.status, 'inconclusive', invalid);
    assert.equal(state.received, 3, invalid);
    assert.equal(state.channels[0].pulses, 0, invalid);
  }
});

test('oversized lines are dropped with bounded tail and parser recovers at newline', () => {
  const monitor = new MosfetMonitor();
  monitor.push('MOSFET' + 'x'.repeat(100000), 0);
  assert.equal(monitor.snapshot(0).status, 'inconclusive');
  assert.equal(monitor._tail.length, 0);
  monitor.push('\nMOSFET,1,gpio,0,0,0,0\n', 0);
  assert.equal(monitor.snapshot(0).received, 1);
  const plain = new MosfetMonitor();
  plain.push('x'.repeat(100000) + '\n', 0);
  assert.equal(plain.snapshot(0).status, 'waiting');
});

test('disconnect discards incomplete input, open pulses and previous segment coverage', () => {
  const monitor = new MosfetMonitor();
  completeBoth(monitor);
  monitor.push('MOSFET,1,gpio,6,180000,1', 180);
  monitor.disconnect();
  let state = monitor.snapshot(180);
  assert.equal(state.status, 'disconnected');
  assert.equal(state.fet1, null);
  assert.equal(state.channels[0].pulses, 1);
  monitor.push(',0\nMOSFET,1,gpio,0,0,0,0\n', 181);
  state = monitor.snapshot(181);
  assert.equal(state.received, 7);
  assert.equal(state.status, 'inconclusive');
  assert.equal(state.checks.find(check => check.name === 'FET1: dokončený pulz').passed, null);
});

test('switching gpio/load producers invalidates a combined result', () => {
  const monitor = new MosfetMonitor();
  completeBoth(monitor);
  const state = monitor.push('MOSFET,1,load,0,0,0,0\n', 180);
  assert.equal(state.scope, 'load');
  assert.equal(state.status, 'inconclusive');
  assert.equal(state.checks.find(check => check.name === 'FET2: dokončený pulz').passed, null);
});

test('history and issue buffers are bounded while pulse counters and faults survive', () => {
  const monitor = new MosfetMonitor();
  const send = producer(monitor);
  send(0);
  for (let index = 0; index < 50; index++) {
    send(index * 100 + 1, 1); send(index * 100 + 51);
  }
  let state = monitor.snapshot(4951);
  assert.equal(state.channels[0].pulses, 50);
  assert.equal(state.channels[0].durationsMs.length, 20);
  for (let index = 0; index < 50; index++) monitor.push(`MOSFET,1,gpio,${1000 + index},${10000000 + index},1,1\n`, 5000);
  state = monitor.snapshot(5000);
  assert.ok(state.issues.length <= 30);
  assert.equal(state.status, 'fail');
  const snapshot = monitor.snapshot(5000);
  snapshot.channels[0].durationsMs.push(123);
  snapshot.issues.push('external mutation');
  assert.equal(monitor.snapshot(5000).channels[0].durationsMs.length, 20);
  assert.ok(!monitor.snapshot(5000).issues.includes('external mutation'));
});

test('invalid options/arrival times are rejected and reset can change timing', () => {
  for (const options of [{ staleMs: 0 }, { toleranceMs: -1 }, { actuationMs: Infinity }, null]) {
    assert.throws(() => new MosfetMonitor(options));
  }
  const monitor = new MosfetMonitor({ toleranceMs: 0 });
  assert.throws(() => monitor.push('text', NaN));
  assert.throws(() => monitor.snapshot(-1));
  monitor.reset({ actuationMs: 80 });
  assert.equal(monitor.options.actuationMs, 80);
  monitor.reset();
  assert.equal(monitor.options.actuationMs, 80);
});

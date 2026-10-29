import test from 'node:test';
import assert from 'node:assert/strict';
import { ShiftingUnit } from '../src/shifting-unit.js';
import { TUL_PROTOCOL_FACTS } from '../src/tul-protocol.js';

const request = (documentedByte, legacyByte = 0) => ({ id: 0x642, extended: false, rtr: false, data: [legacyByte, 0, 0, 0, documentedByte, 0, 0, 0] });
const gearFrame = (gear) => ({ id: 0x604, data: [gear] });
const rpmFrame = (...data) => ({ id: 0x666, data });
const release = (unit, count = 3) => { for (let i = 0; i < count; i++) unit.receive(request(0)); };
const ready = (gear = 1, rpm = 8500, options = {}) => {
  const unit = new ShiftingUnit({ protocol: 'legacy', ...options });
  unit.advance(300, { gear, rpm });
  return unit;
};

test('uses exact header ratios, limits and initial cooldown', () => {
  const unit = new ShiftingUnit({ protocol: 'legacy' });
  assert.equal(unit.config.ratios.length, 7);
  assert.equal(unit.config.ratios[0], (500 * 39 / 14) / 4000);
  assert.equal(unit.config.ratios[1], 39 / 14);
  assert.equal(unit.config.ratios[6], 26 / 22);
  assert.equal(unit.state.cooldownMs, 300);
  assert.equal(unit.receive(request(2)).accepted, false);
  assert.equal(unit.state.shiftingFlag, 1);
  assert.equal(unit.state.fet1, false);
  assert.equal(unit.state.fet2, false);
});

test('reference upshift uses data[4], pulses FET2 for 100ms and waits for sensor feedback', () => {
  const unit = ready();
  const result = unit.receive(request(2, 0));
  assert.deepEqual(result, { accepted: true, reason: 'Impulz řazení 1 → 2.', targetGear: 2, pulseMs: 100, direction: 'up' });
  assert.equal(unit.state.fet2, true);
  assert.equal(unit.state.fet1, false);
  assert.equal(unit.state.busy, true);
  unit.advance(99);
  assert.equal(unit.state.fet2, true);
  assert.equal(unit.state.remainingMs, 1);
  unit.advance(1);
  assert.equal(unit.state.busy, false);
  assert.equal(unit.state.fet2, false);
  assert.equal(unit.state.currentGear, 1);
  unit.receive(gearFrame(2));
  assert.equal(unit.state.currentGear, 2);
});

test('neutral-to-first uses FET1 and the header neutral ratio has a strict 500rpm threshold', () => {
  const exact = ready(0, 500);
  assert.equal(exact.receive(request(2)).accepted, false);
  const above = ready(0, 501);
  assert.equal(above.receive(request(2)).accepted, true);
  assert.equal(above.state.fet1, true);
  assert.equal(above.state.fet2, false);
});

test('requires three consecutive zero-request frames and another nonzero resets release count', () => {
  const unit = ready();
  assert.equal(unit.receive(request(2)).accepted, true);
  unit.advance(300, { gear: 2, rpm: 8500 });
  release(unit, 2);
  assert.equal(unit.state.shiftingFlag, 3);
  assert.equal(unit.receive(request(2)).accepted, false);
  assert.equal(unit.state.shiftingFlag, 1);
  release(unit, 2);
  assert.notEqual(unit.state.shiftingFlag, 0);
  release(unit, 1);
  assert.equal(unit.state.shiftingFlag, 0);
  assert.equal(unit.receive(request(2)).accepted, true);
});

test('cooldown consumes rejected commands before RPM validation, and failed nonzero latches', () => {
  const unit = ready(1, 2000);
  assert.equal(unit.receive(request(2)).accepted, false);
  assert.equal(unit.state.cooldownMs, 300);
  assert.equal(unit.state.shiftingFlag, 1);
  release(unit);
  unit.advance(299, { rpm: 8500 });
  assert.equal(unit.receive(request(2)).accepted, false);
  assert.equal(unit.state.cooldownMs, 1);
  unit.advance(1);
  assert.equal(unit.receive(request(2)).accepted, false);
  release(unit);
  assert.equal(unit.receive(request(2)).accepted, true);
});

test('rejects low upshift RPM and high projected downshift RPM with strict limits', () => {
  const lowerBoundary = 4000 * TUL_PROTOCOL_FACTS.ratios[1] / TUL_PROTOCOL_FACTS.ratios[2];
  const under = ready(1, lowerBoundary - 1);
  assert.equal(under.receive(request(2)).accepted, false);
  const over = ready(2, 13000);
  assert.equal(over.receive(request(1)).accepted, false);
  assert.equal(over.state.fet1, false);
  const valid = ready(2, 7000);
  assert.equal(valid.receive(request(1)).accepted, true);
  assert.equal(valid.state.fet1, true);
});

test('neutral uses a 50ms pulse with direction determined by current gear', () => {
  for (const [gear, fet] of [[1, 2], [2, 1]]) {
    const unit = ready(gear, 5999);
    const decision = unit.receive(request(0x40));
    assert.equal(decision.accepted, true);
    assert.equal(decision.targetGear, 0);
    assert.equal(decision.pulseMs, 50);
    assert.equal(unit.state[`fet${fet}`], true);
    unit.advance(50);
    assert.equal(unit.state.fet1, false);
    assert.equal(unit.state.fet2, false);
  }
  assert.equal(ready(1, 6000).receive(request(0x40)).accepted, false);
  assert.equal(ready(3, 1000).receive(request(0x40)).accepted, false);
});

test('sensor value7 retains last valid gear but cannot select neutral', () => {
  const unit = ready(2, 8000);
  unit.receive(gearFrame(7));
  assert.equal(unit.state.currentGear, 7);
  assert.equal(unit.state.lastValidGear, 2);
  assert.equal(unit.receive(request(1)).accepted, true);
  unit.advance(300, { rpm: 3000 });
  release(unit);
  assert.equal(unit.receive(request(0x40)).accepted, false);
  assert.equal(unit.state.currentGear, 7);
  assert.equal(unit.state.lastValidGear, 2);
  unit.receive(gearFrame(255));
  assert.equal(unit.state.currentGear, 7);
});

test('never guesses a result from firmware out-of-bounds ratio indexing', () => {
  for (const mode of ['reference', 'firmware-parser']) {
    const highest = ready(6, 10000, { mode });
    highest.receive(rpmFrame(255));
    const up = highest.receive(request(2, 2));
    assert.equal(up.accepted, false);
    assert.match(up.reason, /mimo pole/);
    const neutral = ready(0, 10000, { mode });
    const down = neutral.receive(request(1, 1));
    assert.equal(down.accepted, false);
    assert.match(down.reason, /mimo pole/);
  }
});

test('firmware parser preserves byte mismatch rather than silently copying data[4] into data[0]', () => {
  const unit = ready(2, 8500, { mode: 'firmware-parser' });
  unit.receive(rpmFrame(200));
  const documented = unit.receive(request(1, 0));
  assert.equal(documented.accepted, false);
  assert.match(documented.reason, /data\[0\]/);
  release(unit);
  unit.advance(300);
  const legacy = unit.receive(request(2, 1));
  assert.equal(legacy.accepted, true);
  assert.equal(legacy.direction, 'down');
  assert.equal(legacy.targetGear, 1);
  assert.equal(unit.state.fet1, true);
});

test('data[0] alone cannot activate request; firmware RPM is one byte and cannot upshift even from neutral', () => {
  const unit = ready(0, 8500, { mode: 'firmware-parser' });
  unit.receive(rpmFrame(255, 255));
  unit.advance(0, { rpm: 12500 });
  assert.equal(unit.state.rpm, 255);
  assert.equal(unit.receive(request(0, 2)).accepted, false);
  assert.equal(unit.state.shiftingFlag, 0);
  const result = unit.receive(request(2, 2));
  assert.equal(result.accepted, false);
  assert.match(result.reason, /otáčky/);
  assert.equal(unit.state.fet1, false);
});

test('reference does not invent ECU RPM encoding from placeholder0x666', () => {
  const unit = ready(1, 8500);
  unit.receive(rpmFrame(255, 255));
  assert.equal(unit.state.rpm, 8500);
  assert.equal(unit.receive(request(2)).accepted, true);
});

const currentRequest = (command, sharedFlags = 0) => ({ id: 0x666, data: [0, 0, 0, 0, 0, 0, command | sharedFlags, 0] });

test('current-car is the default protocol and reads full unsigned16 little-endian RPM from0x600', () => {
  const unit = new ShiftingUnit();
  assert.equal(unit.config.protocol, 'current-car');
  assert.equal(unit.effectiveProtocol, 'current-car');
  unit.receive({ id: 0x600, data: [0x34, 0x12] });
  assert.equal(unit.state.rpm, 0x1234);
  unit.receive({ id: 0x600, data: [0xff, 0xff] });
  assert.equal(unit.state.rpm, 65535);
  unit.receive({ id: 0x600, data: [0] });
  assert.equal(unit.state.rpm, 65535);
  unit.advance(0, { rpm: 8500, gear: 1 });
  assert.equal(unit.state.rpm, 8500);
});

test('current-car uses request0x666 byte6 and preserves other fields instead of treating StandBy/resetFuel as commands', () => {
  const unit = ready(1, 8500, { protocol: 'current-car' });
  assert.equal(unit.receive(request(2)), null);
  assert.equal(unit.receive(currentRequest(2, 0x3c)).accepted, true);
  assert.equal(unit.state.fet2, true);
  assert.equal(unit.state.lastDecision.targetGear, 2);
  unit.advance(300, { gear: 2, rpm: 8500 });
  for (let i = 0; i < 3; i++) unit.receive(currentRequest(0, 0x3c));
  assert.equal(unit.state.shiftingFlag, 0);
  assert.equal(unit.receive(currentRequest(1, 0x3c)).accepted, true);
  assert.equal(unit.state.fet1, true);
  assert.equal(unit.state.lastDecision.targetGear, 1);
});

test('current-car can use actual600RPM with assumed neutral code and flags without direct RPM injection', () => {
  const unit = new ShiftingUnit();
  unit.advance(300, { gear: 2 });
  unit.receive({ id: 0x600, data: [0x6f, 0x17] }); //5999rpm
  assert.equal(unit.state.rpm, 5999);
  assert.equal(unit.receive(currentRequest(0x40, 0x3c)).accepted, true);
  assert.equal(unit.state.fet1, true);
  assert.equal(unit.state.remainingMs, 50);
});

test('firmware-parser always uses actual sourcelegacy IDs, never silently adapts current-car frames', () => {
  const unit = new ShiftingUnit({ mode: 'firmware-parser' });
  assert.equal(unit.config.protocol, 'current-car');
  assert.equal(unit.effectiveProtocol, 'legacy');
  unit.advance(300, { gear: 1, rpm: 8500 });
  unit.receive({ id: 0x600, data: [0x34, 0x12] });
  assert.equal(unit.state.rpm, 0);
  // Existing firmware interprets currentcar0x666 as its TODO RPM message;
  // it does not read byte6 as a paddle request.
  assert.equal(unit.receive(currentRequest(2)), null);
  assert.equal(unit.state.rpm, 0);
  assert.equal(unit.state.shiftingFlag, 0);
  assert.equal(unit.state.fet1, false);
  assert.equal(unit.state.fet2, false);
});

test('never energizes both outputs even if cooldown is shorter than actuator pulse', () => {
  const unit = ready(2, 8500, { minimumDelayMs: 0 });
  assert.equal(unit.receive(request(1)).accepted, true);
  release(unit);
  assert.equal(unit.receive(request(2)).accepted, false);
  assert.equal(unit.state.fet1, true);
  assert.equal(unit.state.fet2, false);
  unit.advance(100);
  release(unit);
  assert.equal(unit.receive(request(2)).accepted, true);
  assert.equal(unit.state.fet1, false);
  assert.equal(unit.state.fet2, true);
});

test('validates configuration, rejects malformed requests, copies snapshots and resets safely', () => {
  assert.throws(() => new ShiftingUnit({ mode: 'fake' }), /režim/);
  assert.throws(() => new ShiftingUnit({ actuationMs: -1 }), /čas/);
  assert.throws(() => new ShiftingUnit({ ratios: [0] }), /sedm/);
  assert.throws(() => new ShiftingUnit({ toString: true }), /Neznámý/);
  const unit = ready();
  assert.equal(unit.receive({ id: 0x642, data: [2] }).accepted, false);
  assert.equal(unit.state.shiftingFlag, 0);
  unit.receive(request(2));
  assert.equal(unit.receive({ ...request(2), extended: true }), null);
  assert.equal(unit.receive({ ...request(2), fd: true }), null);
  const before = unit.state;
  unit.advance(-100, { gear: 6, rpm: 10 });
  unit.advance(NaN);
  assert.deepEqual(unit.state, before);
  const copy = unit.state;
  copy.lastDecision.accepted = false;
  assert.equal(unit.state.lastDecision.accepted, true);
  assert.throws(() => unit.configure({ actuationMs: NaN }), /čas/);
  assert.deepEqual(unit.state, before);
  unit.reset();
  assert.equal(unit.state.fet1, false);
  assert.equal(unit.state.fet2, false);
  assert.equal(unit.state.busy, false);
  assert.equal(unit.state.rpm, 0);
  assert.equal(unit.state.cooldownMs, 300);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import * as tul from '../src/tul-protocol.js';
import { validateProfile } from '../src/can.js';

const { TUL_PROTOCOL_FACTS: facts, TUL_LEGACY_CAN_PROFILE: profile, makeTulGear } = tul;
const makeTulRequest = command => tul.makeTulRequest(command, { protocol: 'legacy' });
const decodeTulFrame = frame => tul.decodeTulFrame(frame, { protocol: 'legacy' });
const analyzeTulRequest = frame => tul.analyzeTulRequest(frame, { protocol: 'legacy' });

test('source facts preserve exact identifiers, 1Mbps, timings, limits and all seven ratio entries', () => {
  assert.equal(facts.bitrate, 1000000);
  assert.deepEqual(facts.ids, { request: 0x642, gear: 0x604, rpm: 0x666 });
  assert.deepEqual(facts.timing, { actuationMs: 100, neutralActuationMs: 50, minimumDelayMs: 300, rearmZeroFrames: 3 });
  assert.deepEqual(facts.limits, { upperRpm: 14000, lowerRpm: 4000, neutralRpm: 6000 });
  assert.deepEqual(facts.ratios, [(500 * 39 / 14) / 4000, 39 / 14, 39 / 19, 37 / 22, 29 / 20, 30 / 23, 26 / 22]);
  assert.equal(facts.physicalRpmMappingKnown, false);
  assert.equal(facts.actualDlcKnown, false);
  assert.match(facts.evidence.rawRpmByte, /shifting\.cpp:48/);
});

test('generic profile validates and never emits invented periodic RPM telemetry', () => {
  assert.deepEqual(validateProfile(profile), profile);
  assert.equal(profile.isDemo, false);
  assert.equal(profile.bitrate, 1000000);
  assert.ok(profile.frames.every(frame => frame.trigger === 'receive'));
  assert.deepEqual(profile.frames.map(frame => [frame.id, frame.dlc]), [[0x642, 5], [0x604, 1], [0x666, 1]]);
  assert.equal(profile.frames[2].signals[0].name, 'rawRpmByte');
});

test('request golden vectors use byte4 only and the exact minimal five-byte payload', () => {
  for (const [command, value] of [['release', 0], ['down', 1], ['up', 2], ['neutral', 0x40]]) {
    assert.deepEqual(makeTulRequest(command), { id: 0x642, extended: false, data: [0, 0, 0, 0, value] });
  }
  for (const command of [null, 1, 'UP', 'reset', '__proto__']) assert.throws(() => makeTulRequest(command));
});

test('gear golden vectors include explicit between-gears state and reject invalid generators', () => {
  for (let gear = 0; gear <= 7; gear++) assert.deepEqual(makeTulGear(gear), { id: 0x604, extended: false, data: [gear] });
  for (const gear of [-1, 8, 1.5, '1', NaN]) assert.throws(() => makeTulGear(gear));
});

test('source decoder accepts minimal and padded request frames without assuming actual DLC', () => {
  const frame = makeTulRequest('up');
  assert.deepEqual(decodeTulFrame(frame), { commandRaw: 2, legacyCommandRaw: 0 });
  assert.deepEqual(decodeTulFrame({ ...frame, data: [1, 9, 8, 7, 2, 6, 5, 4] }), { commandRaw: 2, legacyCommandRaw: 1 });
  assert.throws(() => decodeTulFrame({ ...frame, data: [0, 0, 0, 2] }), /nejméně 5/);
});

test('gear and raw-RPM decoding accept one through eight bytes; RPM never becomes physical rpm', () => {
  for (const tail of [[], [0, 1, 2, 3, 4, 5, 6]]) {
    assert.deepEqual(decodeTulFrame({ id: 0x604, data: [7, ...tail] }), { gear: 7 });
    assert.deepEqual(decodeTulFrame({ id: 0x666, data: [255, ...tail] }), { rawRpmByte: 255 });
  }
  assert.throws(() => tul.makeTulRpm(9000, { protocol: 'legacy' }), /nemá doložené/);
  assert.equal(Object.hasOwn(decodeTulFrame({ id: 0x666, data: [0x36, 0xB0] }), 'rpm'), false);
  assert.deepEqual(decodeTulFrame({ id: 0x604, data: [255] }), { gear: 255 }); // Preserve invalid feedback for diagnostics.
});

test('malformed payloads fail rather than reading undefined bytes or truncating CAN FD', () => {
  for (const frame of [
    null, { id: 0x642, data: '0000000002' }, { id: 0x604, data: [] }, { id: 0x666, data: [] },
    { id: 0x642, data: Array(9).fill(0) }, { id: 0x604, data: [256] }, { id: 0x604, data: [-1] },
    { id: 0x604, data: [NaN] }, { id: 0x604, data: [1.5] }, { id: 0x800, data: [1] },
    { id: 0x604, extended: 'false', data: [1] }, { id: 0x604, rtr: true, data: [1] },
  ]) assert.throws(() => decodeTulFrame(frame));
});

test('unrelated or extended frames do not falsely match the standard protocol profile', () => {
  assert.deepEqual(decodeTulFrame({ id: 0x123, data: [] }), {});
  assert.deepEqual(decodeTulFrame({ id: 0x642, extended: true, data: [0, 0, 0, 0, 2] }), {});
  assert.equal(analyzeTulRequest({ id: 0x604, data: [2] }), null);
});

test('documented UP/DOWN requests expose the actual byte-zero firmware discrepancy', () => {
  for (const command of ['up', 'down']) {
    const result = analyzeTulRequest(makeTulRequest(command));
    assert.equal(result.command, command);
    assert.equal(result.legacyCommand, 'unknown');
    assert.equal(result.legacyByte, 0);
    assert.equal(result.active, true);
    assert.equal(result.release, false);
    assert.match(result.discrepancy, /data\[4\].*data\[0\]/);
    assert.equal(result.warnings.length, 1);
  }
});

test('actual branching is reported independently when byte zero selects another direction', () => {
  const result = analyzeTulRequest({ id: 0x642, data: [1, 0, 0, 0, 2] });
  assert.equal(result.command, 'up');
  assert.equal(result.legacyCommand, 'down');
  assert.equal(result.documentedByte, 2);
  assert.match(result.discrepancy, /down/);
});

test('neutral equality overrides byte zero; release closes the request gate', () => {
  const neutral = analyzeTulRequest({ id: 0x642, data: [2, 0, 0, 0, 0x40] });
  assert.equal(neutral.command, 'neutral');
  assert.equal(neutral.legacyCommand, 'neutral');
  assert.equal(neutral.discrepancy, null);
  const release = analyzeTulRequest({ id: 0x642, data: [2, 0, 0, 0, 0] });
  assert.equal(release.command, 'release');
  assert.equal(release.legacyCommand, 'release');
  assert.equal(release.active, false);
  assert.equal(release.release, true);
  assert.deepEqual(release.warnings, []);
});

test('0x40 is an equality test, not an inferred bitmask or arbitrary reset command', () => {
  const result = analyzeTulRequest({ id: 0x642, data: [2, 0, 0, 0, 0x41] });
  assert.equal(result.command, 'unknown');
  assert.equal(result.legacyCommand, 'up');
  assert.equal(result.active, true);
  assert.ok(result.discrepancy);
});

test('current-car screenshot map is distinct from retained firmware facts', () => {
  const current = tul.CURRENT_CAR_PROTOCOL;
  assert.deepEqual(current.ids, { request: 0x666, gear: 0x604, rpm: 0x600 });
  assert.equal(current.commandByte, 6);
  assert.equal(current.rpmByteLength, 2);
  assert.equal(current.rpmLittleEndian, true);
  assert.equal(current.requestMask, 0x43);
  assert.equal(current.rpmMappingVerified, true);
  assert.equal(current.commandInterpretationVerified, false);
  assert.equal(current.requestMaskVerified, false);
  assert.equal(facts.currentCar, current);
  assert.equal(facts.ids, tul.LEGACY_TUL_PROTOCOL.ids);
  assert.notDeepEqual(facts.ids, current.ids);
});

test('default profile describes current ECU/steering IDs while old profile remains separately selectable', () => {
  assert.deepEqual(validateProfile(tul.TUL_CAN_PROFILE), tul.TUL_CAN_PROFILE);
  assert.deepEqual(tul.TUL_CAN_PROFILE.frames.map(f => [f.id, f.dlc, f.trigger]), [[0x666, 8, 'receive'], [0x604, 8, 'receive'], [0x600, 8, 'receive']]);
  const rpm = tul.TUL_CAN_PROFILE.frames[2].signals[0];
  assert.deepEqual([rpm.startByte, rpm.byteLength, rpm.scale, rpm.offset, rpm.littleEndian, rpm.signed], [0, 2, 1, 0, true, false]);
  assert.equal(tul.TUL_CAN_PROFILE.frames[0].signals[0].startByte, 6);
});

test('current request golden vectors use byte6, eight bytes and no firmware byte-zero mirroring', () => {
  for (const [command, value] of [['release', 0], ['down', 1], ['up', 2], ['neutral', 0x40]]) {
    assert.deepEqual(tul.makeTulRequest(command), { id: 0x666, extended: false, data: [0, 0, 0, 0, 0, 0, value, 0] });
    assert.ok(tul.analyzeTulRequest(tul.makeTulRequest(command)).assumption);
  }
  assert.throws(() => tul.makeTulRequest('up', { protocol: 'guessed' }), /Neznámý/);
});

test('screenshot byte0x08 is resetFuel2 and release under the explicitly hypothetical command mask', () => {
  const screenshot = { id: 0x666, data: [0x00, 0x14, 0xdc, 0x01, 0x08, 0x00, 0x08, 0x00] };
  assert.deepEqual(tul.decodeTulFrame(screenshot), { commandRaw: 8, maskedCommand: 0, standBy: 0, resetFuel: 2, unknownBits: 0, unknownFlag: false });
  const result = tul.analyzeTulRequest(screenshot);
  assert.equal(result.command, 'release');
  assert.equal(result.documentedByte, 8);
  assert.equal(result.release, true);
  assert.equal(result.active, false);
  assert.equal(result.commandInterpretationVerified, false);
  assert.match(result.assumption, /hypotéza/);
  const up = tul.makeTulRequest('up', { baseData: screenshot.data });
  assert.deepEqual(up.data, [0x00, 0x14, 0xdc, 0x01, 0x08, 0x00, 0x0a, 0x00]);
  assert.equal(screenshot.data[6], 8);
});

test('command generation preserves standby, fuel, unknown bit7 and all other frame bytes', () => {
  const base = [1, 2, 3, 4, 5, 6, 0xa8, 7];
  for (const [command, commandBits] of [['release', 0], ['down', 1], ['up', 2], ['neutral', 0x40]]) {
    const frame = tul.makeTulRequest(command, { baseData: base });
    assert.equal(frame.data[6], 0xa8 | commandBits);
    assert.deepEqual(frame.data.slice(0, 6), base.slice(0, 6));
    assert.equal(frame.data[7], 7);
    const decoded = tul.decodeTulFrame(frame);
    assert.equal(decoded.standBy, 1);
    assert.equal(decoded.resetFuel, 2);
    assert.equal(decoded.unknownBits, 0x80);
    assert.equal(decoded.unknownFlag, true);
    assert.match(tul.analyzeTulRequest(frame).warnings[1], /bit7/);
  }
  assert.deepEqual(base, [1, 2, 3, 4, 5, 6, 0xa8, 7]);
  const released = tul.makeTulRequest('release', { baseData: [0, 0, 0, 0, 0, 0, 0x6a, 0] });
  assert.equal(released.data[6], 0x28);
  assert.equal(tul.analyzeTulRequest(released).release, true);
});

test('current RPM golden vectors are physical unsigned16 little-endian values', () => {
  for (const [rpm, bytes] of [[0, [0, 0]], [9000, [0x28, 0x23]], [14000, [0xb0, 0x36]], [65535, [255, 255]]]) {
    const frame = tul.makeTulRpm(rpm);
    assert.deepEqual(frame, { id: 0x600, extended: false, data: [...bytes, 0, 0, 0, 0, 0, 0] });
    assert.deepEqual(tul.decodeTulFrame(frame), { rpm });
  }
  assert.deepEqual(tul.decodeTulFrame({ id: 0x600, data: [0xb0, 0x36] }), { rpm: 14000 });
  assert.deepEqual(tul.decodeTulFrame(tul.makeTulRpm(1234.6)), { rpm: 1235 });
  const base = [1, 2, 3, 4, 5, 6, 7, 8];
  assert.deepEqual(tul.makeTulRpm(9000, { baseData: base }).data, [0x28, 0x23, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(base, [1, 2, 3, 4, 5, 6, 7, 8]);
  for (const rpm of [-1, 65536, NaN, Infinity, '9000']) assert.throws(() => tul.makeTulRpm(rpm));
});

test('current decoder accepts required fields in short frames but refuses truncated signals and oversized data', () => {
  assert.equal(tul.decodeTulFrame({ id: 0x666, data: [0, 0, 0, 0, 0, 0, 2] }).maskedCommand, 2);
  assert.equal(tul.decodeTulFrame({ id: 0x604, data: [3] }).gear, 3);
  for (const frame of [{ id: 0x666, data: [0, 0, 0, 0, 0, 2] }, { id: 0x600, data: [0] }, { id: 0x604, data: [] }, { id: 0x666, data: Array(9).fill(0) }]) assert.throws(() => tul.decodeTulFrame(frame));
  assert.deepEqual(tul.decodeTulFrame({ id: 0x642, data: [0, 0, 0, 0, 2] }), {});
  assert.equal(tul.analyzeTulRequest({ id: 0x600, data: [0, 0] }), null);
  assert.throws(() => tul.makeTulRequest('up', { baseData: Array(7).fill(0) }));
  assert.throws(() => tul.makeTulRpm(0, { baseData: [0, 0] }));
  assert.throws(() => tul.makeTulRequest('up', { baseData: Array(8).fill(-1) }));
});

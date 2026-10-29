import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_CAN_PROFILE, validateProfile, encodeFrame, decodeFrame,
  formatCandump, parseCandump, parseSlcanLine, encodeSlcanFrame,
} from '../src/can.js';

const single = (signal, overrides = {}) => ({
  name: 'Zkušební rámec', id: 0x100, dlc: 2, trigger: 'periodic', periodMs: 10,
  signals: [{ name: 'value', source: 'value', startByte: 0, byteLength: 2, scale: 1, offset: 0, signed: false, littleEndian: true, ...signal }],
  ...overrides,
});
const profileFor = (frame) => validateProfile({ name: 'Test', bitrate: 500000, frames: [frame] });

test('demo profile validates and is copied without mutating input', () => {
  const profile = validateProfile(DEMO_CAN_PROFILE);
  assert.equal(profile.frames.length, 2);
  assert.equal(profile.isDemo, true);
  assert.equal(profile.frames[0].id, 0x600);
  profile.frames[0].signals[0].name = 'changed';
  assert.equal(DEMO_CAN_PROFILE.frames[0].signals[0].name, 'rpm');
});

test('telemetry encodes and decodes meaningful physical values', () => {
  const def = DEMO_CAN_PROFILE.frames[0];
  const frame = encodeFrame(def, { rpm: 9321, speedKph: 123.45, gear: 4, throttle: 1, engineOn: true, coolantC: 86 });
  assert.deepEqual(frame.data, [0x69, 0x24, 0x39, 0x30, 4, 255, 1, 126]);
  const decoded = decodeFrame(frame, DEMO_CAN_PROFILE);
  assert.deepEqual(decoded, { rpm: 9321, speedKph: 123.45, gear: 4, throttle: 1, engineOn: 1, coolantC: 86 });
});

test('paddle request encodes separately from telemetry', () => {
  const frame = encodeFrame(DEMO_CAN_PROFILE.frames[1], { upshift: true, downshift: false, gear: 2 });
  assert.deepEqual(frame, { id: 0x601, extended: false, data: [1, 0, 2] });
  assert.deepEqual(decodeFrame(frame, DEMO_CAN_PROFILE), { upshift: 1, downshift: 0, gear: 2 });
});

test('unsigned little- and big-endian words', () => {
  for (const littleEndian of [true, false]) {
    const def = single({ littleEndian });
    const encoded = encodeFrame(def, { value: 0xABCD });
    assert.deepEqual(encoded.data, littleEndian ? [0xCD, 0xAB] : [0xAB, 0xCD]);
    assert.equal(decodeFrame(encoded, profileFor(def)).value, 0xABCD);
  }
});

test('signed two-complement values preserve extremes in both byte orders', () => {
  for (const littleEndian of [true, false]) {
    const def = single({ signed: true, littleEndian });
    for (const value of [-32768, -125, -1, 0, 32767]) {
      assert.equal(decodeFrame(encodeFrame(def, { value }), profileFor(def)).value, value);
    }
  }
});

test('noninteger scaling and offset quantize to nearest physical value', () => {
  const def = single({ scale: 0.1, offset: -40 });
  const frame = encodeFrame(def, { value: 12.34 });
  assert.deepEqual(frame.data, [0x0B, 0x02]);
  assert.ok(Math.abs(decodeFrame(frame, profileFor(def)).value - 12.3) < 1e-10);
});

test('overflow, negative unsigned, missing, NaN and Infinity values fail', () => {
  const def = single({});
  for (const value of [-1, 65536, 65535.1, NaN, Infinity, '12']) {
    assert.throws(() => encodeFrame(def, { value }));
  }
  assert.throws(() => encodeFrame(def, {}), /Chybí/);
  assert.throws(() => encodeFrame(single({ signed: true }), { value: -32769 }), /nevejde/);
});

test('eight-byte safe numeric values round-trip and unsafe integers fail', () => {
  const def = single({ byteLength: 8 }, { dlc: 8 });
  const value = Number.MAX_SAFE_INTEGER;
  assert.equal(decodeFrame(encodeFrame(def, { value }), profileFor(def)).value, value);
  assert.throws(() => encodeFrame(def, { value: value + 1 }), /přesný/);
  assert.throws(() => decodeFrame({ id: 0x100, data: Array(8).fill(255) }, profileFor(def)), /přesný/);
});

test('invalid CAN profile shapes, IDs, DLC, periods and scale fail', () => {
  for (const raw of [null, {}, [], { name: 'Test', bitrate: 500000, frames: [] }]) assert.throws(() => validateProfile(raw));
  for (const def of [single({}, { id: 2048 }), single({}, { id: -1 }), single({}, { dlc: 9 }), single({}, { periodMs: 0 }), single({ scale: 0 }), single({ scale: Infinity }), single({ byteLength: 3 }), single({ startByte: -1 }), single({}, { extended: 'false' })]) {
    assert.throws(() => profileFor(def));
  }
});

test('overlapping signals, duplicate names and duplicate frame IDs fail', () => {
  const def = single({});
  assert.throws(() => profileFor({ ...def, signals: [...def.signals, { ...def.signals[0], name: 'other' }] }), /překrývají/);
  assert.throws(() => profileFor({ ...def, signals: [...def.signals, { ...def.signals[0] }] }), /duplicitní/);
  assert.throws(() => validateProfile({ name: 'Test', bitrate: 500000, frames: [def, def] }), /duplicitní ID/);
  assert.throws(() => profileFor(single({ name: '__proto__' })), /název/);
  assert.throws(() => validateProfile({ ...DEMO_CAN_PROFILE, isDemo: 'false' }), /isDemo/);
});

test('known ID with wrong length fails; unknown ID does not decode', () => {
  assert.throws(() => decodeFrame({ id: 0x600, data: [0] }, DEMO_CAN_PROFILE), /DLC/);
  assert.deepEqual(decodeFrame({ id: 0x123, data: [0] }, DEMO_CAN_PROFILE), {});
  assert.deepEqual(decodeFrame({ id: 0x600, extended: true, data: [0] }, DEMO_CAN_PROFILE), {});
});

test('candump standard, extended and zero-length frames round-trip', () => {
  for (const frame of [
    { id: 0x123, extended: false, data: [0x12, 0xFF] },
    { id: 0x18DAF110, extended: true, data: [1, 2, 3, 4, 5, 6, 7, 8] },
    { id: 0x123, extended: true, data: [] },
    { id: 0, extended: false, data: [] },
  ]) {
    const text = formatCandump(frame, 123.456789, 'vcan0');
    const [parsed] = parseCandump(text);
    assert.deepEqual(parsed, { ...frame, timestamp: 123.456789, direction: 'rx', interfaceName: 'vcan0' });
  }
});

test('candump accepts mixed newlines, comments and optional timestamp', () => {
  const frames = parseCandump('# comment\r\n\ncan0 001#AB\n// comment\n(1.25) can1 18DAF110#00\n');
  assert.equal(frames.length, 2);
  assert.equal(frames[0].timestamp, 0);
  assert.equal(frames[1].timestamp, 1.25);
  assert.equal(frames[1].extended, true);
  assert.equal(frames[0].interfaceName, 'can0');
  assert.equal(frames[1].interfaceName, 'can1');
});

test('receive-only definitions decode external sources without a generation period; unsupported rates fail', () => {
  const def = single({ source: 'externalSensor' }, { trigger: 'receive' });
  const profile = profileFor(def);
  assert.equal(profile.frames[0].trigger, 'receive');
  assert.equal(profile.frames[0].periodMs, undefined);
  assert.deepEqual(decodeFrame({ id: 0x100, data: [7, 0] }, profile), { value: 7 });
  assert.throws(() => profileFor(single({}, { periodMs: 1 })), /periodMs/);
});

test('candump rejects malformed, RTR, CAN FD, odd and oversized data', () => {
  for (const text of ['garbage', '(1) can0 123#A', 'can0 123#GG', 'can0 123##0011', 'can0 123#R', 'can0 123#' + '00'.repeat(9), 'can0 20000000#00', 'can0 FFF#00']) {
    assert.throws(() => parseCandump(text));
  }
  assert.throws(() => formatCandump({ id: 1, data: [] }, -1));
  assert.throws(() => formatCandump({ id: 1, data: [] }, 0, 'can0\nevil'));
  assert.throws(() => formatCandump({ id: 1, data: [256] }));
  assert.throws(() => parseCandump('can0 123#00\ncan0 FFF#00'), /řádek 2/);
});

test('SLCAN standard and extended frame codecs round-trip', () => {
  for (const frame of [
    { id: 0x123, extended: false, data: [0xAB, 0xCD] },
    { id: 0x18DAF110, extended: true, data: [0, 1, 2, 3, 4, 5, 6, 255] },
    { id: 0x123, extended: true, data: [] },
    { id: 0, extended: false, data: [] },
  ]) {
    const line = encodeSlcanFrame(frame);
    assert.ok(line.endsWith('\r'));
    assert.deepEqual(parseSlcanLine(line), { ...frame, timestamp: 0, direction: 'rx' });
  }
  assert.equal(encodeSlcanFrame({ id: 0x123, data: [0xAB, 0xCD] }), 't1232ABCD\r');
});

test('SLCAN timestamp milliseconds are parsed independently of payload', () => {
  assert.deepEqual(parseSlcanLine('t1232ABCD04D2\r'), { id: 0x123, extended: false, data: [0xAB, 0xCD], timestamp: 1.234, direction: 'rx' });
  assert.deepEqual(parseSlcanLine('T000001230FFFF\r'), { id: 0x123, extended: true, data: [], timestamp: 65.535, direction: 'rx' });
});

test('SLCAN acknowledgements and identification responses are ignored', () => {
  for (const line of ['', '\r', 'z', 'Z\r', 'F00', 'V1013', 'N1234']) assert.equal(parseSlcanLine(line), null);
});

test('malformed SLCAN frames and unsupported modes fail explicitly', () => {
  for (const line of ['tFFF100', 'T20000000100', 't1239' + '00'.repeat(9), 't1232AB', 't1231XX', 'r1230', 'd123100', 't1231AB123', 't123', 't123100 ' + '00']) assert.throws(() => parseSlcanLine(line));
});

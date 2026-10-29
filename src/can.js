/** Classical CAN helpers. The bundled IDs and scaling are a demonstration,
 * never a definition of a real vehicle's ECU or transmission protocol. */
export const DEMO_CAN_PROFILE = {
  name: 'Formula · demonstrační profil',
  isDemo: true,
  bitrate: 500000,
  description: 'Smyšlený protokol pro simulaci. Před připojením k vozu použijte ověřené definice jeho CAN zpráv. Signály jsou zarovnané na celé bajty; DBC není podporováno.',
  frames: [
    {
      name: 'Telemetrie simulátoru', id: 0x600, extended: false, dlc: 8,
      trigger: 'periodic', periodMs: 50,
      signals: [
        { name: 'rpm', source: 'rpm', startByte: 0, byteLength: 2, scale: 1, offset: 0, signed: false, littleEndian: true },
        { name: 'speedKph', source: 'speedKph', startByte: 2, byteLength: 2, scale: 0.01, offset: 0, signed: false, littleEndian: true },
        { name: 'gear', source: 'gear', startByte: 4, byteLength: 1, scale: 1, offset: 0, signed: false, littleEndian: true },
        { name: 'throttle', source: 'throttle', startByte: 5, byteLength: 1, scale: 1 / 255, offset: 0, signed: false, littleEndian: true },
        { name: 'engineOn', source: 'engineOn', startByte: 6, byteLength: 1, scale: 1, offset: 0, signed: false, littleEndian: true },
        { name: 'coolantC', source: 'coolantC', startByte: 7, byteLength: 1, scale: 1, offset: -40, signed: false, littleEndian: true },
      ],
    },
    {
      name: 'Pádla a stav převodovky', id: 0x601, extended: false, dlc: 3,
      trigger: 'paddle',
      signals: [
        { name: 'upshift', source: 'upshift', startByte: 0, byteLength: 1, scale: 1, offset: 0, signed: false, littleEndian: true },
        { name: 'downshift', source: 'downshift', startByte: 1, byteLength: 1, scale: 1, offset: 0, signed: false, littleEndian: true },
        { name: 'gear', source: 'gear', startByte: 2, byteLength: 1, scale: 1, offset: 0, signed: false, littleEndian: true },
      ],
    },
  ],
};

const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const reservedNames = new Set(['__proto__', 'constructor', 'prototype']);
const fail = (message) => { throw new Error(message); };

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label}: očekáván objekt.`);
}

function label(value, context) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120 || reservedNames.has(value)) {
    fail(`${context}: neplatný název (1–120 znaků).`);
  }
  return value;
}

function integer(value, minimum, maximum, context) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) fail(`${context}: očekáváno celé číslo ${minimum}–${maximum}.`);
  return value;
}

function boolean(value, fallback, context) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${context}: očekáváno true nebo false.`);
  return value;
}

function finite(value, fallback, context) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${context}: očekáváno konečné číslo.`);
  return value;
}

function validateDefinition(raw) {
  object(raw, 'Definice rámce');
  const name = label(raw.name, 'Rámec');
  const extended = boolean(raw.extended, false, `${name}: extended`);
  const id = integer(raw.id, 0, extended ? 0x1fffffff : 0x7ff, `${name}: CAN ID`);
  const dlc = integer(raw.dlc, 0, 8, `${name}: DLC`);
  const trigger = raw.trigger ?? 'periodic';
  if (!['periodic', 'paddle', 'upshift', 'downshift', 'receive'].includes(trigger)) fail(`${name}: neplatný trigger.`);
  const result = { name, id, extended, dlc, trigger };
  if (trigger === 'periodic') result.periodMs = integer(raw.periodMs ?? 100, 10, 60000, `${name}: periodMs`);
  if (!Array.isArray(raw.signals) || raw.signals.length > 8) fail(`${name}: signals musí být pole nejvýše 8 signálů.`);
  const occupied = new Set();
  const names = new Set();
  result.signals = raw.signals.map((signal) => {
    object(signal, `${name}: signál`);
    const signalName = label(signal.name, `${name}: signál`);
    if (names.has(signalName)) fail(`${name}: duplicitní signál ${signalName}.`);
    names.add(signalName);
    const source = label(signal.source ?? signalName, `${name}/${signalName}: source`);
    const startByte = integer(signal.startByte, 0, 7, `${name}/${signalName}: startByte`);
    const byteLength = integer(signal.byteLength, 1, 8, `${name}/${signalName}: byteLength`);
    if (startByte + byteLength > dlc) fail(`${name}/${signalName}: signál přesahuje DLC.`);
    for (let byte = startByte; byte < startByte + byteLength; byte++) {
      if (occupied.has(byte)) fail(`${name}/${signalName}: signály se překrývají v bajtu ${byte}.`);
      occupied.add(byte);
    }
    const scale = finite(signal.scale, 1, `${name}/${signalName}: scale`);
    if (scale === 0) fail(`${name}/${signalName}: scale nesmí být nula.`);
    return {
      name: signalName, source, startByte, byteLength, scale,
      offset: finite(signal.offset, 0, `${name}/${signalName}: offset`),
      signed: boolean(signal.signed, false, `${name}/${signalName}: signed`),
      littleEndian: boolean(signal.littleEndian, true, `${name}/${signalName}: littleEndian`),
    };
  });
  return result;
}

/** Validate and return a clean copy, without retaining arbitrary imported keys.
 * Byte-aligned Classical CAN only; bit fields, multiplexing and DBC require a
 * separate protocol implementation. Duplicate frame IDs are ambiguous. */
export function validateProfile(raw) {
  object(raw, 'CAN profil');
  const name = label(raw.name, 'CAN profil');
  const bitrate = integer(raw.bitrate, 10000, 1000000, 'CAN bitrate');
  if (!Array.isArray(raw.frames) || !raw.frames.length || raw.frames.length > 256) fail('CAN profil: frames musí obsahovat 1–256 rámců.');
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 5000)) fail('CAN profil: description musí být text do 5000 znaků.');
  const seen = new Set();
  const frames = raw.frames.map((frame) => {
    const result = validateDefinition(frame);
    const key = `${result.extended}:${result.id}`;
    if (seen.has(key)) fail(`CAN profil: duplicitní ID 0x${result.id.toString(16).toUpperCase()}.`);
    seen.add(key);
    return result;
  });
  return { name, isDemo: boolean(raw.isDemo, false, 'CAN profil: isDemo'), bitrate, description: raw.description ?? '', frames };
}

function validateFrame(frame) {
  object(frame, 'CAN rámec');
  const extended = boolean(frame.extended, false, 'CAN rámec: extended');
  const id = integer(frame.id, 0, extended ? 0x1fffffff : 0x7ff, 'CAN rámec: ID');
  if (!Array.isArray(frame.data) && !(frame.data instanceof Uint8Array)) fail('CAN rámec: data musí být pole bajtů.');
  if (frame.data.length > 8) fail('CAN rámec: Classical CAN podporuje nejvýše 8 bajtů.');
  const data = Array.from(frame.data, (byte) => integer(byte, 0, 255, 'CAN rámec: bajt'));
  return { id, extended, data };
}

/** Quantize physical values to integers; refuse overflow instead of wrapping. */
export function encodeFrame(definition, values) {
  const def = validateDefinition(definition);
  object(values, 'Hodnoty CAN signálů');
  const data = Array(def.dlc).fill(0);
  for (const signal of def.signals) {
    if (!own(values, signal.source)) fail(`Chybí hodnota signálu ${signal.source}.`);
    const value = typeof values[signal.source] === 'boolean' ? Number(values[signal.source]) : values[signal.source];
    if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${signal.name}: hodnota musí být konečné číslo.`);
    const unrounded = (value - signal.offset) / signal.scale;
    const quantized = Math.round(unrounded);
    if (!Number.isSafeInteger(quantized)) fail(`${signal.name}: hodnota je mimo přesný číselný rozsah JavaScriptu.`);
    const bits = BigInt(signal.byteLength * 8);
    const minimum = signal.signed ? -(1n << (bits - 1n)) : 0n;
    const maximum = signal.signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
    let encoded = BigInt(quantized);
    if (encoded < minimum || encoded > maximum || unrounded < Number(minimum) - 1e-9 || unrounded > Number(maximum) + 1e-9) {
      fail(`${signal.name}: hodnota ${value} se nevejde do ${signal.byteLength} bajtů.`);
    }
    if (encoded < 0n) encoded += 1n << bits;
    for (let i = 0; i < signal.byteLength; i++) {
      const index = signal.startByte + (signal.littleEndian ? i : signal.byteLength - i - 1);
      data[index] = Number(encoded & 0xffn);
      encoded >>= 8n;
    }
  }
  return { id: def.id, extended: def.extended, data };
}

/** Return signal-name → physical-value mappings. Unknown IDs return {}.
 * A known ID with an incorrect DLC is rejected so truncated frames never
 * silently decode as zero-valued controls. */
export function decodeFrame(frame, profile) {
  const clean = validateFrame(frame);
  const def = profile.frames.find((candidate) => candidate.id === clean.id && Boolean(candidate.extended) === clean.extended);
  if (!def) return {};
  if (clean.data.length !== def.dlc) fail(`${def.name}: přijaté DLC ${clean.data.length}, očekáváno ${def.dlc}.`);
  const values = [];
  for (const signal of def.signals) {
    let raw = 0n;
    for (let i = 0; i < signal.byteLength; i++) {
      const index = signal.startByte + (signal.littleEndian ? signal.byteLength - i - 1 : i);
      raw = (raw << 8n) | BigInt(clean.data[index]);
    }
    const bits = BigInt(signal.byteLength * 8);
    if (signal.signed && (raw & (1n << (bits - 1n)))) raw -= 1n << bits;
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric)) fail(`${signal.name}: hodnota je mimo přesný číselný rozsah JavaScriptu.`);
    const physical = numeric * signal.scale + signal.offset;
    if (!Number.isFinite(physical)) fail(`${signal.name}: dekódovaná hodnota není konečné číslo.`);
    values.push([signal.name, physical]);
  }
  return Object.fromEntries(values);
}

const hex = (number, width) => number.toString(16).toUpperCase().padStart(width, '0');

export function formatCandump(frame, timestampSeconds = 0, interfaceName = 'can0') {
  const clean = validateFrame(frame);
  if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0) fail('Čas CAN rámce musí být nezáporné konečné číslo.');
  if (typeof interfaceName !== 'string' || !/^[A-Za-z0-9_.:-]{1,32}$/.test(interfaceName)) fail('Neplatný název CAN rozhraní.');
  return `(${timestampSeconds.toFixed(6)}) ${interfaceName} ${hex(clean.id, clean.extended ? 8 : 3)}#${clean.data.map((byte) => hex(byte, 2)).join('')}`;
}

/** Read compact candump logs: `(seconds) can0 123#0011`.
 * Timestamps may be omitted. Empty lines and # / // comments are ignored.
 * RTR and CAN FD deliberately fail rather than masquerading as data frames. */
export function parseCandump(text) {
  if (typeof text !== 'string') fail('CAN záznam musí být text.');
  const frames = [];
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || /^(#|\/\/)/.test(line)) continue;
    const match = /^(?:\((\d+(?:\.\d+)?)\)\s+)?([A-Za-z0-9_.:-]{1,32})\s+([A-Fa-f0-9]{1,8})#([A-Fa-f0-9]*)$/.exec(line);
    if (!match || match[4].length % 2 || match[4].length > 16) fail(`CAN záznam, řádek ${index + 1}: očekáván Classical CAN ve formátu (čas) can0 ID#DATA.`);
    const timestamp = match[1] === undefined ? 0 : Number(match[1]);
    if (!Number.isFinite(timestamp)) fail(`CAN záznam, řádek ${index + 1}: neplatný čas.`);
    const id = Number.parseInt(match[3], 16);
    let frame;
    try {
      frame = validateFrame({
        id, extended: match[3].length > 3,
        data: (match[4].match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)),
      });
    } catch (error) {
      fail(`CAN záznam, řádek ${index + 1}: ${error.message}`);
    }
    frames.push({ ...frame, timestamp, direction: 'rx', interfaceName: match[2] });
  }
  return frames;
}

/** SLCAN ASCII data frames (t/T), optionally with a 16-bit millisecond clock.
 * The adapter clock wraps, so it is not an absolute wall-clock timestamp.
 * Command acknowledgements, status and identification responses return null. */
export function parseSlcanLine(rawLine) {
  if (typeof rawLine !== 'string') fail('SLCAN řádek musí být text.');
  const line = rawLine.trim();
  if (!line || /^[zZ]$/.test(line) || /^F[\dA-Fa-f]{2}$/.test(line) || /^[VN][\dA-Fa-f]{4}$/.test(line)) return null;
  if (!/^[tT]/.test(line)) fail('Neplatný SLCAN rámec; podporována jsou datová hlášení t/T (Classical CAN).');
  const extended = line[0] === 'T';
  const idWidth = extended ? 8 : 3;
  const idText = line.slice(1, 1 + idWidth);
  const dlcText = line[1 + idWidth];
  if (!new RegExp(`^[\\dA-Fa-f]{${idWidth}}$`).test(idText) || !/^[0-8]$/.test(dlcText ?? '')) fail('Neplatná hlavička nebo DLC SLCAN rámce.');
  const dlc = Number(dlcText);
  const remainder = line.slice(2 + idWidth);
  if (!/^[\dA-Fa-f]*$/.test(remainder) || ![dlc * 2, dlc * 2 + 4].includes(remainder.length)) fail('Délka dat SLCAN rámce neodpovídá DLC.');
  const frame = validateFrame({
    id: Number.parseInt(idText, 16), extended,
    data: (remainder.slice(0, dlc * 2).match(/../g) ?? []).map((byte) => Number.parseInt(byte, 16)),
  });
  const timestamp = remainder.length === dlc * 2 + 4 ? Number.parseInt(remainder.slice(-4), 16) / 1000 : 0;
  return { ...frame, timestamp, direction: 'rx' };
}

export function encodeSlcanFrame(frame) {
  const clean = validateFrame(frame);
  return `${clean.extended ? 'T' : 't'}${hex(clean.id, clean.extended ? 8 : 3)}${clean.data.length}${clean.data.map((byte) => hex(byte, 2)).join('')}\r`;
}

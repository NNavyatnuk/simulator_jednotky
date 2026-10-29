import { validateProfile } from './can.js';

const FIRMWARE = 'reference/firmware';
const CURRENT_ASSUMPTION = 'Poloha shift v data[6], StandBy bit5 a resetFuel bity2–4 jsou doloženy screenshotem. Maska 0x43 a hodnoty DOWN=1, UP=2, N=0x40 jsou převzatá hypotéza ze starého firmware; významy příkazů aktuálního volantu zatím nejsou ověřeny.';

export const CURRENT_CAR_PROTOCOL = Object.freeze({
  name: 'Aktuální vůz · uživatelské CAN screenshoty',
  ids: Object.freeze({ request: 0x666, gear: 0x604, rpm: 0x600 }),
  commandByte: 6, requestByte: 6,
  requestMask: 0x43, commandMask: 0x43,
  rpmStartByte: 0, rpmByteLength: 2, rpmLittleEndian: true,
  rpmMappingVerified: true,
  commandInterpretationVerified: false,
  requestMaskVerified: false,
  assumption: CURRENT_ASSUMPTION,
});

export const LEGACY_TUL_PROTOCOL = Object.freeze({
  name: 'Přiložený starší firmware · původní parser',
  ids: Object.freeze({ request: 0x642, gear: 0x604, rpm: 0x666 }),
  commandByte: 4, requestByte: 4, requestMask: 0xff, commandMask: 0xff,
  rpmStartByte: 0, rpmByteLength: 1, rpmLittleEndian: true,
  rpmMappingVerified: false,
});

/** Source-revision facts remain separate from the newly documented car map. */
export const TUL_PROTOCOL_FACTS = Object.freeze({
  source: 'Přiložený shifting-unit-firmware-main',
  bitrate: 1000000,
  ids: LEGACY_TUL_PROTOCOL.ids,
  currentCar: CURRENT_CAR_PROTOCOL,
  legacy: LEGACY_TUL_PROTOCOL,
  timing: Object.freeze({ actuationMs: 100, neutralActuationMs: 50, minimumDelayMs: 300, rearmZeroFrames: 3 }),
  limits: Object.freeze({ upperRpm: 14000, lowerRpm: 4000, neutralRpm: 6000 }),
  ratios: Object.freeze([(500 * 39 / 14) / 4000, 39 / 14, 39 / 19, 37 / 22, 29 / 20, 30 / 23, 26 / 22]),
  minimumDlc: Object.freeze({ request: 5, gear: 1, rpm: 1 }),
  actualDlcKnown: false,
  physicalRpmMappingKnown: false,
  transmitsCan: false,
  evidence: Object.freeze({
    bitrateAndMode: `${FIRMWARE}/src/twai.cpp:10–12`,
    identifiers: `${FIRMWARE}/src/shifting.cpp:26–28`,
    commandComment: `${FIRMWARE}/src/shifting.cpp:5–16`,
    requestGateAndRearm: `${FIRMWARE}/src/shifting.cpp:62–79`,
    requestBranches: `${FIRMWARE}/src/shifting.cpp:96–118`,
    rawRpmByte: `${FIRMWARE}/src/shifting.cpp:48–49`,
    gearFeedback: `${FIRMWARE}/src/shifting.cpp:50–54`,
    limitsRatiosAndTiming: `${FIRMWARE}/include/shifting.h:7–17`,
    outputPulses: `${FIRMWARE}/src/shifting.cpp:129–185`,
    currentRpm: 'Uživatelský screenshot: ECU base 0x600; RPM byte0, unsigned16, little-endian, scale1, offset0.',
    currentSteering: 'Uživatelský screenshot: SW_switchboard 0x666; shift unsigned byte6, StandBy bit5, resetFuel tři bity od bit2; příklad 00 14 DC 01 08 00 08 00.',
    currentGear: 'Uživatelský screenshot: převodovka 0x604, byte0 unsigned8.',
  }),
});

const signal = (name, startByte, byteLength = 1) => ({ name, source: name, startByte, byteLength, scale: 1, offset: 0, signed: false, littleEndian: true });

/** Receive profile for the supplied current-car screenshot map. Known shared
 * bitfields are decoded by decodeTulFrame, not by the byte-only generic codec. */
export const TUL_CAN_PROFILE = validateProfile({
  name: 'TUL · aktuální vůz podle CAN screenshotů',
  isDemo: false,
  bitrate: TUL_PROTOCOL_FACTS.bitrate,
  description: 'Aktuální mapa: ECU 0x600 RPM u16LE od byte0, převodovka 0x604 byte0, SW_switchboard 0x666 sdílený byte6. StandBy bit5, resetFuel bity2–4. Maska řazení 0x43 a významy 1/2/0x40 jsou zatím hypotéza ze staršího firmware. Osmibajtové výstupy jsou modelové rámce; nedefinovaná pole se nesmějí vydávat za skutečné signály vozu.',
  frames: [
    { name: 'Volant · sdílený byte6', id: 0x666, extended: false, dlc: 8, trigger: 'receive', signals: [signal('commandRaw', 6)] },
    { name: 'Senzor převodovky', id: 0x604, extended: false, dlc: 8, trigger: 'receive', signals: [signal('gear', 0)] },
    { name: 'ECU · fyzické RPM u16LE', id: 0x600, extended: false, dlc: 8, trigger: 'receive', signals: [signal('rpm', 0, 2)] },
  ],
});

export const TUL_LEGACY_CAN_PROFILE = validateProfile({
  name: 'TUL · původní parser přiloženého firmware',
  isDemo: false,
  bitrate: TUL_PROTOCOL_FACTS.bitrate,
  description: 'Starší firmware: request 0x642 data[4], UP/DOWN větvení data[0]; RPM 0x666 pouze surový byte0 a mapování TODO. DLC 5/1/1 jsou minimální potřebné délky, skutečné DLC nedoloženo. Není to aktuální mapa dodaná na CAN screenshotech.',
  frames: [
    { name: 'Pádla · minimálně 5 bajtů', id: 0x642, extended: false, dlc: 5, trigger: 'receive', signals: [signal('legacyCommandRaw', 0), signal('commandRaw', 4)] },
    { name: 'Senzor převodovky · minimálně 1 bajt', id: 0x604, extended: false, dlc: 1, trigger: 'receive', signals: [signal('gear', 0)] },
    { name: 'RPM TODO · surový bajt', id: 0x666, extended: false, dlc: 1, trigger: 'receive', signals: [signal('rawRpmByte', 0)] },
  ],
});

const COMMANDS = Object.freeze({ release: 0, down: 1, up: 2, neutral: 0x40 });
const commandName = value => value === 0 ? 'release' : value === 1 ? 'down' : value === 2 ? 'up' : value === 0x40 ? 'neutral' : 'unknown';

function selectedProtocol(options = {}) {
  const name = options.protocol ?? 'current-car';
  if (name === 'current-car') return CURRENT_CAR_PROTOCOL;
  if (['legacy', 'legacy-firmware', 'source-firmware', 'firmware'].includes(name)) return LEGACY_TUL_PROTOCOL;
  throw new Error(`Neznámý TUL protokol: ${String(name)}.`);
}

function baseBytes(baseData, minimum, defaultLength) {
  if (baseData === undefined) return Array(defaultLength).fill(0);
  if ((!Array.isArray(baseData) && !(baseData instanceof Uint8Array)) || baseData.length < minimum || baseData.length > 8) throw new Error(`Základ rámce musí obsahovat ${minimum}–8 bajtů.`);
  const data = Array.from(baseData);
  if (data.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('Základ rámce obsahuje neplatný bajt.');
  return data;
}

/** Current-car command bits are a stated hypothesis. Preserve shared controls,
 * including StandBy/resetFuel and unknown bit7, instead of zeroing byte6.
 * No frame returned here is transmitted to hardware. */
export function makeTulRequest(command, options = {}) {
  if (typeof command !== 'string' || !Object.hasOwn(COMMANDS, command)) throw new Error('Příkaz musí být up, down, neutral nebo release.');
  const protocol = selectedProtocol(options);
  const current = protocol === CURRENT_CAR_PROTOCOL;
  const data = baseBytes(options.baseData, current ? 8 : 5, current ? 8 : 5);
  const value = COMMANDS[command];
  if ((value & ~protocol.requestMask) !== 0) throw new Error('Příkaz zasahuje mimo předpokládanou masku řazení.');
  data[protocol.commandByte] = (data[protocol.commandByte] & ~protocol.requestMask) | value;
  return { id: protocol.ids.request, extended: false, data };
}

/** Gear 7 means the sensor is between gears, not a seventh driving gear.
 * Minimal one-byte feedback avoids inventing the sensor's remaining fields. */
export function makeTulGear(gear) {
  if (!Number.isInteger(gear) || gear < 0 || gear > 7) throw new Error('Senzor převodovky musí být celé číslo 0–7 (7 = mezi stupni).');
  return { id: CURRENT_CAR_PROTOCOL.ids.gear, extended: false, data: [gear] };
}

/** Current screenshot: unsigned16 little-endian, scale1/offset0. Unspecified
 * bytes use the supplied base frame or zero-valued simulation placeholders. */
export function makeTulRpm(rpm, options = {}) {
  if (selectedProtocol(options) !== CURRENT_CAR_PROTOCOL) throw new Error('Původní firmware nemá doložené mapování fyzických RPM.');
  if (typeof rpm !== 'number' || !Number.isFinite(rpm) || rpm < 0 || rpm > 65535) throw new Error('RPM musí být konečné číslo v rozsahu 0–65535.');
  const value = Math.round(rpm);
  const data = baseBytes(options.baseData, 8, 8);
  data[0] = value & 0xff;
  data[1] = value >>> 8;
  return { id: CURRENT_CAR_PROTOCOL.ids.rpm, extended: false, data };
}

function readClassicalFrame(frame) {
  if (!frame || typeof frame !== 'object') throw new Error('Očekáván CAN rámec.');
  if (frame.extended !== undefined && typeof frame.extended !== 'boolean') throw new Error('CAN extended musí být true nebo false.');
  const extended = frame.extended ?? false;
  if (!Number.isInteger(frame.id) || frame.id < 0 || frame.id > (extended ? 0x1fffffff : 0x7ff)) throw new Error('Neplatné CAN ID.');
  if (frame.rtr || frame.fd || frame.isFD) throw new Error('TUL dekodér přijímá pouze datové rámce Classical CAN.');
  if ((!Array.isArray(frame.data) && !(frame.data instanceof Uint8Array)) || frame.data.length > 8) throw new Error('Classical CAN data musí obsahovat nejvýše 8 bajtů.');
  const data = Array.from(frame.data);
  if (data.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('CAN data obsahují neplatný bajt.');
  return { id: frame.id, extended, data };
}

export function decodeTulFrame(frame, options = {}) {
  const protocol = selectedProtocol(options);
  const { id, extended, data } = readClassicalFrame(frame);
  if (extended) return {};
  if (id === protocol.ids.request) {
    if (data.length <= protocol.commandByte) throw new Error(`TUL 0x${id.toString(16)}: potřeba nejméně ${protocol.commandByte + 1} bajtů pro data[${protocol.commandByte}].`);
    const commandRaw = data[protocol.commandByte];
    if (protocol === CURRENT_CAR_PROTOCOL) {
      return { commandRaw, maskedCommand: commandRaw & protocol.requestMask, standBy: (commandRaw >>> 5) & 1, resetFuel: (commandRaw >>> 2) & 7, unknownBits: commandRaw & 0x80, unknownFlag: Boolean(commandRaw & 0x80) };
    }
    return { commandRaw, legacyCommandRaw: data[0] };
  }
  if (id === protocol.ids.gear) {
    if (!data.length) throw new Error('TUL 0x604: chybí bajt senzoru převodovky.');
    return { gear: data[0] };
  }
  if (id === protocol.ids.rpm) {
    if (data.length < protocol.rpmByteLength) throw new Error(`TUL 0x${id.toString(16)}: potřeba nejméně ${protocol.rpmByteLength} RPM bajtů.`);
    return protocol === CURRENT_CAR_PROTOCOL ? { rpm: data[0] | (data[1] << 8) } : { rawRpmByte: data[0] };
  }
  return {};
}

/** Legacy mode compares the actual source branches with its comment. Current
 * mode interprets only the explicitly hypothetical command bits; known shared
 * controls alone never count as a paddle request or prevent release. */
export function analyzeTulRequest(frame, options = {}) {
  const protocol = selectedProtocol(options);
  const decoded = decodeTulFrame(frame, options);
  if (!Object.hasOwn(decoded, 'commandRaw')) return null;
  const documentedByte = decoded.commandRaw;
  if (protocol === CURRENT_CAR_PROTOCOL) {
    const command = commandName(decoded.maskedCommand);
    const warnings = [CURRENT_ASSUMPTION];
    if (decoded.unknownFlag) warnings.push('Sdílený byte6 obsahuje nedoložený bit7 (0x80); zůstává oddělen od hypotézy řazení.');
    return { ...decoded, command, documentedByte, legacyByte: null, legacyCommand: 'unknown', discrepancy: null, active: decoded.maskedCommand !== 0, release: decoded.maskedCommand === 0, assumption: CURRENT_ASSUMPTION, commandInterpretationVerified: false, warnings };
  }
  const legacyByte = decoded.legacyCommandRaw;
  const command = commandName(documentedByte);
  const legacyCommand = documentedByte === 0 ? 'release'
    : documentedByte === 0x40 ? 'neutral'
      : legacyByte === 2 ? 'up' : legacyByte === 1 ? 'down' : 'unknown';
  const discrepancy = command === legacyCommand ? null
    : `Komentář vykládá data[4]=0x${documentedByte.toString(16).padStart(2, '0').toUpperCase()} jako ${command}; zdrojový kód po této bráně větví UP/DOWN podle data[0]=0x${legacyByte.toString(16).padStart(2, '0').toUpperCase()} (${legacyCommand}).`;
  return { command, documentedByte, legacyByte, legacyCommand, discrepancy, active: documentedByte !== 0, release: documentedByte === 0, warnings: discrepancy ? [discrepancy] : [] };
}

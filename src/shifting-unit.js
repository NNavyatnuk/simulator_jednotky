import { TUL_PROTOCOL_FACTS, CURRENT_CAR_PROTOCOL, LEGACY_TUL_PROTOCOL, analyzeTulRequest } from './tul-protocol.js';

/**
 * Deterministic model of the supplied Formule TUL shifting controller.
 *
 * `reference` uses the configured protocol: the current-car screenshots define
 * RPM 0x600 u16LE and the shared steering request byte 0x666 data[6]. Its command
 * values 1/2/0x40 are explicitly UNVERIFIED carryovers from the old comments.
 * The legacy reference protocol follows data[4] and uses direct model RPM.
 * `firmware-parser` retains the actual data[0] up/down parser and the one-byte
 * 0x666 RPM placeholder. Neither mode emulates FreeRTOS message scheduling,
 * blocking delay(), uninitialised globals or unsigned millis() underflow.
 * Cooldown is deterministic (elapsed >= minimumDelayMs), including at startup.
 * Out-of-range C++ array accesses are diagnosed instead of inventing a result.
 * Outputs represent commanded MOSFET states; gear movement requires feedback.
 */

const DEFAULT_CONFIG = Object.freeze({
  mode: 'reference',
  protocol: 'current-car',
  actuationMs: TUL_PROTOCOL_FACTS.timing.actuationMs,
  neutralActuationMs: TUL_PROTOCOL_FACTS.timing.neutralActuationMs,
  minimumDelayMs: TUL_PROTOCOL_FACTS.timing.minimumDelayMs,
  rearmZeroFrames: TUL_PROTOCOL_FACTS.timing.rearmZeroFrames,
  rpmUpperLimit: TUL_PROTOCOL_FACTS.limits.upperRpm,
  rpmLowerLimit: TUL_PROTOCOL_FACTS.limits.lowerRpm,
  rpmNeutralLimit: TUL_PROTOCOL_FACTS.limits.neutralRpm,
  ratios: TUL_PROTOCOL_FACTS.ratios,
});

function validatedConfiguration(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Nastavení řadicí jednotky musí být objekt.');
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_CONFIG, key)) throw new RangeError(`Neznámý parametr řadicí jednotky: ${key}`);
  }
  const config = { ...DEFAULT_CONFIG, ...overrides };
  if (!['reference', 'firmware-parser'].includes(config.mode)) throw new RangeError('Neznámý režim řadicí jednotky.');
  if (!['current-car', 'legacy', 'legacy-firmware'].includes(config.protocol)) throw new RangeError('Neznámý CAN protokol řadicí jednotky.');
  for (const key of ['actuationMs', 'neutralActuationMs', 'minimumDelayMs']) {
    if (!Number.isFinite(config[key]) || config[key] < (key === 'minimumDelayMs' ? 0 : 1) || config[key] > 10000) {
      throw new RangeError(`Neplatný čas ${key}; zadejte milisekundy v rozsahu ${key === 'minimumDelayMs' ? 0 : 1}–10000.`);
    }
  }
  for (const key of ['rpmUpperLimit', 'rpmLowerLimit', 'rpmNeutralLimit']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0 || config[key] > 50000) {
      throw new RangeError(`Neplatný limit otáček: ${key}`);
    }
  }
  if (config.rpmLowerLimit >= config.rpmUpperLimit) throw new RangeError('Spodní limit otáček musí být menší než horní.');
  if (!Number.isInteger(config.rearmZeroFrames) || config.rearmZeroFrames < 1 || config.rearmZeroFrames > 20) {
    throw new RangeError('Počet nulových rámců musí být celé číslo 1–20.');
  }
  if (!Array.isArray(config.ratios) || config.ratios.length !== 7 ||
      config.ratios.some((ratio) => !Number.isFinite(ratio) || ratio <= 0 || ratio > 100)) {
    throw new RangeError('Poměry musí obsahovat sedm kladných čísel: N a stupně 1–6.');
  }
  return Object.freeze({ ...config, ratios: Object.freeze([...config.ratios]) });
}

export class ShiftingUnit {
  constructor(config = {}) {
    this.config = validatedConfiguration(config);
    this.reset();
  }

  get state() {
    return {
      protocol: this.effectiveProtocol,
      timeMs: this._timeMs,
      currentGear: this._currentGear,
      lastValidGear: this._lastValidGear,
      rpm: this._rpm,
      fet1: this._fet1,
      fet2: this._fet2,
      busy: this._pulseEndMs > this._timeMs,
      remainingMs: Math.max(0, this._pulseEndMs - this._timeMs),
      cooldownMs: Math.max(0, this.config.minimumDelayMs - (this._timeMs - this._lastCommandMs)),
      shiftingFlag: this._shiftingFlag,
      lastDecision: this._lastDecision ? { ...this._lastDecision } : null,
    };
  }

  get effectiveProtocol() {
    return this.config.mode === 'firmware-parser' || this.config.protocol !== 'current-car' ? 'legacy' : 'current-car';
  }

  reset() {
    this._timeMs = 0;
    this._currentGear = 0;
    this._lastValidGear = 0;
    this._rpm = 0;
    this._fet1 = false;
    this._fet2 = false;
    this._pulseEndMs = 0;
    this._lastCommandMs = 0;
    this._shiftingFlag = 0;
    this._lastDecision = null;
    return this.state;
  }

  configure(overrides = {}) {
    if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
      throw new TypeError('Nastavení řadicí jednotky musí být objekt.');
    }
    const config = validatedConfiguration({ ...this.config, ...overrides });
    this.config = config;
    return this.reset();
  }

  _updateGear(gear) {
    if (!Number.isInteger(gear) || gear < 0 || gear > 7) return;
    this._currentGear = gear;
    if (gear !== 7) this._lastValidGear = gear;
  }

  advance(dtMs, sensors = {}) {
    if (!Number.isFinite(dtMs) || dtMs < 0 || !Number.isFinite(this._timeMs + dtMs)) return this.state;
    if (sensors && typeof sensors === 'object') {
      this._updateGear(sensors.gear);
      if (this.config.mode === 'reference' && Number.isFinite(sensors.rpm) && sensors.rpm >= 0) {
        this._rpm = sensors.rpm;
      }
    }
    this._timeMs += dtMs;
    if (this._timeMs >= this._pulseEndMs) {
      this._fet1 = false;
      this._fet2 = false;
    }
    return this.state;
  }

  _decision(accepted, reason, targetGear = null, pulseMs = 0, direction = null) {
    const decision = { accepted, reason, targetGear, pulseMs, direction };
    this._lastDecision = decision;
    return { ...decision };
  }

  _pulse(fet, targetGear, duration, direction, reason) {
    if (this._fet1 || this._fet2) return this._decision(false, 'Konflikt: předchozí impulz ještě probíhá.');
    this._fet1 = fet === 1;
    this._fet2 = fet === 2;
    this._pulseEndMs = this._timeMs + duration;
    return this._decision(true, reason, targetGear, duration, direction);
  }

  receive(frame) {
    if (!frame || typeof frame !== 'object' || frame.extended || frame.rtr || frame.fd || frame.isFD) return null;
    const bytes = frame.data;
    if ((!Array.isArray(bytes) && !ArrayBuffer.isView(bytes)) || !Number.isInteger(bytes.length) || bytes.length === 0 || bytes.length > 8 ||
        Array.from(bytes).some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) return null;
    const protocol = this.effectiveProtocol === 'current-car' ? CURRENT_CAR_PROTOCOL : LEGACY_TUL_PROTOCOL;
    if (frame.id === protocol.ids.gear) {
      this._updateGear(bytes[0]);
      return null;
    }
    if (frame.id === protocol.ids.rpm) {
      // Legacy source has an unscaled one-byte placeholder; current screenshots
      // supply a distinct physical RPM mapping: 0x600 bytes0–1 unsigned LE.
      if (this.config.mode === 'firmware-parser') this._rpm = bytes[0];
      else if (this.effectiveProtocol === 'current-car' && bytes.length >= 2) this._rpm = bytes[0] + bytes[1] * 256;
      return null;
    }
    if (frame.id !== protocol.ids.request) return null;
    const label = `0x${protocol.ids.request.toString(16).toUpperCase()}`;
    if (bytes.length <= protocol.requestByte) return this._decision(false, `Požadavek ${label} musí obsahovat data[${protocol.requestByte}] (alespoň ${protocol.requestByte + 1} bajtů).`);
    let analysis;
    try {
      analysis = analyzeTulRequest(frame, { protocol: this.effectiveProtocol });
    } catch (error) {
      return this._decision(false, `Neplatný rámec ${label}: ${error.message}`);
    }
    if (!analysis) return null;

    // Current steering byte also carries StandBy/resetFuel. Only masked request
    // bits count as an active paddle; shared flags alone are released paddles.
    // Legacy code and comments gate/rearm using the entire data[4] byte.
    if (analysis.release) {
      if (this._shiftingFlag !== 0) {
        this._shiftingFlag++;
        if (this._shiftingFlag > this.config.rearmZeroFrames) this._shiftingFlag = 0;
      }
      return this._decision(false, this._shiftingFlag === 0
        ? 'Pádla uvolněna; další požadavek je odjištěn.'
        : `Uvolnění pádel: ${this._shiftingFlag - 1}/${this.config.rearmZeroFrames} nulových rámců.`);
    }

    const wasLatched = this._shiftingFlag !== 0;
    // Repeating or rejected nonzero requests also reset the zero-frame count.
    this._shiftingFlag = 1;
    if (wasLatched) return this._decision(false, `Požadavek blokován: nejprve ${this.config.rearmZeroFrames} nulové rámce pádel.`);
    if (this._timeMs - this._lastCommandMs < this.config.minimumDelayMs) {
      return this._decision(false, 'Požadavek blokován: neuplynula minimální prodleva mezi příkazy.');
    }
    // The source updates timeLast BEFORE shiftGears validates RPM/ratios.
    this._lastCommandMs = this._timeMs;
    const command = this.config.mode === 'firmware-parser' ? analysis.legacyCommand : analysis.command;
    if (command === 'neutral') {
      if (this._rpm >= this.config.rpmNeutralLimit) return this._decision(false, `Neutrál odmítnut: otáčky musí být pod ${this.config.rpmNeutralLimit} ot/min.`);
      if (![1, 2].includes(this._lastValidGear)) return this._decision(false, 'Neutrál lze volit pouze z 1. nebo 2. stupně.');
      if (![1, 2].includes(this._currentGear)) return this._decision(false, 'Neutrál odmítnut: snímač právě nepotvrzuje 1. ani 2. stupeň.');
      return this._pulse(this._currentGear === 1 ? 2 : 1, 0, this.config.neutralActuationMs, null, 'Impulz pro zařazení neutrálu.');
    }
    const gear = this._lastValidGear;
    if (command === 'up') {
      if (gear < 0 || gear >= 6) return this._decision(false, 'Nelze řadit výše: za 6. stupněm není platný převodový poměr (firmware by četl mimo pole).');
      // Cross multiplication preserves the strict mathematical boundary (e.g.
      // exactly 500rpm from N) without division rounding it just above 4000.
      if (this._rpm * this.config.ratios[gear + 1] <= this.config.rpmLowerLimit * this.config.ratios[gear]) {
        return this._decision(false, `Řazení nahoru odmítnuto: výsledné otáčky musí být nad ${this.config.rpmLowerLimit} ot/min.`);
      }
      return this._pulse(gear === 0 ? 1 : 2, gear + 1, this.config.actuationMs, 'up', `Impulz řazení ${gear || 'N'} → ${gear + 1}.`);
    }
    if (command === 'down') {
      if (gear <= 1 || gear > 6) return this._decision(false, gear === 0
        ? 'Nelze podřadit z N: neexistuje předchozí převodový poměr (firmware by četl mimo pole).'
        : 'Podřadit lze pouze z 2.–6. stupně; pro N použijte požadavek neutrálu.');
      if (this._rpm * this.config.ratios[gear - 1] >= this.config.rpmUpperLimit * this.config.ratios[gear]) {
        return this._decision(false, `Podřazení odmítnuto: výsledné otáčky musí být pod ${this.config.rpmUpperLimit} ot/min.`);
      }
      return this._pulse(1, gear - 1, this.config.actuationMs, 'down', `Impulz řazení ${gear} → ${gear - 1}.`);
    }
    return this._decision(false, this.config.mode === 'firmware-parser'
      ? 'Firmware neřadí: data[4] otevírá požadavek, ale data[0] není 1 ani 2 (ani požadavek N).'
      : `Neznámý požadavek: příkaz v data[${protocol.requestByte}] musí být 1 (dolů), 2 (nahoru) nebo 0x40 (N)${this.effectiveProtocol === 'current-car' ? '; hodnoty příkazů aktuálního vozu nejsou doložené' : ''}.`);
  }
}

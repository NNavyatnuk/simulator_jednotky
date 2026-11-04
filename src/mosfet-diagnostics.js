const DEFAULTS = Object.freeze({ actuationMs: 100, neutralActuationMs: 50, toleranceMs: 10,
  staleMs: 1000, maxTelemetryGapMs: 200 });
const MAX_LINE = 4096;
const MAX_HISTORY = 20;
const MAX_ISSUES = 30;

function configuration(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new TypeError('Nastavení diagnostiky musí být objekt.');
  const result = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    if (options[key] !== undefined) result[key] = options[key];
    if (!Number.isFinite(result[key]) || result[key] < (key === 'toleranceMs' ? 0 : Number.MIN_VALUE)) {
      throw new RangeError(`Neplatný parametr diagnostiky: ${key}.`);
    }
  }
  return Object.freeze(result);
}

function arrivalTime(value) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError('Čas přijetí musí být konečné nezáporné číslo.');
  return value;
}

/** Observes explicit producer telemetry, never CAN-derived or simulated output
 * states. gpio denotes the MCU output-control latch, not measured pin voltage.
 * load is reserved for a producer with independent, normalized load feedback.
 */
export class MosfetMonitor {
  constructor(options = {}) { this.reset(options); }

  reset(options) {
    this.options = configuration(options === undefined ? this.options : options);
    this._tail = '';
    this._dropping = false;
    this._disconnected = false;
    this._lastArrival = null;
    this._scope = null;
    this._levels = [null, null];
    this._received = 0;
    this._fault = false;
    this._uncertain = false;
    this._issues = [];
    this._channels = [0, 1].map(index => ({ name: `FET${index + 1}`, pulses: 0, durationsMs: [], invalid: false }));
    this._breakContinuity();
    return this.snapshot();
  }

  _breakContinuity() {
    this._previous = null;
    this._starts = [null, null];
    this._highSince = [null, null];
    this._segmentPulses = [0, 0];
  }

  _issue(text, definite = false) {
    if (definite) this._fault = true;
    else this._uncertain = true;
    if (this._issues[this._issues.length - 1] !== text) {
      this._issues.push(text);
      if (this._issues.length > MAX_ISSUES) this._issues.shift();
    }
  }

  disconnect() {
    if (this._received) this._issue('Připojení bylo přerušeno; po opětovném připojení zahajte nový test.');
    this._disconnected = true;
    this._tail = '';
    this._dropping = false;
    this._levels = [null, null];
    this._breakContinuity();
    return this.snapshot();
  }

  _protocolIssue(detail) {
    this._issue(`Neplatná telemetrie MOSFET: ${detail}`);
    this._breakContinuity();
  }

  _line(line, nowMs) {
    if (!line.startsWith('MOSFET')) return;
    const match = /^MOSFET,1,(gpio|load),(\d+),(\d+),([01]),([01])$/.exec(line);
    if (!match) { this._protocolIssue('očekáván formát MOSFET,1,gpio|load,seq,timeUs,fet1,fet2.'); return; }
    const record = { scope: match[1], seq: Number(match[2]), timeUs: Number(match[3]), levels: [Number(match[4]), Number(match[5])] };
    if (!Number.isSafeInteger(record.seq) || !Number.isSafeInteger(record.timeUs)) {
      this._protocolIssue('seq a timeUs musí být nezáporná bezpečná celá čísla.'); return;
    }
    if (this._lastArrival !== null && nowMs - this._lastArrival > this.options.staleMs) {
      this._issue('Příjem telemetrie byl přerušen; nelze spojovat pulzy přes výpadek.');
      this._breakContinuity();
    }
    if (this._scope !== null && record.scope !== this._scope) {
      this._issue('Změnil se zdroj telemetrie gpio/load; pro nový zdroj zahajte nový test.');
      this._breakContinuity();
    }
    const previous = this._previous;
    if (previous && (record.seq !== previous.seq + 1 || record.timeUs <= previous.timeUs)) {
      this._issue('Výpadek pořadí nebo restart hodin zařízení; neúplný pulz byl vyřazen.');
      this._breakContinuity();
    } else if (previous && record.timeUs - previous.timeUs > this.options.maxTelemetryGapMs * 1000) {
      this._issue('Příliš dlouhá mezera v čase zařízení; časování pulzu nelze ověřit.');
      this._breakContinuity();
    }
    this._disconnected = false;
    this._scope = record.scope;
    this._lastArrival = nowMs;
    this._received = Math.min(Number.MAX_SAFE_INTEGER, this._received + 1);
    this._levels = record.levels.map(Boolean);
    if (record.levels[0] && record.levels[1]) this._issue('FET1 a FET2 jsou podle telemetrie aktivní současně.', true);
    for (let index = 0; index < 2; index++) {
      const high = record.levels[index];
      const before = this._previous?.levels[index];
      if (before === undefined) {
        if (high) {
          this._issue(`FET${index + 1}: záznam začíná aktivním výstupem; začátek pulzu není znám.`);
          this._highSince[index] = record.timeUs;
        }
      } else if (!before && high) {
        this._starts[index] = record.timeUs;
        this._highSince[index] = record.timeUs;
      } else if (before && !high) {
        if (this._starts[index] !== null) {
          const duration = (record.timeUs - this._starts[index]) / 1000;
          const channel = this._channels[index];
          channel.pulses = Math.min(Number.MAX_SAFE_INTEGER, channel.pulses + 1);
          this._segmentPulses[index]++;
          channel.durationsMs.push(duration);
          if (channel.durationsMs.length > MAX_HISTORY) channel.durationsMs.shift();
          if (![this.options.actuationMs, this.options.neutralActuationMs].some(expected => Math.abs(duration - expected) <= this.options.toleranceMs)) {
            channel.invalid = true;
            this._issue(`${channel.name}: délka pulzu ${duration.toFixed(3)} ms neodpovídá ${this.options.actuationMs}/${this.options.neutralActuationMs} ms ± ${this.options.toleranceMs} ms.`, true);
          }
        }
        this._starts[index] = null;
        this._highSince[index] = null;
      }
      if (high && this._highSince[index] !== null &&
          (record.timeUs - this._highSince[index]) / 1000 > Math.max(this.options.actuationMs, this.options.neutralActuationMs) + this.options.toleranceMs) {
        this._channels[index].invalid = true;
        this._issue(`FET${index + 1}: výstup zůstává aktivní déle než povolený pulz.`, true);
      }
    }
    this._previous = record;
  }

  push(text, nowMs = Date.now()) {
    if (typeof text !== 'string') throw new TypeError('Telemetrie musí být text.');
    arrivalTime(nowMs);
    for (const character of text) {
      if (character === '\r' || character === '\n') {
        if (!this._dropping && this._tail) this._line(this._tail, nowMs);
        this._tail = '';
        this._dropping = false;
      } else if (!this._dropping) {
        if (this._tail.length + character.length > MAX_LINE) {
          if (this._tail.startsWith('MOSFET')) this._protocolIssue('řádek překročil limit 4096 znaků.');
          this._tail = '';
          this._dropping = true;
        } else this._tail += character;
      }
    }
    return this.snapshot(nowMs);
  }

  snapshot(nowMs = Date.now()) {
    arrivalTime(nowMs);
    const ageMs = this._lastArrival === null ? null : Math.max(0, nowMs - this._lastArrival);
    const active = this._levels.some(Boolean);
    const outputsKnown = this._levels.every(level => level !== null);
    const checks = [
      { name: 'Telemetrie výstupů', passed: this._received ? true : null,
        detail: this._received ? `${this._received} platných záznamů; zdroj ${this._scope}.` : 'Čekám na explicitní záznamy MOSFET; samotné CAN zprávy stavy výstupů nedokládají.' },
      { name: 'Souvislost měření', passed: this._uncertain ? null : this._received ? true : null,
        detail: this._uncertain ? 'Měření obsahuje neúplný úsek nebo chybu protokolu; zahajte nový test.' : 'Pořadí zpráv a čas zařízení musí být souvislé.' },
      { name: 'Výstupy a délky pulzů', passed: this._fault ? false : !active && this._segmentPulses.every(Boolean) ? true : null,
        detail: this._fault ? 'Telemetrie doložila souběh výstupů nebo nesprávnou délku pulzu.'
          : !active && this._segmentPulses.every(Boolean) ? `Pozorované délky odpovídají ${this.options.actuationMs}/${this.options.neutralActuationMs} ms ± ${this.options.toleranceMs} ms; bez souběhu.`
            : 'Čekám na úplné pulzy obou výstupů a jejich vypnutí.' },
      ...this._channels.map((channel, index) => ({ name: `${channel.name}: dokončený pulz`,
        passed: channel.invalid ? false : this._segmentPulses[index] ? true : null,
        detail: `${channel.pulses} dokončených pulzů celkem; ${this._segmentPulses[index]} v souvislém úseku.` })),
      { name: 'Dokončení aktuálních pulzů', passed: active ? null : outputsKnown ? true : null,
        detail: !outputsKnown ? 'Stav výstupů není znám.' : active ? 'Výstup je dosud aktivní; čekám na vypnutí.' : 'Poslední pozorované výstupy jsou vypnuté.' },
    ];
    let status;
    if (this._disconnected) status = 'disconnected';
    else if (ageMs !== null && ageMs > this.options.staleMs) status = 'stale';
    else if (this._fault) status = 'fail';
    else if (this._uncertain) status = 'inconclusive';
    else if (!this._received) status = 'waiting';
    else if (!active && this._segmentPulses.every(Boolean)) status = 'pass';
    else status = 'monitoring';
    const scopeNote = this._scope === 'gpio'
      ? 'Telemetrie řídicího registru GPIO; nepotvrzuje napětí pinu ani elektrickou funkci MOSFETu a zátěže.'
      : this._scope === 'load' ? 'Normalizovaná zpětná vazba externího měřicího zařízení; závěr se týká zaznamenaných stavů.' : '';
    const descriptions = {
      waiting: 'Čekám na telemetrii MOSFET z USB.', monitoring: 'Sleduji výstupy; dokončete test obou kanálů.',
      pass: 'Pozorované pulzy obou výstupů splnily kontrolu časování a souběhu.', fail: 'V telemetrii výstupů byla zjištěna chyba.',
      inconclusive: 'Výsledek není průkazný; zahajte nové souvislé měření.', stale: 'Telemetrie výstupů není aktuální.',
      disconnected: 'USB je odpojeno; uložené výsledky nejsou živý stav.',
    };
    return { status, scope: this._scope, summary: `${descriptions[status]}${scopeNote ? ' ' + scopeNote : ''}`,
      fet1: this._levels[0], fet2: this._levels[1], ageMs, received: this._received,
      channels: this._channels.map(({ name, pulses, durationsMs }) => ({ name, pulses, durationsMs: [...durationsMs] })),
      issues: [...this._issues], checks };
  }
}

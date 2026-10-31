// Platform-independent desktop application controller. The physics, protocols
// and UART parser below are the same modules exercised by the browser tests.
import { VehicleSimulator } from '../src/simulator.js';
import { ShiftingUnit } from '../src/shifting-unit.js';
import { TulSerialParser } from '../src/tul-serial.js';
import { validateProfile, encodeFrame, decodeFrame, formatCandump, parseCandump, parseSlcanLine } from '../src/can.js';
import { TUL_CAN_PROFILE, TUL_PROTOCOL_FACTS, makeTulRequest, makeTulGear, makeTulRpm, decodeTulFrame } from '../src/tul-protocol.js';

export class DesktopController {
  constructor() {
    this.vehicle = new VehicleSimulator();
    this.unit = new ShiftingUnit();
    this.profile = validateProfile(TUL_CAN_PROFILE);
    this.decoder = 'tul-current';
    this.frames = [];
    this.received = 0;
    this.paused = false;
    this.capturePaused = false;
    this.uart = new TulSerialParser();
    this.reset();
  }

  reset() {
    this.vehicle.reset();
    this.unit.reset();
    this.pedals = { throttle: 0, brake: 0, clutch: 1 };
    this.between = false;
    this.nextBus = 0;
    this.periodic = new Map();
    this.history = [];
    this.sampleAt = -1;
    this.accumulator = 0;
    this.message = 'Nastartujte, zařaďte 1, uvolněte spojku a přidejte plyn.';
  }

  sensors() {
    const s = this.vehicle.state;
    return { rpm: s.rpm, gear: this.between || s.shiftInProgress ? 7 : s.gear };
  }

  record(frame, source = 'sim') {
    if (this.capturePaused) return;
    this.frames.push({ ...frame, data: Array.from(frame.data), source,
      direction: source === 'sim' ? 'tx' : 'rx',
      interfaceName: frame.interfaceName ?? (source === 'sim' ? 'sim0' : source === 'uart' ? 'uart0' : 'can0'),
      timestamp: frame.timestamp ?? Date.now() / 1000,
      simulationElapsed: source === 'sim' ? this.vehicle.state.elapsed : undefined });
    if (this.frames.length > 5000) this.frames.splice(0, this.frames.length - 5000);
    this.received++;
  }

  emit(definition, extra = {}) {
    try { this.record(encodeFrame(definition, { ...this.vehicle.state, ...extra })); }
    catch (e) { this.message = `Rámec ${definition.name}: ${e.message}`; }
  }

  tick(seconds) {
    if (this.paused) return;
    this.accumulator += Math.min(0.25, Math.max(0, seconds));
    while (this.accumulator + 1e-9 >= 0.01) {
      this.vehicle.step(0.01, this.pedals);
      this.unit.advance(10, this.sensors());
      if (this.unit.state.timeMs + 1e-6 >= this.nextBus) {
        for (const f of [makeTulRpm(Math.round(this.vehicle.state.rpm)), makeTulGear(this.sensors().gear), makeTulRequest('release')]) {
          this.unit.receive(f);
          this.record(f);
        }
        this.nextBus = this.unit.state.timeMs + 50;
      }
      const elapsed = this.vehicle.state.elapsed;
      for (const def of this.profile.frames.filter(f => f.trigger === 'periodic')) {
        const next = this.periodic.get(def) ?? 0;
        if (elapsed + 1e-7 >= next) {
          this.emit(def);
          this.periodic.set(def, Math.max(next + def.periodMs / 1000, elapsed));
        }
      }
      if (elapsed - this.sampleAt >= 0.1) {
        this.history.push({ time: elapsed, rpm: this.vehicle.state.rpm, speedKph: this.vehicle.state.speedKph });
        this.history = this.history.filter(p => elapsed - p.time <= 30);
        this.sampleAt = elapsed;
      }
      this.accumulator -= 0.01;
    }
  }

  request(command) {
    if (this.paused) { this.message = 'Nejprve pokračujte v simulaci.'; return; }
    this.unit.advance(0, this.sensors());
    const f = makeTulRequest(command);
    this.record(f);
    const result = this.unit.receive(f);
    if (result?.accepted) {
      this.vehicle.actuateGear(result.targetGear, result.pulseMs / 1000);
      this.unit.receive(makeTulGear(7));
      this.record(makeTulGear(7));
    }
    this.message = result?.reason ?? 'Původní parser očekává 0x642, letošní volant používá 0x666 / byte6.';
    if (command === 'up' || command === 'down') {
      for (const def of this.profile.frames.filter(f => f.trigger === 'paddle' || f.trigger === (command === 'up' ? 'upshift' : 'downshift'))) {
        this.emit(def, { upshift: +(command === 'up'), downshift: +(command === 'down') });
      }
    }
  }

  validateProfile(raw) {
    const profile = validateProfile(raw);
    const sources = { ...this.vehicle.state, upshift: 0, downshift: 0 };
    for (const f of profile.frames.filter(f => f.trigger !== 'receive')) {
      for (const signal of f.signals) {
        if (!Object.hasOwn(sources, signal.source)) throw new Error(`Neznámý zdroj: ${signal.source}`);
      }
    }
    return profile;
  }

  configure(raw) {
    if (raw.schemaVersion !== 1 || !raw.vehicle || !raw.shiftingUnit || !raw.canProfile) throw new Error('Neplatný formát kalibrace.');
    const vehicle = new VehicleSimulator(raw.vehicle);
    const unit = new ShiftingUnit(raw.shiftingUnit);
    const profile = this.validateProfile(raw.canProfile);
    if (!['tul-current', 'profile'].includes(raw.protocolDecoder)) throw new Error('Neplatný dekodér.');
    if (unit.config.mode === 'reference' && unit.config.protocol !== 'current-car') throw new Error('Pro starý protokol zvolte diagnostický režim.');
    if (vehicle.config.gearRatios.some((r, i) => r !== unit.config.ratios[i + 1])) throw new Error('Převody vozu a jednotky se musí shodovat.');
    // All parts validated before committing any state.
    this.vehicle = vehicle;
    this.unit = unit;
    this.profile = profile;
    this.decoder = raw.protocolDecoder;
    this.reset();
    this.message = 'Kalibrace načtena. Skutečný firmware se nemění.';
  }

  calibration() {
    return { schemaVersion: 1, vehicle: this.vehicle.config, shiftingUnit: this.unit.config,
      canProfile: this.profile, protocolDecoder: this.decoder,
      assumptions: ['Model vozu není kalibrován.', 'Kódy 1/2/0x40 a maska 0x43 vyžadují ověření.', 'Virtuální sběrnice 50 ms a ideální pneumatika jsou model.'] };
  }

  serial(text) { for (const f of this.uart.push(text)) this.record({ ...f, timestampOrigin: 'receipt-time' }, 'uart'); }
  flushSerial(reason = 'idle') {
    for (const f of this.uart.flush({ includePartial: false, reason })) this.record({ ...f, timestampOrigin: 'receipt-time' }, 'uart');
  }

  importLog(text) {
    let frames;
    if (/^ID is \d+/m.test(text)) {
      const parser = new TulSerialParser();
      frames = [...parser.push(text), ...parser.flush()].map(f => ({ ...f, timestamp: 0, timestampOrigin: 'unknown', interfaceName: 'uart0' }));
    } else frames = parseCandump(text);
    if (!frames.length) throw new Error('Soubor neobsahuje Classical CAN rámce.');
    const imported = frames.map(f => {
      const uart = /^uart\d+$/.test(f.interfaceName ?? '');
      return { ...f, ...(uart ? { reconstructed: true, dlcInferred: true, timestampOrigin: f.timestamp === 0 ? 'unknown' : 'receipt-time' } : {}),
        data: Array.from(f.data), source: 'import', direction: 'rx' };
    });
    this.frames = [...this.frames, ...imported].slice(-5000);
    this.received += imported.length;
    this.message = `Importováno ${frames.length} rámců.`;
  }

  snapshot({ filter = '', direction = 'all' } = {}) {
    filter = filter.trim().toLowerCase().replace(/^0x/, '');
    const rows = this.frames.filter(f => {
      const id = f.id.toString(16).padStart(f.extended ? 8 : 3, '0');
      const data = f.data.map(b => b.toString(16).padStart(2, '0')).join(' ');
      return (direction === 'all' || f.direction === direction) && (!filter || id.includes(filter) || data.includes(filter));
    }).slice(-200).reverse().map(f => {
      let decoded;
      try { decoded = this.decoder === 'tul-current' ? decodeTulFrame(f) : decodeFrame(f, this.profile); }
      catch (e) { decoded = { chyba: e.message }; }
      return { ...f, decoded };
    });
    return { vehicle: this.vehicle.state, unit: this.unit.state, profile: this.profile,
      paused: this.paused, capturePaused: this.capturePaused, pedals: this.pedals,
      between: this.between, mode: this.unit.config.mode,
      count: this.received, retained: this.frames.length, rows, history: this.history,
      redline: this.vehicle.config.redlineRpm, message: this.message };
  }

  dispatch(command, arg = {}) {
    switch (command) {
      case 'tick': this.tick(arg.seconds); break;
      case 'pedals':
        for (const key of ['throttle', 'brake', 'clutch']) if (Number.isFinite(arg[key])) this.pedals[key] = Math.min(1, Math.max(0, arg[key]));
        break;
      case 'ignition': this.vehicle.step(0, this.pedals); this.message = this.vehicle.toggleIgnition().reason; break;
      case 'request': this.request(arg.command); break;
      case 'pause': this.paused = !this.paused; this.accumulator = 0; break;
      case 'capture': this.capturePaused = !this.capturePaused; break;
      case 'clear': this.frames = []; this.received = 0; break;
      case 'reset': this.reset(); break;
      case 'between': this.between = !!arg.value; this.unit.advance(0, this.sensors()); this.record(makeTulGear(this.sensors().gear)); break;
      case 'mode': this.unit.configure({ mode: arg.mode }); this.reset(); break;
      case 'serial': this.serial(arg.text); break;
      case 'serialIdle': this.flushSerial(); break;
      case 'serialReset': this.flushSerial('disconnect'); this.uart = new TulSerialParser(); break;
      case 'slcan': {
        const f = parseSlcanLine(arg.text);
        if (f) this.record({ ...f, timestamp: Date.now() / 1000, timestampOrigin: 'receipt-time' }, 'hardware');
        break;
      }
      case 'import': this.importLog(arg.text); break;
      case 'profile': this.profile = this.validateProfile(arg); this.decoder = 'profile'; this.periodic = new Map(); break;
      case 'defaultProfile': this.profile = validateProfile(TUL_CAN_PROFILE); this.decoder = 'tul-current'; this.periodic = new Map(); break;
      case 'configure': this.configure(arg); break;
      case 'calibration': return this.calibration();
      case 'exportProfile': return this.profile;
      case 'exportJson': return { schemaVersion: 2, profile: this.profile, vehicle: this.vehicle.config, shiftingUnit: this.unit.config, facts: TUL_PROTOCOL_FACTS, frames: this.frames };
      case 'exportLog': return { text: '# sim0=virtual; uart0=debug reconstruction, inferred DLC; timestamp 0=unknown\n' + this.frames.map(f => formatCandump(f, f.timestamp, f.interfaceName)).join('\n') + '\n' };
      case 'snapshot': return this.snapshot(arg);
      default: throw new Error(`Neznámá operace: ${command}`);
    }
    return {};
  }
}

const app = new DesktopController();
// The native bridge accepts structured JSON, never evaluates imported data.
globalThis.desktopDispatch = (command, args) => JSON.stringify(app.dispatch(command, JSON.parse(args)));

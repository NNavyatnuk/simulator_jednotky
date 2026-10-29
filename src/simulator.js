/**
 * Demonstration longitudinal model. Parameters and launch/idle assistance are
 * illustrative; they do not reproduce a particular Formula car or ECU.
 * Clutch 1 = pedal depressed (disconnected), clutch 0 = connected.
 */
export const DEFAULT_VEHICLE_CONFIG = Object.freeze({
  massKg: 280,
  peakTorqueNm: 78,
  wheelRadiusM: 0.24,
  finalDrive: 3.6,
  // Ratios from the supplied shifting.h; current-car applicability is unverified.
  gearRatios: Object.freeze([39 / 14, 39 / 19, 37 / 22, 29 / 20, 30 / 23, 26 / 22]),
  idleRpm: 1500,
  redlineRpm: 14000,
  shiftDurationS: 0.10,
  dragArea: 0.7,
  rollingResistance: 0.018,
  brakeDeceleration: 13,
});

const LIMITS = {
  massKg: [100, 3000], peakTorqueNm: [1, 2000],
  wheelRadiusM: [0.1, 0.6], finalDrive: [0.5, 12],
  idleRpm: [400, 5000], redlineRpm: [1000, 25000],
  shiftDurationS: [0.02, 2], dragArea: [0, 5],
  rollingResistance: [0, 0.1], brakeDeceleration: [1, 30],
};
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

function configuration(overrides = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Parametry vozidla musí být objekt.');
  }
  for (const key of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_VEHICLE_CONFIG, key)) throw new RangeError(`Neznámý parametr: ${key}`);
  }
  const config = { ...DEFAULT_VEHICLE_CONFIG, ...overrides };
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (typeof config[key] !== 'number' || !Number.isFinite(config[key]) || config[key] < min || config[key] > max) {
      throw new RangeError(`Parametr ${key} musí být číslo v rozsahu ${min}–${max}.`);
    }
  }
  if (config.redlineRpm <= config.idleRpm + 500) {
    throw new RangeError('Omezovač musí být alespoň 500 ot/min nad volnoběhem.');
  }
  if (!Array.isArray(config.gearRatios) || config.gearRatios.length !== 6 ||
      config.gearRatios.some((ratio, index, ratios) => !Number.isFinite(ratio) || ratio <= 0 || ratio > 10 || (index && ratio >= ratios[index - 1]))) {
    throw new RangeError('Zadejte šest kladných, sestupně seřazených převodových poměrů (nejvýše 10).');
  }
  return Object.freeze({ ...config, gearRatios: Object.freeze([...config.gearRatios]) });
}

export class VehicleSimulator {
  constructor(config = {}) {
    this.config = configuration(config);
    this.reset();
  }

  get state() {
    return { ...this._state, lastShift: this._state.lastShift ? { ...this._state.lastShift } : null };
  }

  configure(overrides) {
    // Validate completely before replacing the working configuration.
    const next = configuration({ ...this.config, ...overrides });
    this.config = next;
    return this.reset();
  }

  reset() {
    this._state = {
      rpm: 0, speedKph: 0, gear: 0, engineOn: false,
      throttle: 0, brake: 0, clutch: 1, coolantC: 22,
      elapsed: 0, shiftInProgress: false, lastShift: null,
      revLimiter: false,
    };
    this._pendingGear = null;
    this._shiftRemaining = 0;
    return this.state;
  }

  toggleIgnition() {
    const state = this._state;
    if (state.engineOn) {
      state.engineOn = false;
      state.rpm = 0;
      state.revLimiter = false;
      return { accepted: true, reason: 'Motor vypnut.' };
    }
    if (state.gear !== 0 && state.clutch < 0.8) {
      return { accepted: false, reason: 'Pro start zařaďte neutrál nebo sešlápněte spojku.' };
    }
    state.engineOn = true;
    state.rpm = this.config.idleRpm;
    return { accepted: true, reason: 'Motor nastartován.' };
  }

  _wheelRpm(gear) {
    if (gear === 0) return 0;
    return this._state.speedKph / 3.6 / (2 * Math.PI * this.config.wheelRadiusM) * 60 *
      this.config.finalDrive * this.config.gearRatios[gear - 1];
  }

  /** Mechanical response to an accepted external controller pulse. This models
   * an ideal actuator/gear sensor; it is not a second shifting decision. */
  actuateGear(targetGear, durationSeconds) {
    if (!Number.isInteger(targetGear) || targetGear < 0 || targetGear > 6 ||
        !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 10) {
      throw new RangeError('Neplatný cílový stupeň nebo doba pulzu.');
    }
    if (this._state.shiftInProgress) return false;
    this._pendingGear = targetGear;
    this._shiftRemaining = durationSeconds;
    this._state.shiftInProgress = true;
    return true;
  }

  shift(direction) {
    let reason;
    const state = this._state;
    const nextGear = state.gear + direction;
    if (direction !== 1 && direction !== -1) reason = 'Směr řazení musí být +1 nebo −1.';
    else if (state.shiftInProgress) reason = 'Probíhá řazení.';
    else if (nextGear < 0) reason = 'Je zařazen neutrál.';
    else if (nextGear > this.config.gearRatios.length) reason = 'Je zařazen nejvyšší stupeň.';
    else if (direction < 0 && nextGear > 0 && this._wheelRpm(nextGear) > this.config.redlineRpm) {
      reason = 'Podřazení odmítnuto: hrozí přetočení motoru.';
    }
    if (reason) {
      state.lastShift = { accepted: false, reason, direction };
      return { ...state.lastShift };
    }
    this._pendingGear = nextGear;
    this._shiftRemaining = this.config.shiftDurationS;
    state.shiftInProgress = true;
    state.lastShift = {
      accepted: true,
      reason: `Řazení ${state.gear || 'N'} → ${nextGear || 'N'}.`,
      direction,
    };
    return { ...state.lastShift };
  }

  step(dtSeconds, inputs = {}) {
    if (!Number.isFinite(dtSeconds) || dtSeconds < 0) return this.state;
    if (inputs && typeof inputs === 'object') {
      for (const key of ['throttle', 'brake', 'clutch']) {
        if (typeof inputs[key] === 'number' && Number.isFinite(inputs[key])) {
          this._state[key] = clamp(inputs[key], 0, 1);
        }
      }
    }
    if (dtSeconds === 0) return this.state;
    // Cap a suspended browser's delta to 250 ms: resuming a tab must not jump
    // the car through minutes of unattended driving. 5 ms substeps preserve
    // stable and repeatable integration at ordinary rendering frame rates.
    const duration = Math.min(dtSeconds, 0.25);
    const count = Math.ceil(duration / 0.005);
    const dt = duration / count;
    for (let i = 0; i < count; i++) this._integrate(dt);
    return this.state;
  }

  _integrate(dt) {
    const state = this._state;
    const config = this.config;
    const changingGear = state.shiftInProgress;
    if (changingGear) {
      this._shiftRemaining -= dt;
      if (this._shiftRemaining <= 1e-10) {
        state.gear = this._pendingGear;
        this._pendingGear = null;
        state.shiftInProgress = false;
      }
    }
    const engagement = state.gear === 0 || changingGear ? 0 : 1 - state.clutch;
    const wheelRpm = this._wheelRpm(state.gear);
    const freeRpm = config.idleRpm + state.throttle * (config.redlineRpm - config.idleRpm);
    const coupledRpm = Math.max(config.idleRpm, wheelRpm);
    if (state.engineOn) {
      const targetRpm = freeRpm + (coupledRpm - freeRpm) * engagement;
      const response = engagement > 0.9 ? 22 : 5;
      state.rpm += (targetRpm - state.rpm) * (1 - Math.exp(-response * dt));
      state.rpm = clamp(state.rpm, config.idleRpm, config.redlineRpm);
    } else {
      state.rpm = 0;
    }
    // Hysteresis prevents the limiter toggling on every numerical substep.
    if (!state.engineOn) state.revLimiter = false;
    else if (state.rpm >= config.redlineRpm * 0.99 || (engagement > 0 && wheelRpm >= config.redlineRpm)) state.revLimiter = true;
    else if (state.rpm < config.redlineRpm * 0.97 && wheelRpm < config.redlineRpm * 0.97) state.revLimiter = false;

    const ratio = state.gear > 0 ? config.gearRatios[state.gear - 1] * config.finalDrive : 0;
    // Broad torque curve plus a drive cut while changing gear or limiting RPM.
    const torqueCurve = 0.58 + 0.42 * Math.sin(Math.PI * clamp(state.rpm / config.redlineRpm, 0, 1));
    const driveTorque = state.engineOn && !state.revLimiter ? state.throttle * config.peakTorqueNm * torqueCurve : 0;
    const engineBrakeTorque = wheelRpm > config.idleRpm ? (1 - state.throttle) * (config.peakTorqueNm * 0.12 + wheelRpm * 0.0005) : 0;
    const driveForce = (driveTorque - engineBrakeTorque) * engagement * ratio * 0.94 / config.wheelRadiusM;
    const speedMs = state.speedKph / 3.6;
    const dragForce = 0.5 * 1.225 * config.dragArea * speedMs * speedMs;
    const rollingForce = speedMs > 0.01 ? config.massKg * 9.81 * config.rollingResistance : 0;
    const brakeForce = state.brake * config.brakeDeceleration * config.massKg;
    const acceleration = (driveForce - dragForce - rollingForce - brakeForce) / config.massKg;
    state.speedKph = Math.max(0, (speedMs + acceleration * dt) * 3.6);
    const targetCoolant = state.engineOn ? 80 + state.throttle * 15 : 22;
    state.coolantC += (targetCoolant - state.coolantC) * (1 - Math.exp(-dt / 150));
    state.elapsed += dt;
  }
}

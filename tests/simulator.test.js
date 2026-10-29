import test from 'node:test';
import assert from 'node:assert/strict';
import { VehicleSimulator, DEFAULT_VEHICLE_CONFIG } from '../src/simulator.js';

const run = (sim, seconds, inputs = {}, hz = 100) => {
  for (let i = 0; i < Math.round(seconds * hz); i++) sim.step(1 / hz, inputs);
  return sim.state;
};

test('external controller pulse changes the ideal gear sensor only after actuation', () => {
  const sim = new VehicleSimulator();
  assert.equal(sim.actuateGear(2, 0.1), true);
  assert.equal(sim.state.gear, 0);
  assert.equal(sim.actuateGear(1, 0.1), false);
  run(sim, 0.1);
  assert.equal(sim.state.gear, 2);
  assert.equal(sim.actuateGear(0, 0.05), true);
  run(sim, 0.05);
  assert.equal(sim.state.gear, 0);
  assert.throws(() => sim.actuateGear(7, 0.1));
  assert.equal(sim.actuateGear(1, 3), true);
  run(sim, 2.5);
  assert.equal(sim.state.gear, 0);
  run(sim, 0.5);
  assert.equal(sim.state.gear, 1);
  assert.throws(() => sim.actuateGear(1, 11));
});
const firstGear = (sim) => {
  assert.equal(sim.toggleIgnition().accepted, true);
  assert.equal(sim.shift(1).accepted, true);
  run(sim, 0.2);
  assert.equal(sim.state.gear, 1);
};

test('starts in neutral and ignition idles without moving', () => {
  const sim = new VehicleSimulator();
  assert.equal(sim.state.engineOn, false);
  assert.equal(sim.state.gear, 0);
  assert.equal(sim.state.clutch, 1);
  assert.equal(sim.toggleIgnition().accepted, true);
  const state = run(sim, 10, { throttle: 0 });
  assert.equal(state.speedKph, 0);
  assert.equal(state.rpm, DEFAULT_VEHICLE_CONFIG.idleRpm);
  assert.ok(state.coolantC > 22);
});

test('neutral and a disconnected clutch cannot propel the vehicle', () => {
  const sim = new VehicleSimulator();
  sim.toggleIgnition();
  assert.equal(run(sim, 3, { throttle: 1, clutch: 0 }).speedKph, 0);
  assert.ok(sim.state.rpm > 12000);
  sim.shift(1);
  run(sim, 3, { clutch: 1 });
  assert.equal(sim.state.gear, 1);
  assert.equal(sim.state.speedKph, 0);
});

test('throttle accelerates and braking stops a moving vehicle', () => {
  const sim = new VehicleSimulator();
  firstGear(sim);
  const moving = run(sim, 4, { throttle: 0.9, clutch: 0 });
  assert.ok(moving.speedKph > 30);
  assert.ok(moving.rpm > 3000);
  const stopped = run(sim, 5, { throttle: 0, brake: 1, clutch: 1 });
  assert.equal(stopped.speedKph, 0);
  assert.ok(stopped.rpm <= DEFAULT_VEHICLE_CONFIG.idleRpm + 1);
});

test('gear changes take time and overlapping paddle requests are rejected', () => {
  const sim = new VehicleSimulator();
  sim.toggleIgnition();
  assert.equal(sim.shift(1).accepted, true);
  assert.equal(sim.state.gear, 0);
  assert.equal(sim.state.shiftInProgress, true);
  assert.equal(sim.shift(1).accepted, false);
  sim.step(sim.config.shiftDurationS - 0.01);
  assert.equal(sim.state.gear, 0);
  sim.step(0.01);
  assert.equal(sim.state.gear, 1);
  assert.equal(sim.state.shiftInProgress, false);
});

test('downshift rejects an overrev and rev limiter caps acceleration', () => {
  const sim = new VehicleSimulator();
  firstGear(sim);
  run(sim, 8, { throttle: 1, clutch: 0 });
  assert.ok(sim.state.rpm <= sim.config.redlineRpm);
  assert.ok(sim.state.speedKph < 125);
  assert.equal(sim.shift(1).accepted, true);
  run(sim, 4, { throttle: 1 });
  const speedBefore = sim.state.speedKph;
  const result = sim.shift(-1);
  assert.equal(result.accepted, false);
  assert.match(result.reason, /přetočení/);
  assert.equal(sim.state.gear, 2);
  assert.equal(sim.state.speedKph, speedBefore);
});

test('stays within neutral and the highest gear', () => {
  const sim = new VehicleSimulator();
  assert.equal(sim.shift(-1).accepted, false);
  assert.equal(sim.shift(0).accepted, false);
  for (let gear = 1; gear <= 6; gear++) {
    assert.equal(sim.shift(1).accepted, true);
    sim.step(0.2);
    assert.equal(sim.state.gear, gear);
  }
  assert.equal(sim.shift(1).accepted, false);
});

test('engine off produces no tractive force and starting in gear needs the clutch', () => {
  const sim = new VehicleSimulator();
  sim.shift(1);
  run(sim, 1, { throttle: 1, clutch: 0 });
  assert.equal(sim.state.speedKph, 0);
  assert.equal(sim.toggleIgnition().accepted, false);
  sim.step(0.01, { clutch: 1 });
  assert.equal(sim.toggleIgnition().accepted, true);
});

test('zero-time pedal update applies ignition interlock without advancing simulation', () => {
  const sim = new VehicleSimulator();
  sim.shift(1);
  sim.step(0.2);
  const elapsed = sim.state.elapsed;
  sim.step(0, { clutch: 0 });
  assert.equal(sim.state.elapsed, elapsed);
  assert.equal(sim.toggleIgnition().accepted, false);
  sim.step(0, { clutch: 1, throttle: 0.25 });
  assert.equal(sim.state.elapsed, elapsed);
  assert.equal(sim.state.throttle, 0.25);
  assert.equal(sim.toggleIgnition().accepted, true);
});

test('invalid time and control values do not poison state; valid controls clamp', () => {
  const sim = new VehicleSimulator();
  firstGear(sim);
  const before = sim.state;
  sim.step(Infinity, { throttle: 1 });
  sim.step(NaN);
  sim.step(-1);
  assert.deepEqual(sim.state, before);
  const state = sim.step(0.1, { throttle: NaN, brake: Infinity, clutch: -20 });
  assert.equal(state.throttle, 0);
  assert.equal(state.brake, 0);
  assert.equal(state.clutch, 0);
  assert.equal(sim.step(0.01, { throttle: 500 }).throttle, 1);
  for (const value of Object.values(sim.state)) {
    if (typeof value === 'number') assert.ok(Number.isFinite(value));
  }
});

test('substeps produce consistent behavior across frame rates and cap suspend gaps', () => {
  const slow = new VehicleSimulator();
  const fast = new VehicleSimulator();
  firstGear(slow);
  firstGear(fast);
  run(slow, 5, { throttle: 0.8, clutch: 0 }, 25);
  run(fast, 5, { throttle: 0.8, clutch: 0 }, 100);
  assert.ok(Math.abs(slow.state.speedKph - fast.state.speedKph) < 0.01);
  assert.ok(Math.abs(slow.state.rpm - fast.state.rpm) < 2);
  const before = slow.state.elapsed;
  slow.step(3600);
  assert.ok(Math.abs(slow.state.elapsed - before - 0.25) < 1e-9);
});

test('config validation is transactional and reset restores controls and state', () => {
  const sim = new VehicleSimulator();
  assert.throws(() => new VehicleSimulator({ massKg: 0 }), /massKg/);
  assert.throws(() => new VehicleSimulator({ redlineRpm: 1600 }), /Omezovač/);
  assert.throws(() => new VehicleSimulator({ gearRatios: [1, 2, 3, 4, 5, 6] }), /převodových/);
  assert.throws(() => new VehicleSimulator({ arbitrary: 3 }), /Neznámý/);
  assert.throws(() => new VehicleSimulator({ toString: 3 }), /Neznámý/);
  assert.throws(() => new VehicleSimulator(JSON.parse('{"__proto__": 3}')), /Neznámý/);
  firstGear(sim);
  run(sim, 1, { throttle: 1, clutch: 0 });
  const before = sim.state;
  assert.throws(() => sim.configure({ massKg: NaN }), /massKg/);
  assert.deepEqual(sim.state, before);
  sim.configure({ massKg: 350 });
  assert.equal(sim.config.massKg, 350);
  assert.equal(sim.state.speedKph, 0);
  assert.equal(sim.state.engineOn, false);
  assert.equal(sim.state.gear, 0);
  const copy = sim.state;
  copy.rpm = 123456;
  assert.equal(sim.state.rpm, 0);
  assert.ok(Object.isFrozen(sim.config.gearRatios));
});

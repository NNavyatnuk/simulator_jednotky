import { VehicleSimulator } from './simulator.js';
import { validateProfile, encodeFrame, decodeFrame, formatCandump, parseCandump } from './can.js';
import { SlcanMonitor } from './slcan.js';
import { TulSerialMonitor, TulSerialParser } from './tul-serial.js';
import { TUL_CAN_PROFILE, TUL_PROTOCOL_FACTS, makeTulRequest, makeTulGear, makeTulRpm, decodeTulFrame } from './tul-protocol.js';
import { ShiftingUnit } from './shifting-unit.js';

const $ = id => document.getElementById(id);
const simulator = new VehicleSimulator();
let monitor = new TulSerialMonitor();
const unit = new ShiftingUnit();
let profile = validateProfile(TUL_CAN_PROFILE);
let useTulDecoder = true;
// Periods are virtual bench assumptions; the supplied unit only receives CAN.
const VIRTUAL_BUS_PERIOD_MS = 50;
let nextUnitBusMs = 0;
let paused = false;
let capturePaused = false;
let log = [];
let received = 0;
let nextPeriodic = new Map();
let history = [];
let lastSample = -1;
let logDirty = true;
let lastDraw = 0;
let accumulator = 0;
let connecting = false;
const MAX_LOG = 5000;
const MAX_DISPLAY = 200;

function message(text, error = false) {
  $('status-message').textContent = text;
  $('status-message').classList.toggle('is-error', error);
}

function control(name, value) {
  const element = $(name + '-input');
  element.value = value;
  $(name + '-value').textContent = `${Math.round(value)} %`;
}

for (const name of ['throttle', 'brake', 'clutch']) {
  control(name, name === 'clutch' ? 100 : 0);
  $(name + '-input').addEventListener('input', event => control(name, Number(event.target.value)));
}

function controls() {
  return Object.fromEntries(['throttle', 'brake', 'clutch'].map(name => [name, Number($(name + '-input').value) / 100]));
}

function pushFrame(frame, source = 'sim') {
  if (capturePaused) return;
  log.push({ ...frame, data: Array.from(frame.data), timestamp: frame.timestamp ?? Date.now() / 1000, simulationElapsed: source === 'sim' ? simulator.state.elapsed : undefined, interfaceName: source === 'sim' ? 'sim0' : frame.interfaceName ?? 'can0', direction: frame.direction ?? 'tx', source });
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  received += 1;
  logDirty = true;
}

function emit(definition, extra = {}) {
  try { pushFrame(encodeFrame(definition, { ...simulator.state, ...extra })); }
  catch (error) { message(`Rámec ${definition.name}: ${error.message}`, true); }
}

function unitSensors() {
  const state = simulator.state;
  return { rpm: state.rpm, gear: $('sensor-between').checked || state.shiftInProgress ? 7 : state.gear };
}

function sendUnitRequest(command) {
  if (paused) { message('Nejprve pokračujte v simulaci.'); return; }
  unit.advance(0, unitSensors());
  const frame = makeTulRequest(command);
  pushFrame(frame);
  const result = unit.receive(frame);
  if (result?.accepted) {
    // Ideal mechanics: the pulse drives the target gear; sensor shows 7 until complete.
    simulator.actuateGear(result.targetGear, result.pulseMs / 1000);
    unit.receive(makeTulGear(7));
    pushFrame(makeTulGear(7));
  }
  const reason = result?.reason ?? 'Původní firmware nerozpozná letošní požadavek: očekává 0x642, ale volant vysílá 0x666 / bajt 6.';
  $('unit-status').textContent = reason;
  message(reason, !result?.accepted);
  renderState();
}

function shift(direction) {
  sendUnitRequest(direction > 0 ? 'up' : 'down');
  for (const definition of profile.frames.filter(frame => frame.trigger === 'paddle' || frame.trigger === (direction > 0 ? 'upshift' : 'downshift'))) {
    emit(definition, { upshift: direction > 0 ? 1 : 0, downshift: direction < 0 ? 1 : 0 });
  }
}

$('ignition-btn').addEventListener('click', () => {
  // Apply pedals before starting so the clutch interlock uses the current control.
  simulator.step(0, controls());
  const result = simulator.toggleIgnition();
  message(result.reason, !result.accepted);
  renderState();
});
$('pause-btn').addEventListener('click', () => {
  paused = !paused;
  accumulator = 0;
  renderState();
});
$('reset-btn').addEventListener('click', () => {
  releaseKeys();
  simulator.reset();
  unit.reset();
  $('sensor-between').checked = false;
  $('unit-status').textContent = 'Jednotka resetována. Probíhá výchozí prodleva; kódy letošních příkazů stále vyžadují ověření.';
  nextUnitBusMs = 0;
  for (const name of ['throttle', 'brake', 'clutch']) control(name, name === 'clutch' ? 100 : 0);
  history = [];
  lastSample = -1;
  nextPeriodic = new Map();
  accumulator = 0;
  message('Simulace resetována. Záznam CAN zůstává zachován.');
  renderState();
});
$('shift-up-btn').addEventListener('click', () => shift(1));
$('shift-down-btn').addEventListener('click', () => shift(-1));
$('neutral-btn').addEventListener('click', () => sendUnitRequest('neutral'));
$('sensor-between').addEventListener('change', () => {
  unit.advance(0, unitSensors());
  pushFrame(makeTulGear(unit.state.currentGear));
  renderState();
});
$('unit-mode').addEventListener('change', event => {
  unit.configure({ mode: event.target.value });
  $('reset-btn').click();
  $('unit-status').textContent = event.target.value === 'firmware-parser'
    ? 'Diagnostika: UP/DOWN čte data[0], RPM jen byte 0x666 (0–255). Nejde o opravený firmware.'
    : 'Letošní mapa: 0x600 RPM LE16, 0x604 stupeň, 0x666 bajt 6. Kódy UP/DOWN/N a maska 0x43 jsou převzatý předpoklad.';
});
$('unit-form').addEventListener('submit', event => {
  event.preventDefault();
  try {
    const overrides = Object.fromEntries(Array.from(new FormData(event.target), ([key, value]) => [key, Number(value)]));
    const candidate = new ShiftingUnit({ ...unit.config, ...overrides });
    // Preserve the supplied header's 500rpm launch threshold when recalibrating.
    unit.configure({ ...overrides, ratios: [(500 * candidate.config.ratios[1]) / candidate.config.rpmLowerLimit, ...candidate.config.ratios.slice(1)] });
    $('reset-btn').click();
    message('Konstanty simulované jednotky aktualizovány. Skutečný firmware se nemění.');
  } catch (error) { message(error.message, true); }
});

const heldKeys = new Map();
const pedalKeys = { Space: 'throttle', KeyB: 'brake', KeyC: 'clutch' };
function releaseKeys() {
  for (const [code, previous] of heldKeys) control(pedalKeys[code], previous);
  heldKeys.clear();
}
document.addEventListener('keydown', event => {
  if (event.ctrlKey || event.altKey || event.metaKey || event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (event.code === 'Space' && event.target.closest('button')) return;
  if (event.code in pedalKeys) {
    event.preventDefault();
    if (!heldKeys.has(event.code)) heldKeys.set(event.code, $(pedalKeys[event.code] + '-input').value);
    control(pedalKeys[event.code], 100);
  } else if (!event.repeat) {
    if (event.code === 'KeyE') { event.preventDefault(); shift(1); }
    if (event.code === 'KeyQ') { event.preventDefault(); shift(-1); }
    if (event.code === 'KeyI') { event.preventDefault(); $('ignition-btn').click(); }
    if (event.code === 'KeyN') { event.preventDefault(); sendUnitRequest('neutral'); }
  }
});
document.addEventListener('keyup', event => {
  if (heldKeys.has(event.code)) {
    event.preventDefault();
    control(pedalKeys[event.code], heldKeys.get(event.code));
    heldKeys.delete(event.code);
  }
});
window.addEventListener('blur', releaseKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseKeys(); });

function renderState() {
  const state = simulator.state;
  $('rpm-value').textContent = Math.round(state.rpm).toLocaleString('cs-CZ');
  $('speed-value').textContent = state.speedKph.toFixed(1);
  $('gear-value').textContent = state.gear === 0 ? 'N' : String(state.gear);
  $('coolant-value').textContent = Math.round(state.coolantC);
  $('rpm-bar').style.width = `${Math.min(100, state.rpm / simulator.config.redlineRpm * 100)}%`;
  $('rpm-bar').classList.toggle('redline', state.rpm > simulator.config.redlineRpm * 0.9);
  $('rpm-limit').textContent = simulator.config.redlineRpm.toLocaleString('cs-CZ');
  $('engine-status').textContent = state.engineOn ? 'Motor běží' : 'Motor vypnutý';
  $('engine-status').classList.toggle('active', state.engineOn);
  $('simulation-status').textContent = paused ? 'Pozastaveno' : 'Simulace běží';
  $('pause-btn').textContent = paused ? 'Pokračovat' : 'Pozastavit';
  $('pause-btn').setAttribute('aria-pressed', String(paused));
  $('ignition-btn').textContent = state.engineOn ? 'Vypnout motor' : 'Nastartovat';
  $('gear-value').classList.toggle('shifting', state.shiftInProgress);
  $('can-count').textContent = received.toLocaleString('cs-CZ');
  if ($('can-rate')) $('can-rate').textContent = String(3 * 1000 / VIRTUAL_BUS_PERIOD_MS + profile.frames.filter(frame => frame.trigger === 'periodic').reduce((rate, frame) => rate + 1000 / frame.periodMs, 0));
  $('capture-status').textContent = capturePaused ? 'Záznam pozastaven' : `Záznam aktivní · uchováno ${log.length.toLocaleString('cs-CZ')} / ${MAX_LOG.toLocaleString('cs-CZ')}`;
  $('connect-btn').disabled = connecting || !!monitor.port;
  $('disconnect-btn').disabled = connecting || !monitor.port;
  $('transport-select').disabled = connecting || !!monitor.port;
  const controller = unit.state;
  for (const [id, active] of [['unit-fet1', controller.fet1], ['unit-fet2', controller.fet2]]) {
    $(id).textContent = active ? 'ZAPNUTO' : 'Vypnuto';
    $(id).classList.toggle('energized', active);
  }
  $('unit-lastgear').textContent = controller.lastValidGear === 0 ? 'N' : String(controller.lastValidGear);
  $('unit-cooldown').textContent = `${Math.ceil(controller.cooldownMs)} ms`;
  $('unit-latch').textContent = controller.shiftingFlag ? `Uvolnění ${controller.shiftingFlag - 1}/${unit.config.rearmZeroFrames}` : 'Připraveno';
  $('unit-rpm').textContent = `${Math.round(controller.rpm).toLocaleString('cs-CZ')} ${unit.config.mode === 'firmware-parser' ? '(byte RPM)' : 'rpm modelu'}`;
}

function renderLog() {
  const filter = $('filter-input').value.trim().toLowerCase().replace(/^0x/, '');
  const direction = $('direction-filter').value;
  const rows = log.filter(frame => {
    const id = frame.id.toString(16).padStart(frame.extended ? 8 : 3, '0');
    const data = frame.data.map(value => value.toString(16).padStart(2, '0')).join(' ');
    return (direction === 'all' || frame.direction === direction) && (!filter || id.includes(filter) || data.includes(filter));
  }).slice(-MAX_DISPLAY).reverse();
  const fragment = document.createDocumentFragment();
  for (const frame of rows) {
    const row = document.createElement('tr');
    const timestamp = new Date(frame.timestamp * 1000);
    const time = frame.timestampOrigin === 'unknown' ? '—' : Number.isFinite(timestamp.getTime()) ? timestamp.toISOString().slice(11, 23) : '—';
    let signals = {};
    try { signals = useTulDecoder ? decodeTulFrame(frame) : decodeFrame(frame, profile); } catch {}
    const decoded = Object.entries(signals).map(([key, value]) => `${key}: ${typeof value === 'number' ? Number(value.toFixed(3)) : String(value)}`).join(' · ');
    const data = frame.data.map(value => value.toString(16).padStart(2, '0').toUpperCase()).join(' ');
    const cells = [time, frame.source === 'sim' ? 'SIM TX' : frame.source === 'import' ? `SOUBOR ${frame.interfaceName}` : frame.source === 'uart' ? 'UART RX*' : 'CAN RX', '0x' + frame.id.toString(16).padStart(frame.extended ? 8 : 3, '0').toUpperCase(), `${frame.data.length}${frame.dlcInferred ? '*' : ''}`, data || '—', decoded || 'Neznámý rámec'];
    cells.forEach((text, index) => {
      const cell = document.createElement('td');
      cell.textContent = text;
      if (index === 1) cell.className = frame.direction === 'tx' ? 'tx' : 'rx';
      row.append(cell);
    });
    fragment.append(row);
  }
  if (!rows.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.textContent = log.length ? 'Žádné rámce neodpovídají filtru.' : 'Čekám na první CAN rámce…';
    cell.className = 'empty-state';
    row.append(cell);
    fragment.append(row);
  }
  $('log-body').replaceChildren(fragment);
  if ($('log-visible')) $('log-visible').textContent = `Zobrazeno ${rows.length} nejnovějších odpovídajících rámců. Čas v UTC.`;
  logDirty = false;
}
for (const id of ['filter-input', 'direction-filter']) $(id).addEventListener('input', () => { logDirty = true; });
$('clear-log-btn').addEventListener('click', () => { log = []; received = 0; logDirty = true; renderState(); });
$('monitor-paused-btn').addEventListener('click', () => {
  capturePaused = !capturePaused;
  $('monitor-paused-btn').textContent = capturePaused ? 'Obnovit záznam' : 'Pozastavit záznam';
  $('monitor-paused-btn').setAttribute('aria-pressed', String(capturePaused));
  renderState();
});

function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
$('export-log-btn').addEventListener('click', () => download('can-zaznam.log', '# Formula Lab: sim0=virtual, uart0=reconstructed debug (DLC inferred; 0 timestamp=unknown). JSON retains full provenance.\n' + log.map(frame => formatCandump(frame, frame.timestamp, frame.interfaceName ?? 'can0')).join('\n') + (log.length ? '\n' : ''), 'text/plain'));
$('export-json-btn').addEventListener('click', () => download('can-zaznam.json', JSON.stringify({ schemaVersion: 2, profile, vehicle: simulator.config, shiftingUnit: unit.config, facts: TUL_PROTOCOL_FACTS, frames: log }, null, 2), 'application/json'));
$('export-profile-btn').addEventListener('click', () => download('can-profil.json', JSON.stringify(profile, null, 2), 'application/json'));

function renderProfile() {
  $('profile-name').textContent = profile.name;
  $('profile-description').textContent = `${profile.description ?? ''} · ${profile.bitrate / 1000} kbit/s`;
}
function validateAppProfile(raw) {
  const next = validateProfile(raw);
  const sources = { ...simulator.state, upshift: 0, downshift: 0 };
  for (const definition of next.frames.filter(frame => frame.trigger !== 'receive')) {
    for (const signal of definition.signals) {
      if (!Object.hasOwn(sources, signal.source)) throw new Error(`Neznámý zdroj „${signal.source}“. Pro čisté dekódování nastavte trigger na receive.`);
    }
  }
  return next;
}
$('unit-profile-btn').addEventListener('click', () => {
  if ((monitor.port || connecting) && profile.bitrate !== TUL_CAN_PROFILE.bitrate) {
    message('Před změnou bitrate nejprve odpojte adaptér.', true); return;
  }
  profile = validateProfile(TUL_CAN_PROFILE);
  useTulDecoder = true;
  nextPeriodic = new Map();
  logDirty = true;
  renderProfile();
  message('Obnoven letošní profil podle screenshotů ECU. Kódy řazení v bajtu 6 zůstávají předpoklad ze starého firmware.');
});
$('profile-input').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 128 * 1024) throw new Error('Profil může mít nejvýše 128 kB.');
    const next = validateAppProfile(JSON.parse(await file.text()));
    if ((monitor.port || connecting) && next.bitrate !== profile.bitrate) throw new Error('Před změnou bitrate nejprve dokončete připojování a odpojte CAN adaptér.');
    profile = next;
    useTulDecoder = false;
    nextPeriodic = new Map();
    logDirty = true;
    renderProfile();
    message(`Načten profil „${profile.name}“. Ověřte jej podle dokumentace svého vozu.`);
  } catch (error) { message(`Profil nebyl změněn: ${error.message}`, true); }
  event.target.value = '';
});
$('import-log-input').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 5 * 1024 * 1024) throw new Error('Záznam může mít nejvýše 5 MB.');
    const text = await file.text();
    let frames;
    if (/^ID is \d+/m.test(text)) {
      const parser = new TulSerialParser();
      frames = [...parser.push(text), ...parser.flush()].map(frame => ({ ...frame, timestamp: 0, timestampOrigin: 'unknown', importedAt: Date.now() / 1000, interfaceName: 'uart0' }));
    } else frames = parseCandump(text);
    if (!frames.length) throw new Error('Soubor neobsahuje žádné Classical CAN rámce.');
    // File import is explicit and independent from pausing the live recording.
    const imported = frames.map(frame => ({ ...frame, ...(/^uart\d+$/.test(frame.interfaceName ?? '') ? { reconstructed: true, dlcInferred: true, timestampOrigin: frame.timestamp === 0 ? 'unknown' : 'receipt-time' } : {}), data: Array.from(frame.data), direction: 'rx', source: 'import' }));
    log = [...log, ...imported].slice(-MAX_LOG);
    received += frames.length;
    logDirty = true;
    message(`Importováno ${frames.length} rámců. ${imported.some(frame => frame.reconstructed) ? 'UART rekonstrukce (*): DLC odvozené, původní čas CAN není znám.' : 'Dekódování používá aktuální CAN profil.'}`);
    renderState();
  } catch (error) { message(`Import se nezdařil: ${error.message}`, true); }
  event.target.value = '';
});

$('connect-btn').addEventListener('click', async () => {
  connecting = true;
  const uart = $('transport-select').value === 'tul-uart';
  monitor = uart ? new TulSerialMonitor() : new SlcanMonitor();
  $('hardware-status').textContent = uart ? 'Čekám na USB port řadicí jednotky…' : 'Čekám na adaptér a potvrzení režimu listen-only…';
  renderState();
  try {
    await monitor.connect({
      bitrate: profile.bitrate,
      onFrame: frame => pushFrame({ ...frame, timestamp: Date.now() / 1000, timestampOrigin: 'receipt-time', direction: 'rx', interfaceName: uart ? 'uart0' : 'can0' }, uart ? 'uart' : 'hardware'),
      onStatus: text => { $('hardware-status').textContent = text; renderState(); },
    });
    message(uart ? 'USB jednotky připojeno: pouze čtu debug výpis. DLC je odvozené (*), nejde o bezeztrátový CAN záznam.' : 'CAN adaptér připojen v režimu pouze pro příjem.');
  } catch (error) {
    $('hardware-status').textContent = 'Nepřipojeno';
    message(error.message, true);
  } finally { connecting = false; renderState(); }
});
$('disconnect-btn').addEventListener('click', async () => {
  connecting = true;
  renderState();
  await monitor.disconnect();
  connecting = false;
  $('hardware-status').textContent = 'Nepřipojeno';
  renderState();
});

$('model-form').addEventListener('submit', event => {
  event.preventDefault();
  const configuration = Object.fromEntries(Array.from(new FormData(event.target), ([key, value]) => [key, Number(value)]));
  try {
    const gearRatios = Array.from({ length: 6 }, (_, index) => configuration[`gearRatio${index + 1}`]);
    for (let i = 1; i <= 6; i++) delete configuration[`gearRatio${i}`];
    const vehicleConfig = { ...simulator.config, ...configuration, gearRatios };
    const unitConfig = { ...unit.config, ratios: [(500 * gearRatios[0]) / unit.config.rpmLowerLimit, ...gearRatios] };
    new VehicleSimulator(vehicleConfig);
    new ShiftingUnit(unitConfig);
    simulator.configure(vehicleConfig);
    unit.configure(unitConfig);
    $('reset-btn').click();
    message('Parametry modelu uloženy pro tuto relaci. Simulace byla resetována.');
  } catch (error) { message(`Model nebyl změněn: ${error.message}`, true); }
});

function populateCalibrationForms() {
  for (const form of [$('model-form'), $('unit-form')]) {
    const values = form.id === 'model-form' ? simulator.config : unit.config;
    for (const input of form.querySelectorAll('input[name]')) {
      const ratio = /^gearRatio([1-6])$/.exec(input.name);
      input.value = ratio ? simulator.config.gearRatios[Number(ratio[1]) - 1] : values[input.name];
    }
  }
  $('unit-mode').value = unit.config.mode;
}
$('export-config-btn').addEventListener('click', () => download('tul-kalibrace.json', JSON.stringify({
  schemaVersion: 1, vehicle: simulator.config, shiftingUnit: unit.config,
  canProfile: profile, protocolDecoder: useTulDecoder ? 'tul-current' : 'profile',
  assumptions: ['Hmotnost a motor nejsou kalibrované.', 'Kódy 1/2/0x40 a maska 0x43 letošního volantu vyžadují ověření.', 'Perioda virtuálních rámců 50 ms a ideální pneumatika jsou model.'],
}, null, 2), 'application/json'));
$('calibration-input').addEventListener('change', async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 128 * 1024) throw new Error('Kalibrace může mít nejvýše 128 kB.');
    const raw = JSON.parse(await file.text());
    if (raw.schemaVersion !== 1 || !raw.vehicle || !raw.shiftingUnit || !raw.canProfile) throw new Error('Neplatný formát kalibrace.');
    const nextVehicle = new VehicleSimulator(raw.vehicle);
    const nextUnit = new ShiftingUnit(raw.shiftingUnit);
    const nextProfile = validateAppProfile(raw.canProfile);
    if (!['tul-current', 'profile'].includes(raw.protocolDecoder)) throw new Error('Neplatný dekodér kalibrace.');
    if (nextUnit.config.mode === 'reference' && nextUnit.config.protocol !== 'current-car') throw new Error('Tato aplikace generuje letošní sběrnici; pro původní firmware zvolte diagnostický režim.');
    if (nextVehicle.config.gearRatios.some((ratio, index) => ratio !== nextUnit.config.ratios[index + 1])) throw new Error('Převody vozu a jednotky se musí shodovat.');
    if ((monitor.port || connecting) && nextProfile.bitrate !== profile.bitrate) throw new Error('Před změnou bitrate odpojte adaptér.');
    simulator.configure(nextVehicle.config);
    unit.configure(nextUnit.config);
    profile = nextProfile;
    useTulDecoder = raw.protocolDecoder === 'tul-current';
    populateCalibrationForms();
    renderProfile();
    $('reset-btn').click();
    message('Kalibrace načtena. Skutečná jednotka ani její firmware nebyly změněny.');
  } catch (error) { message(`Kalibrace nebyla změněna: ${error.message}`, true); }
  event.target.value = '';
});

const canvas = $('telemetry-chart');
const context = canvas.getContext('2d');
function drawChart() {
  if (!context) return;
  const box = canvas.getBoundingClientRect();
  if (!box.width || !box.height) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(box.width * dpr) || canvas.height !== Math.round(box.height * dpr)) {
    canvas.width = Math.round(box.width * dpr);
    canvas.height = Math.round(box.height * dpr);
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  const width = box.width, height = box.height;
  context.clearRect(0, 0, width, height);
  context.lineWidth = 1;
  context.strokeStyle = '#283240';
  for (let i = 0; i <= 4; i++) {
    const y = 8 + (height - 28) * i / 4;
    context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke();
  }
  const now = simulator.state.elapsed;
  for (const [key, max, color] of [['rpm', simulator.config.redlineRpm, '#f77c45'], ['speedKph', 250, '#7dd7cb']]) {
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.beginPath();
    history.forEach((point, index) => {
      const x = width * (1 - (now - point.time) / 30);
      const y = 8 + (height - 28) * (1 - Math.min(1, point[key] / max));
      if (index === 0) context.moveTo(x, y); else context.lineTo(x, y);
    });
    context.stroke();
  }
  context.font = '10px monospace';
  context.fillStyle = '#8793a4';
  context.fillText('−30 s', 0, height - 3);
  context.fillText('nyní', width - 27, height - 3);
}

let previous = performance.now();
function tick(now) {
  const delta = Math.min(0.25, Math.max(0, (now - previous) / 1000));
  previous = now;
  if (!paused) {
    accumulator += delta;
    while (accumulator >= 0.01) {
      simulator.step(0.01, controls());
      unit.advance(10, unitSensors());
      if (unit.state.timeMs + 1e-6 >= nextUnitBusMs) {
        const rpmFrame = makeTulRpm(Math.round(simulator.state.rpm));
        unit.receive(rpmFrame);
        pushFrame(rpmFrame);
        const gearFrame = makeTulGear(unitSensors().gear);
        unit.receive(gearFrame);
        pushFrame(gearFrame);
        const release = makeTulRequest('release');
        unit.receive(release);
        pushFrame(release);
        nextUnitBusMs = unit.state.timeMs + VIRTUAL_BUS_PERIOD_MS;
      }
      accumulator -= 0.01;
      const elapsed = simulator.state.elapsed;
      for (const definition of profile.frames.filter(frame => frame.trigger === 'periodic')) {
        const next = nextPeriodic.get(definition) ?? 0;
        if (elapsed + 1e-7 >= next) {
          emit(definition);
          nextPeriodic.set(definition, Math.max(next + definition.periodMs / 1000, elapsed));
        }
      }
      if (elapsed - lastSample >= 0.1) {
        history.push({ time: elapsed, rpm: simulator.state.rpm, speedKph: simulator.state.speedKph });
        history = history.filter(point => elapsed - point.time <= 30);
        lastSample = elapsed;
      }
    }
  }
  if (now - lastDraw >= 100) {
    renderState();
    drawChart();
    if (logDirty) renderLog();
    lastDraw = now;
  }
  requestAnimationFrame(tick);
}

renderProfile();
populateCalibrationForms();
renderState();
message('TUL jednotka: nastartujte, zařaďte 1, uvolněte spojku a přidejte plyn. Model vozu zatím není kalibrován.');
requestAnimationFrame(tick);

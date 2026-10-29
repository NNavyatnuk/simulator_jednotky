/**
 * Decoder for the supplied TUL firmware's human-readable UART diagnostics.
 * This is NOT SLCAN: the firmware does not accept UART CAN commands and does
 * not print DLC, RTR or a hardware timestamp. Every emitted record is an
 * explicitly marked reconstruction; missing bytes cannot be detected in all
 * cases, and an idle-delimited record can be shorter than the original frame.
 */
export class TulSerialParser {
  constructor() {
    this._buffer = '';
    this._discardLine = false;
    this._record = null;
  }

  push(text) {
    if (typeof text !== 'string') throw new TypeError('Sériový výpis musí být text.');
    const frames = [];
    for (const char of text) {
      if (char === '\n' || char === '\r') {
        if (!this._discardLine) this._line(this._buffer, frames);
        this._buffer = '';
        this._discardLine = false;
      } else if (!this._discardLine) {
        this._buffer += char;
        if (this._buffer.length > 4096) {
          this._buffer = '';
          this._discardLine = true;
          if (this._record) this._record.invalid = true;
        }
      }
    }
    return frames;
  }

  /**
   * Explicit EOF flush can parse a complete final line without a newline.
   * Idle timers must pass includePartial:false: a split numeric field must
   * never be interpreted just because its next USB chunk is delayed.
   */
  flush({ includePartial = true, reason = 'flush' } = {}) {
    const frames = [];
    if (!includePartial && (this._buffer || this._discardLine)) return frames;
    if (includePartial && this._buffer && !this._discardLine) this._line(this._buffer, frames);
    this._buffer = '';
    this._discardLine = false;
    this._finish(frames, reason);
    return frames;
  }

  _fresh(extended = false) {
    return { id: null, extended, data: [], invalid: false };
  }

  _finish(frames, completion) {
    const record = this._record;
    this._record = null;
    // Zero-data prints could represent RTR or an empty data frame; the
    // supplied text cannot distinguish them, so do not invent a data frame.
    if (!record || record.invalid || record.id === null || !record.data.length) return;
    frames.push({
      id: record.id, extended: record.extended, data: record.data,
      direction: 'rx', reconstructed: true, dlcInferred: true, completion,
    });
  }

  _line(rawLine, frames) {
    const line = rawLine.trim();
    if (!line) return;
    if (line === 'Message received') {
      this._finish(frames, 'next-frame');
      this._record = this._fresh();
      return;
    }
    if (line === 'Warning: Message received in extended format!') {
      this._record ??= this._fresh();
      if (this._record.data.length) this._record.invalid = true;
      this._record.extended = true;
      return;
    }
    if (line === 'Message is in Standard Format') {
      this._record ??= this._fresh();
      if (this._record.data.length) this._record.invalid = true;
      this._record.extended = false;
      return;
    }
    if (/^ID is\b/.test(line)) {
      const match = /^ID is\s+(\d+)$/.exec(line);
      // An ID by itself is a useful boundary when a capture begins mid-log.
      const extended = this._record?.id === null ? this._record.extended : false;
      this._finish(frames, 'next-id');
      this._record = this._fresh(extended);
      const id = match ? Number(match[1]) : NaN;
      if (!Number.isInteger(id) || id < 0 || id > (extended ? 0x1fffffff : 0x7ff)) {
        this._record.invalid = true;
      } else this._record.id = id;
      return;
    }
    if (/^Data byte\b/.test(line)) {
      const record = this._record;
      if (!record || record.id === null) return;
      const match = /^Data byte\s+(\d+)\s*=\s*(\d+)$/.exec(line);
      const index = match ? Number(match[1]) : NaN;
      const value = match ? Number(match[2]) : NaN;
      if (!Number.isInteger(index) || index !== record.data.length || index > 7 || !Number.isInteger(value) || value < 0 || value > 255) {
        record.invalid = true;
        return;
      }
      record.data.push(value);
      if (record.data.length === 8) this._finish(frames, 'eight-bytes');
    }
    // Other firmware tasks interleave messages such as "Analysing message",
    // "Current Gear: data = 2", warnings and boot diagnostics. Ignore them.
  }
}

const ended = () => new Error('Sériové spojení s jednotkou bylo ukončeno.');

/** Read-only USB/UART monitoring. No writable stream or command is used. */
export class TulSerialMonitor {
  constructor(serial = globalThis.navigator?.serial, idleMs = 150) {
    if (!Number.isFinite(idleMs) || idleMs < 1) throw new RangeError('Interval UART musí být kladné číslo.');
    this.serial = serial;
    this.idleMs = idleMs;
    this._session = null;
    this._connecting = false;
    this._disconnectTask = null;
  }

  get port() { return this._session?.port ?? null; }
  get connected() { return Boolean(this._session?.connected); }
  get connecting() { return this._connecting; }

  async connect({ onFrame, onStatus = () => {} }) {
    if (this._session || this._connecting || this._disconnectTask) throw new Error('Jednotka se připojuje, je připojená nebo se právě odpojuje.');
    if (!this.serial) throw new Error('Web Serial není dostupný. Použijte Chrome/Edge a HTTPS nebo localhost.');
    if (typeof onFrame !== 'function') throw new TypeError('Chybí obsluha přijatých rámců.');
    const session = {
      port: null, reader: null, readTask: null, openTask: null, cleanup: null,
      readEnded: false, closing: false, connected: false, everConnected: false,
      parser: new TulSerialParser(), idleTimer: null, onFrame, onStatus,
    };
    this._session = session;
    this._connecting = true;
    try {
      const port = await this.serial.requestPort();
      if (session.closing || this._session !== session) throw ended();
      session.port = port;
      session.openTask = port.open({ baudRate: 115200 });
      await session.openTask;
      if (session.closing || this._session !== session) throw ended();
      if (!port.readable) throw new Error('Sériový port nemá čitelný vstup.');
      session.reader = port.readable.getReader();
      session.readTask = this._readLoop(session);
      // Let an immediately closed stream report EOF before claiming readiness.
      await Promise.resolve();
      if (session.readEnded || session.closing || this._session !== session) throw ended();
      session.connected = session.everConnected = true;
      onStatus('Připojeno · USB/UART debug · pouze čtení');
    } catch (error) {
      await this._disconnect(session);
      throw error;
    } finally {
      this._connecting = false;
    }
  }

  _emit(session, frames) {
    for (const frame of frames) session.onFrame({ ...frame, timestamp: Date.now() / 1000 });
  }

  _armIdle(session) {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => {
      if (!session.closing && !session.readEnded) {
        this._emit(session, session.parser.flush({ includePartial: false, reason: 'idle' }));
      }
    }, this.idleMs);
  }

  async _readLoop(session) {
    const decoder = new TextDecoder();
    try {
      while (!session.closing) {
        const { done, value } = await session.reader.read();
        if (done) break;
        this._emit(session, session.parser.push(decoder.decode(value, { stream: true })));
        this._armIdle(session);
      }
      if (!session.closing) {
        this._emit(session, session.parser.push(decoder.decode()));
        this._emit(session, session.parser.flush({ reason: 'eof' }));
      }
    } catch (error) {
      if (!session.closing) session.onStatus(`UART spojení přerušeno: ${error.message}`);
    } finally {
      clearTimeout(session.idleTimer);
      session.readEnded = true;
      session.connected = false;
      if (!session.closing && session.everConnected) queueMicrotask(() => this._disconnect(session));
    }
  }

  disconnect() {
    return this._session ? this._disconnect(this._session) : this._disconnectTask ?? Promise.resolve();
  }

  _disconnect(session) {
    if (session.cleanup) return session.cleanup;
    session.closing = true;
    session.connected = false;
    clearTimeout(session.idleTimer);
    const task = Promise.resolve().then(async () => {
      try {
        if (session.openTask) { try { await session.openTask; } catch {} }
        if (!session.readEnded) {
          this._emit(session, session.parser.flush({ includePartial: false, reason: 'disconnect' }));
        }
        if (session.reader) { try { await session.reader.cancel(); } catch {} }
        if (session.readTask) { try { await session.readTask; } catch {} }
        try { session.reader?.releaseLock(); } catch {}
        if (session.port) { try { await session.port.close(); } catch {} }
        session.reader = session.readTask = null;
      } finally {
        if (this._session === session) this._session = null;
        if (this._disconnectTask === task) this._disconnectTask = null;
        if (session.everConnected) session.onStatus('Jednotka odpojena. Připojte ji znovu.');
      }
    });
    session.cleanup = task;
    this._disconnectTask = task;
    return task;
  }
}

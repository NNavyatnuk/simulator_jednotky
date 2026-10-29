import { parseSlcanLine } from './can.js';

const BITRATES = [10000, 20000, 50000, 100000, 125000, 250000, 500000, 800000, 1000000];
const ended = () => new Error('SLCAN spojení bylo ukončeno.');

/** Receive-only SLCAN session. L opens listen-only mode; O/transmit are never used. */
export class SlcanMonitor {
  constructor(serial = globalThis.navigator?.serial, commandTimeoutMs = 1800) {
    this.serial = serial;
    this.commandTimeoutMs = commandTimeoutMs;
    this._session = null;
    this._connecting = false;
    this._disconnectTask = null;
  }

  // Keep the old port occupied until its locks and close operation settle.
  get port() { return this._session?.port ?? null; }
  get connected() { return Boolean(this._session?.connected); }
  get connecting() { return this._connecting; }

  async connect({ bitrate, onFrame, onStatus = () => {} }) {
    if (this._session || this._connecting || this._disconnectTask) throw new Error('Adaptér se připojuje, je připojený nebo se právě odpojuje.');
    const index = BITRATES.indexOf(bitrate);
    if (index < 0) throw new Error('SLCAN nepodporuje tento CAN bitrate.');
    if (!this.serial) throw new Error('Web Serial není dostupný. Použijte Chrome/Edge a HTTPS nebo localhost.');
    const session = {
      port: null, reader: null, writer: null, pending: null, readTask: null,
      openTask: null, cleanup: null, readEnded: false, closing: false,
      connected: false, everConnected: false, onStatus,
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
      session.reader = port.readable.getReader();
      session.writer = port.writable.getWriter();
      session.readTask = this.readLoop(session, onFrame);
      // Some adapters reject C when already closed. Only this rejection is harmless.
      try { await this.command('C', session); } catch (e) { if (e.code !== 'SLCAN_REJECTED') throw e; }
      await this.command(`S${index}`, session);
      await this.command('L', session);
      // The L acknowledgement can be the last bytes of a disconnected stream.
      if (session.readEnded || session.closing || this._session !== session) throw ended();
      session.connected = session.everConnected = true;
      onStatus('Připojeno · pouze příjem');
    } catch (error) {
      await this._disconnect(session);
      throw error;
    } finally {
      this._connecting = false;
    }
  }

  async command(command, session = this._session) {
    if (!session || session.closing || session.readEnded || !session.writer) throw ended();
    if (session.pending) throw new Error('SLCAN příkaz ještě čeká na odpověď.');
    const response = new Promise((resolve, reject) => {
      const clear = () => {
        clearTimeout(timer);
        if (session.pending === pending) session.pending = null;
      };
      const pending = {
        resolve: () => { clear(); resolve(); },
        reject: error => { clear(); reject(error); },
      };
      const timer = setTimeout(() => pending.reject(new Error(`SLCAN adaptér nepotvrdil příkaz ${command}.`)), this.commandTimeoutMs);
      session.pending = pending;
    });
    // Attach a handler before writing: physical disconnection can reject immediately.
    response.catch(() => {});
    try {
      session.writer.write(new TextEncoder().encode(command + '\r')).catch(error => session.pending?.reject(error));
    } catch (error) { session.pending?.reject(error); }
    return response;
  }

  async readLoop(session, onFrame) {
    let buffer = '';
    const decoder = new TextDecoder();
    // A read loop owns one session and must never access a newer connection.
    const reader = session.reader;
    try {
      while (!session.closing) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const char of decoder.decode(value, { stream: true })) {
          if (char === '\x07') {
            const error = new Error('SLCAN adaptér odmítl příkaz. Je vyžadován firmware s režimem listen-only (L).');
            error.code = 'SLCAN_REJECTED';
            session.pending?.reject(error);
            buffer = '';
          } else if (char === '\r') {
            if (!buffer) session.pending?.resolve();
            else {
              try {
                const frame = parseSlcanLine(buffer);
                if (frame) onFrame(frame);
              } catch { /* Ignore malformed or unsupported adapter status lines. */ }
            }
            buffer = '';
          } else if (char !== '\n') {
            buffer += char;
            if (buffer.length > 4096) buffer = '';
          }
        }
      }
    } catch (error) {
      if (!session.closing) session.onStatus(`Spojení přerušeno: ${error.message}`);
    } finally {
      session.readEnded = true;
      session.pending?.reject(ended());
      session.connected = false;
      if (!session.closing && session.everConnected) {
        // Let this read task settle before teardown awaits it and releases locks.
        queueMicrotask(() => { this._disconnect(session); });
      }
    }
  }

  disconnect() {
    return this._session ? this._disconnect(this._session) : this._disconnectTask ?? Promise.resolve();
  }

  _disconnect(session) {
    if (session.cleanup) return session.cleanup;
    session.closing = true;
    session.connected = false;
    session.pending?.reject(new Error('SLCAN monitor byl odpojen.'));
    // Install the promise before executing asynchronous cleanup. Concurrent
    // manual and automatic disconnects must close each stream exactly once.
    const task = Promise.resolve().then(async () => {
      try {
        // An open() already in flight must settle before close(), otherwise an
        // aborted connection could open a port after its teardown has finished.
        if (session.openTask) { try { await session.openTask; } catch {} }
        const { port, reader, writer, readTask } = session;
        // Close CAN channel without opening it in transmit-capable mode.
        if (writer) { try { await writer.write(new TextEncoder().encode('C\r')); } catch {} }
        if (reader) { try { await reader.cancel(); } catch {} }
        if (readTask) { try { await readTask; } catch {} }
        try { reader?.releaseLock(); } catch {}
        try { writer?.releaseLock(); } catch {}
        if (port) { try { await port.close(); } catch {} }
        session.reader = session.writer = session.readTask = null;
      } finally {
        if (this._session === session) this._session = null;
        if (this._disconnectTask === task) this._disconnectTask = null;
        // Notify after clearing the old port, so the UI can offer reconnect.
        if (session.everConnected) session.onStatus('Adaptér odpojen. Připojte jej znovu.');
      }
    });
    session.cleanup = task;
    this._disconnectTask = task;
    return task;
  }
}

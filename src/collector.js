'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { EventStore, DATA_DIR } = require('./store');
const lmstudio = require('./parsers/lmstudio');

const STATE_FILE = path.join(DATA_DIR, 'tail-state.json');
const POLL_INTERVAL_MS = 1500;

function loadOffsets() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function saveOffsets(offsets) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(offsets, null, 2));
}

/**
 * LM Studio log dosyalarini izler, yeni satirlari parse eder, tamamlanan
 * istekleri store'a yazar ve canli (anlik) tokenlari dinleyicilere iletir.
 */
class Collector {
  constructor(store, { lmstudioHome = lmstudio.defaultLmStudioHome() } = {}) {
    this.store = store;
    this.lmstudioHome = lmstudioHome;
    this.offsets = loadOffsets();
    this.parsers = new Map(); // filePath -> LmStudioFileParser
    this.liveListeners = new Set();
    this._timer = null;
  }

  onLiveTick(listener) {
    this.liveListeners.add(listener);
    return () => this.liveListeners.delete(listener);
  }

  _emitLive(tick) {
    for (const listener of this.liveListeners) {
      try {
        listener(tick);
      } catch {
        // dinleyici hatasi collector'i durdurmasin
      }
    }
  }

  _getParser(filePath) {
    let parser = this.parsers.get(filePath);
    if (!parser) {
      parser = new lmstudio.LmStudioFileParser(
        filePath,
        (event) => this.store.add(event),
        (tick) => this._emitLive(tick)
      );
      this.parsers.set(filePath, parser);
    }
    return parser;
  }

  /** Tek bir tur: tum log dosyalarini tara, buyuyenleri oku. */
  async tick() {
    let files;
    try {
      files = lmstudio.listLogFiles(this.lmstudioHome);
    } catch {
      return;
    }

    let changed = false;
    for (const filePath of files) {
      let stat;
      try {
        stat = fs.statSync(filePath);
      } catch {
        continue;
      }
      const prevOffset = this.offsets[filePath] || 0;
      if (stat.size <= prevOffset) continue;

      const parser = this._getParser(filePath);
      const newOffset = await this._readFrom(filePath, prevOffset, parser);
      this.offsets[filePath] = newOffset;
      changed = true;
    }
    if (changed) saveOffsets(this.offsets);
  }

  _readFrom(filePath, offset, parser) {
    return new Promise((resolve, reject) => {
      let bytesRead = offset;
      const stream = fs.createReadStream(filePath, { start: offset, encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      stream.on('data', (chunk) => {
        bytesRead += Buffer.byteLength(chunk, 'utf8');
      });

      rl.on('line', (line) => {
        try {
          parser.processLine(line);
        } catch {
          // tek bir bozuk satir tum okumayi durdurmasin
        }
      });

      rl.on('close', () => resolve(bytesRead));
      stream.on('error', reject);
    });
  }

  start() {
    if (this._timer) return;
    const loop = async () => {
      await this.tick();
      this._timer = setTimeout(loop, POLL_INTERVAL_MS);
    };
    void loop();
  }

  stop() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    saveOffsets(this.offsets);
  }
}

module.exports = { Collector };

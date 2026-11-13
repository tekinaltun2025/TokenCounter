'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

function eventsFilePath(date) {
  return path.join(DATA_DIR, `events-${monthKey(date)}.jsonl`);
}

/**
 * Basit, bagimliliksiz olay deposu: aylik JSONL dosyalarina ekler,
 * tum olaylari baslangicta hafizaya yukler (kisisel kullanim icin yeterli hacim).
 */
class EventStore {
  constructor() {
    this.events = [];
    this._load();
  }

  _load() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      return;
    }
    const files = fs
      .readdirSync(DATA_DIR)
      .filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort();
    for (const file of files) {
      const full = path.join(DATA_DIR, file);
      const content = fs.readFileSync(full, 'utf8');
      for (const line of content.split('\n')) {
        if (!line.trim()) continue;
        try {
          this.events.push(JSON.parse(line));
        } catch {
          // bozuk satiri atla
        }
      }
    }
    this.events.sort((a, b) => a.ts - b.ts);
  }

  add(event) {
    this.events.push(event);
    const file = eventsFilePath(new Date(event.ts));
    fs.appendFileSync(file, JSON.stringify(event) + '\n');
  }

  all() {
    return this.events;
  }

  query({ from, to, environments, model } = {}) {
    return this.events.filter((e) => {
      if (from != null && e.ts < from) return false;
      if (to != null && e.ts > to) return false;
      if (environments != null && !environments.includes(e.environment)) return false;
      if (model && e.model !== model) return false;
      return true;
    });
  }
}

module.exports = { EventStore, DATA_DIR };

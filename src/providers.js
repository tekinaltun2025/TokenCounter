'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./store');

const PROVIDERS_FILE = path.join(DATA_DIR, 'providers.json');

function slugify(label) {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'provider'
  );
}

/**
 * Dis saglayici / kurumsal proxy tanimlarini (URL + API key) diskte saklar.
 * API key'ler duz metin olarak data/providers.json icinde tutulur (chmod 600);
 * API uzerinden asla geri donulmez (hasApiKey bool'u disinda).
 */
class ProviderStore {
  constructor() {
    this.providers = this._load();
  }

  _load() {
    try {
      const raw = fs.readFileSync(PROVIDERS_FILE, 'utf8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  _save() {
    fs.writeFileSync(PROVIDERS_FILE, JSON.stringify(this.providers, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(PROVIDERS_FILE, 0o600);
    } catch {
      // bazi dosya sistemlerinde chmod desteklenmeyebilir, sessizce gec
    }
  }

  list() {
    return this.providers.map((p) => this._redact(p));
  }

  getFull(id) {
    return this.providers.find((p) => p.id === id) || null;
  }

  _redact(p) {
    const { apiKey, ...rest } = p;
    return { ...rest, hasApiKey: !!apiKey };
  }

  create({ label, protocol, upstreamBaseUrl, apiKey, authHeader, authScheme, enabled }) {
    if (!label || !upstreamBaseUrl) {
      throw new Error('label ve upstreamBaseUrl zorunlu');
    }
    if (protocol !== 'openai' && protocol !== 'anthropic') {
      throw new Error('protocol "openai" veya "anthropic" olmali');
    }
    let id = slugify(label);
    const existingIds = new Set(this.providers.map((p) => p.id));
    if (existingIds.has(id)) {
      let i = 2;
      while (existingIds.has(`${id}-${i}`)) i++;
      id = `${id}-${i}`;
    }
    const defaults =
      protocol === 'anthropic'
        ? { authHeader: 'x-api-key', authScheme: '' }
        : { authHeader: 'Authorization', authScheme: 'Bearer' };
    const provider = {
      id,
      label,
      protocol,
      upstreamBaseUrl: upstreamBaseUrl.replace(/\/+$/, ''),
      apiKey: apiKey || '',
      authHeader: authHeader || defaults.authHeader,
      authScheme: authScheme != null ? authScheme : defaults.authScheme,
      enabled: enabled !== false,
      createdAt: Date.now(),
    };
    this.providers.push(provider);
    this._save();
    return this._redact(provider);
  }

  update(id, patch) {
    const provider = this.getFull(id);
    if (!provider) throw new Error('saglayici bulunamadi');
    if (patch.label != null) provider.label = patch.label;
    if (patch.upstreamBaseUrl != null) provider.upstreamBaseUrl = patch.upstreamBaseUrl.replace(/\/+$/, '');
    if (patch.apiKey) provider.apiKey = patch.apiKey; // bos/undefined gelirse mevcut key korunur
    if (patch.authHeader != null) provider.authHeader = patch.authHeader;
    if (patch.authScheme != null) provider.authScheme = patch.authScheme;
    if (patch.enabled != null) provider.enabled = !!patch.enabled;
    this._save();
    return this._redact(provider);
  }

  remove(id) {
    const before = this.providers.length;
    this.providers = this.providers.filter((p) => p.id !== id);
    this._save();
    return this.providers.length < before;
  }
}

module.exports = { ProviderStore, slugify };

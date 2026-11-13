'use strict';

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const MAX_BODY_BYTES = 100 * 1024 * 1024; // 100MB guard
const LIVE_TICK_MIN_INTERVAL_MS = 300;
const LIVE_WINDOW_MS = 3000;

const HOP_BY_HOP = new Set(['host', 'connection', 'content-length', 'keep-alive', 'transfer-encoding', 'upgrade']);

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('istek govdesi cok buyuk'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Son N ms icindeki olay sayisindan kabaca "aninda hiz" hesaplayan kucuk pencere. */
class RollingRate {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.events = [];
  }
  tick() {
    const now = Date.now();
    this.events.push(now);
    const cutoff = now - this.windowMs;
    while (this.events.length && this.events[0] < cutoff) this.events.shift();
    return this.events.length / (this.windowMs / 1000);
  }
}

/**
 * Herhangi bir OpenAI-uyumlu veya Anthropic-uyumlu uc noktayi (gercek
 * saglayici ya da kullanicinin kendi kurumsal proxy'si) oneden gecirir,
 * token kullanimini sayar ve ayni EventStore/liveBus'a yazar.
 */
class ProxyGateway {
  constructor(store, providerStore, liveBus) {
    this.store = store;
    this.providerStore = providerStore;
    this.liveBus = liveBus;
  }

  async handle(req, res, providerId, remainderPath, search) {
    const provider = this.providerStore.getFull(providerId);
    if (!provider || !provider.enabled) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'saglayici bulunamadi veya devre disi' }));
      return;
    }

    let bodyBuffer;
    try {
      bodyBuffer = await readRequestBody(req);
    } catch (err) {
      res.writeHead(err.statusCode || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }

    const contentType = req.headers['content-type'] || '';
    let parsedBody = null;
    if (contentType.includes('application/json') && bodyBuffer.length) {
      try {
        parsedBody = JSON.parse(bodyBuffer.toString('utf8'));
      } catch {
        parsedBody = null;
      }
    }

    const model = (parsedBody && parsedBody.model) || 'bilinmeyen-model';
    const isStream = !!(parsedBody && parsedBody.stream);

    if (provider.protocol === 'openai' && isStream && parsedBody) {
      parsedBody.stream_options = { ...(parsedBody.stream_options || {}), include_usage: true };
      bodyBuffer = Buffer.from(JSON.stringify(parsedBody), 'utf8');
    }

    let upstreamUrl;
    try {
      upstreamUrl = new URL(provider.upstreamBaseUrl + remainderPath + (search ? `?${search}` : ''));
    } catch {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'gecersiz upstreamBaseUrl' }));
      return;
    }

    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
    }
    headers['content-length'] = Buffer.byteLength(bodyBuffer);
    headers['host'] = upstreamUrl.host;
    if (provider.apiKey) {
      const scheme = provider.authScheme ? `${provider.authScheme} ` : '';
      headers[provider.authHeader] = `${scheme}${provider.apiKey}`;
    }
    if (provider.protocol === 'anthropic' && !headers['anthropic-version']) {
      headers['anthropic-version'] = '2023-06-01';
    }

    const transport = upstreamUrl.protocol === 'http:' ? http : https;
    const startTime = Date.now();
    const taskId = crypto.randomUUID();

    const countable = !!(parsedBody && parsedBody.model);

    const upstreamReq = transport.request(
      upstreamUrl,
      { method: req.method, headers },
      (upstreamRes) => this._pipeResponse({ upstreamRes, req, res, provider, model, isStream, startTime, taskId, countable })
    );

    upstreamReq.on('error', (err) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `upstream hatasi: ${err.message}` }));
      } else {
        res.end();
      }
    });

    upstreamReq.end(bodyBuffer);
  }

  _pipeResponse({ upstreamRes, req, res, provider, model, isStream, startTime, taskId, countable }) {
    const resHeaders = { ...upstreamRes.headers };
    delete resHeaders['content-length'];
    res.writeHead(upstreamRes.statusCode || 502, resHeaders);

    const rate = new RollingRate(LIVE_WINDOW_MS);
    let approxTokens = 0;
    let lastLiveEmit = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let usageCaptured = false;
    let firstByteAt = null;
    let sseBuffer = '';
    let currentEventName = null;
    let finished = false;

    const finalize = ({ truncated }) => {
      if (finished) return;
      finished = true;
      if (!countable) return;
      const now = Date.now();
      if (!usageCaptured) completionTokens = approxTokens;
      // Stream olmayan yanitlarda tum govde tek seferde gelir; "ilk byte"
      // prompt/uretim ayrimi icin anlamsizdir (neredeyse tum sure prompt'a
      // yazilir, uretim suresi sifira yakin cikar). Bu durumda tek bir toplam
      // sure kullan, sadece stream'de prompt/uretim ayri olculur.
      const promptMs = isStream && firstByteAt ? firstByteAt - startTime : null;
      const genMs = isStream && firstByteAt ? now - firstByteAt : now - startTime;
      const event = {
        id: `${provider.id}-${taskId}`,
        ts: now,
        environment: provider.id,
        model,
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        promptMs,
        genMs,
        promptTps: promptMs ? Math.round((promptTokens / (promptMs / 1000)) * 10) / 10 : null,
        genTps: genMs ? Math.round((completionTokens / (genMs / 1000)) * 10) / 10 : null,
        truncated: !!truncated,
        estimated: !usageCaptured,
      };
      this.store.add(event);
    };

    const maybeEmitLive = (phase) => {
      if (!countable) return;
      const now = Date.now();
      if (now - lastLiveEmit < LIVE_TICK_MIN_INTERVAL_MS) return;
      lastLiveEmit = now;
      this.liveBus.emit({
        phase,
        taskId,
        model,
        environment: provider.id,
        tokens: approxTokens,
        tokensPerSecond: Math.round(rate.tick() * 10) / 10,
        approx: true,
        ts: now,
      });
    };

    const handleOpenAiJson = (obj) => {
      if (obj.usage) {
        promptTokens = obj.usage.prompt_tokens ?? promptTokens;
        completionTokens = obj.usage.completion_tokens ?? completionTokens;
        usageCaptured = true;
      }
      const hasDelta = obj.choices?.some((c) => c.delta && (c.delta.content || c.delta.tool_calls));
      if (hasDelta) {
        approxTokens += 1;
        maybeEmitLive('generate');
      }
    };

    const handleAnthropicEvent = (eventName, obj) => {
      if (eventName === 'message_start' && obj.message?.usage) {
        promptTokens = obj.message.usage.input_tokens ?? promptTokens;
      } else if (eventName === 'content_block_delta') {
        approxTokens += 1;
        maybeEmitLive('generate');
      } else if (eventName === 'message_delta' && obj.usage) {
        completionTokens = obj.usage.output_tokens ?? completionTokens;
        usageCaptured = true;
      }
    };

    const processSseLines = (text) => {
      sseBuffer += text;
      const lines = sseBuffer.split('\n');
      sseBuffer = lines.pop(); // tamamlanmamis son satiri sakla
      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEventName = line.slice(6).trim();
          continue;
        }
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let obj;
        try {
          obj = JSON.parse(data);
        } catch {
          continue;
        }
        if (provider.protocol === 'openai') handleOpenAiJson(obj);
        else handleAnthropicEvent(currentEventName, obj);
      }
    };

    const nonStreamChunks = [];

    upstreamRes.on('data', (chunk) => {
      if (firstByteAt == null) firstByteAt = Date.now();
      res.write(chunk);
      if (isStream) {
        processSseLines(chunk.toString('utf8'));
      } else {
        nonStreamChunks.push(chunk);
      }
    });

    upstreamRes.on('end', () => {
      if (!isStream) {
        try {
          const fullBody = Buffer.concat(nonStreamChunks).toString('utf8');
          const obj = JSON.parse(fullBody);
          if (provider.protocol === 'openai' && obj.usage) {
            promptTokens = obj.usage.prompt_tokens ?? 0;
            completionTokens = obj.usage.completion_tokens ?? 0;
            usageCaptured = true;
          } else if (provider.protocol === 'anthropic' && obj.usage) {
            promptTokens = obj.usage.input_tokens ?? 0;
            completionTokens = obj.usage.output_tokens ?? 0;
            usageCaptured = true;
          }
        } catch {
          // JSON olmayan / parse edilemeyen yanit - token sayilamaz
        }
      }
      res.end();
      finalize({ truncated: false });
    });

    upstreamRes.on('error', () => {
      finalize({ truncated: true });
      res.end();
    });

    req.on('close', () => {
      if (!finished) finalize({ truncated: true });
    });
  }
}

module.exports = { ProxyGateway };

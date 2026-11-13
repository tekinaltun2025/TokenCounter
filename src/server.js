'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { EventStore } = require('./store');
const { Collector } = require('./collector');
const { summarize, bucketTimeseries, pickBucketMs } = require('./aggregate');
const { ProviderStore } = require('./providers');
const { ProxyGateway } = require('./proxyGateway');
const { LiveBus } = require('./liveBus');

const PORT = Number(process.env.PORT || 7879);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

const store = new EventStore();
const collector = new Collector(store);
collector.start();

const providerStore = new ProviderStore();
const liveBus = new LiveBus();
const proxyGateway = new ProxyGateway(store, providerStore, liveBus);
collector.onLiveTick((tick) => liveBus.emit(tick));

const sseClients = new Set();
liveBus.subscribe((tick) => {
  const payload = `data: ${JSON.stringify(tick)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
});

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parseFilters(searchParams) {
  const from = searchParams.get('from') ? Number(searchParams.get('from')) : null;
  const to = searchParams.get('to') ? Number(searchParams.get('to')) : null;
  // 'environment' parametresi verilmemisse filtre yok (tumu); verilmisse
  // virgulle ayrilmis liste olarak ayristirilir (bos deger = hicbiri eslesmez).
  const envParam = searchParams.get('environment');
  const environments = envParam !== null ? envParam.split(',').filter(Boolean) : null;
  const model = searchParams.get('model') || null;
  return { from, to, environments, model };
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? '/index.html' : pathname;
  const full = path.normalize(path.join(PUBLIC_DIR, filePath));
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.extname(full);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

function toCsv(events) {
  const header = ['tarih', 'ortam', 'model', 'prompt_tokens', 'completion_tokens', 'toplam_tokens', 'gen_tps', 'kesildi'];
  const rows = events.map((e) => [
    new Date(e.ts).toISOString(),
    e.environment,
    e.model,
    e.promptTokens,
    e.completionTokens,
    e.totalTokens,
    e.genTps ?? '',
    e.truncated ? 'evet' : 'hayir',
  ]);
  return [header, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
}

const server = http.createServer(async (req, res) => {
  try {
    await handleRequest(req, res);
  } catch (err) {
    if (!res.headersSent) {
      sendJson(res, 500, { error: err.message });
    } else {
      res.end();
    }
  }
});

async function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname, searchParams } = url;

  if (pathname.startsWith('/proxy/')) {
    const rest = pathname.slice('/proxy/'.length);
    const slashIdx = rest.indexOf('/');
    const providerId = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    const remainderPath = slashIdx === -1 ? '' : rest.slice(slashIdx);
    await proxyGateway.handle(req, res, providerId, remainderPath || '/', url.search.replace(/^\?/, ''));
    return;
  }

  if (pathname === '/api/providers' && req.method === 'GET') {
    sendJson(res, 200, { providers: providerStore.list() });
    return;
  }

  if (pathname === '/api/providers' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const provider = providerStore.create(body);
      sendJson(res, 201, { provider });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (pathname.startsWith('/api/providers/') && (req.method === 'PUT' || req.method === 'PATCH')) {
    const id = pathname.slice('/api/providers/'.length);
    try {
      const body = await readJsonBody(req);
      const provider = providerStore.update(id, body);
      sendJson(res, 200, { provider });
    } catch (err) {
      sendJson(res, 400, { error: err.message });
    }
    return;
  }

  if (pathname.startsWith('/api/providers/') && req.method === 'DELETE') {
    const id = pathname.slice('/api/providers/'.length);
    const ok = providerStore.remove(id);
    sendJson(res, ok ? 200 : 404, { ok });
    return;
  }

  if (pathname === '/api/live') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write('retry: 2000\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  if (pathname === '/api/health') {
    const events = store.all();
    const last = events.length ? events[events.length - 1] : null;
    sendJson(res, 200, {
      ok: true,
      eventCount: events.length,
      lastEventTs: last ? last.ts : null,
      secondsSinceLastEvent: last ? Math.round((Date.now() - last.ts) / 1000) : null,
    });
    return;
  }

  if (pathname === '/api/environments') {
    const known = new Map();
    known.set('lmstudio', { id: 'lmstudio', label: 'LM Studio', kind: 'local', enabled: true });
    for (const p of providerStore.list()) {
      known.set(p.id, { id: p.id, label: p.label, kind: 'proxy', enabled: p.enabled });
    }
    for (const e of store.all()) {
      if (!known.has(e.environment)) {
        known.set(e.environment, { id: e.environment, label: e.environment, kind: 'eski-kayit', enabled: false });
      }
    }
    sendJson(res, 200, { environments: Array.from(known.values()) });
    return;
  }

  if (pathname === '/api/models') {
    const events = store.all();
    const models = new Set();
    const environments = new Set();
    for (const e of events) {
      models.add(e.model);
      environments.add(e.environment);
    }
    sendJson(res, 200, { models: Array.from(models).sort(), environments: Array.from(environments).sort() });
    return;
  }

  if (pathname === '/api/summary') {
    const filters = parseFilters(searchParams);
    const events = store.query(filters);
    const summary = summarize(events);
    const from = filters.from ?? (events.length ? events[0].ts : Date.now() - 86400_000);
    const to = filters.to ?? Date.now();
    const timeseries = bucketTimeseries(events, pickBucketMs(from, to));
    sendJson(res, 200, { ...summary, timeseries });
    return;
  }

  if (pathname === '/api/events') {
    const filters = parseFilters(searchParams);
    const limit = Math.min(Number(searchParams.get('limit') || 200), 5000);
    const events = store.query(filters).slice().sort((a, b) => b.ts - a.ts).slice(0, limit);
    sendJson(res, 200, { events });
    return;
  }

  if (pathname === '/api/events.csv') {
    const filters = parseFilters(searchParams);
    const events = store.query(filters).slice().sort((a, b) => b.ts - a.ts);
    const csv = toCsv(events);
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="token-kullanimi.csv"',
    });
    res.end(csv);
    return;
  }

  if (pathname.startsWith('/api/')) {
    sendJson(res, 404, { error: 'bilinmeyen uc nokta' });
    return;
  }

  serveStatic(req, res, pathname);
}

server.listen(PORT, HOST, () => {
  console.log(`Local LLM Token Sayaci http://${HOST}:${PORT} adresinde calisiyor`);
});

function shutdown() {
  collector.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

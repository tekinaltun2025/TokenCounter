'use strict';

function summarize(events) {
  const totals = {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  };
  const byModelMap = new Map();
  const byEnvMap = new Map();

  for (const e of events) {
    totals.requestCount += 1;
    totals.promptTokens += e.promptTokens || 0;
    totals.completionTokens += e.completionTokens || 0;
    totals.totalTokens += e.totalTokens || 0;

    const modelKey = `${e.environment}::${e.model}`;
    if (!byModelMap.has(modelKey)) {
      byModelMap.set(modelKey, {
        model: e.model,
        environment: e.environment,
        requestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        genTpsSum: 0,
        genTpsCount: 0,
      });
    }
    const m = byModelMap.get(modelKey);
    m.requestCount += 1;
    m.promptTokens += e.promptTokens || 0;
    m.completionTokens += e.completionTokens || 0;
    m.totalTokens += e.totalTokens || 0;
    if (typeof e.genTps === 'number' && !Number.isNaN(e.genTps)) {
      m.genTpsSum += e.genTps;
      m.genTpsCount += 1;
    }

    if (!byEnvMap.has(e.environment)) {
      byEnvMap.set(e.environment, {
        environment: e.environment,
        requestCount: 0,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
      });
    }
    const env = byEnvMap.get(e.environment);
    env.requestCount += 1;
    env.promptTokens += e.promptTokens || 0;
    env.completionTokens += e.completionTokens || 0;
    env.totalTokens += e.totalTokens || 0;
  }

  const byModel = Array.from(byModelMap.values())
    .map((m) => ({
      ...m,
      avgGenTps: m.genTpsCount ? Math.round((m.genTpsSum / m.genTpsCount) * 10) / 10 : null,
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens);
  byModel.forEach((m) => {
    delete m.genTpsSum;
    delete m.genTpsCount;
  });

  const byEnvironment = Array.from(byEnvMap.values()).sort((a, b) => b.totalTokens - a.totalTokens);

  return { totals, byModel, byEnvironment };
}

/** Olaylari zaman kovalarina (bucket) ayirip toplam token sayisini dondurur. */
function bucketTimeseries(events, bucketMs) {
  const buckets = new Map();
  for (const e of events) {
    const bucketStart = Math.floor(e.ts / bucketMs) * bucketMs;
    if (!buckets.has(bucketStart)) {
      buckets.set(bucketStart, { ts: bucketStart, promptTokens: 0, completionTokens: 0, totalTokens: 0, requestCount: 0 });
    }
    const b = buckets.get(bucketStart);
    b.promptTokens += e.promptTokens || 0;
    b.completionTokens += e.completionTokens || 0;
    b.totalTokens += e.totalTokens || 0;
    b.requestCount += 1;
  }
  return Array.from(buckets.values()).sort((a, b) => a.ts - b.ts);
}

function pickBucketMs(from, to) {
  const span = to - from;
  const HOUR = 3600_000;
  const DAY = 24 * HOUR;
  if (span <= 2 * HOUR) return 60_000; // 1 dakika
  if (span <= 2 * DAY) return HOUR; // 1 saat
  if (span <= 60 * DAY) return DAY; // 1 gun
  return 7 * DAY; // 1 hafta
}

module.exports = { summarize, bucketTimeseries, pickBucketMs };

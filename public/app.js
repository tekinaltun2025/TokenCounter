(() => {
  'use strict';

  const state = {
    range: '7d',
    from: null,
    to: null,
    allEnvironmentIds: [],
    environments: new Set(),
    model: '',
  };

  const fmtInt = (n) => (n == null ? '–' : Math.round(n).toLocaleString('tr-TR'));
  const fmtTps = (n) => (n == null ? '–' : `${n.toFixed(1)} t/s`);
  const fmtTime = (ts) => new Date(ts).toLocaleString('tr-TR');

  function rangeToFromTo(range) {
    const now = Date.now();
    const DAY = 86400_000;
    switch (range) {
      case 'today': {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        return { from: d.getTime(), to: now };
      }
      case '24h': return { from: now - DAY, to: now };
      case '7d': return { from: now - 7 * DAY, to: now };
      case '30d': return { from: now - 30 * DAY, to: now };
      case 'all': return { from: null, to: null };
      default: return { from: null, to: null };
    }
  }

  function currentQuery() {
    const params = new URLSearchParams();
    if (state.from != null) params.set('from', state.from);
    if (state.to != null) params.set('to', state.to);
    // Tum saglayicilar seciliyse parametreyi hic gondermiyoruz (= filtre yok).
    // Hicbiri secili degilse bos deger gonderiyoruz (= hicbir seyle eslesmez).
    if (state.environments.size === 0) {
      params.set('environment', '');
    } else if (state.environments.size < state.allEnvironmentIds.length) {
      params.set('environment', Array.from(state.environments).join(','));
    }
    if (state.model) params.set('model', state.model);
    return params;
  }

  // ---- Charts ----
  let timeseriesChart, modelChart, envChart;

  function ensureCharts() {
    const dim = getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim() || '#8b95a7';
    const border = getComputedStyle(document.documentElement).getPropertyValue('--border').trim() || '#1f2938';
    Chart.defaults.color = dim;
    Chart.defaults.borderColor = border;

    timeseriesChart = new Chart(document.getElementById('timeseriesChart'), {
      type: 'bar',
      data: { labels: [], datasets: [
        { label: 'Prompt', data: [], backgroundColor: '#5b8cff99', stack: 's' },
        { label: 'Completion', data: [], backgroundColor: '#38d39f99', stack: 's' },
      ] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: { x: { stacked: true, ticks: { font: { size: 10 } } }, y: { stacked: true, beginAtZero: true, ticks: { font: { size: 10 } } } },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
      },
    });

    modelChart = new Chart(document.getElementById('modelChart'), {
      type: 'bar',
      data: { labels: [], datasets: [{ label: 'Toplam Token', data: [], backgroundColor: '#5b8cff' }] },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        scales: { x: { ticks: { font: { size: 10 } } }, y: { ticks: { font: { size: 10 } } } },
        plugins: { legend: { display: false } },
      },
    });

    envChart = new Chart(document.getElementById('envChart'), {
      type: 'doughnut',
      data: { labels: [], datasets: [{ data: [], backgroundColor: ['#5b8cff', '#38d39f', '#f5a524', '#f05252', '#a78bfa'] }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 10 } } } },
      },
    });
  }

  function updateCharts(summary) {
    timeseriesChart.data.labels = summary.timeseries.map((b) => fmtTime(b.ts));
    timeseriesChart.data.datasets[0].data = summary.timeseries.map((b) => b.promptTokens);
    timeseriesChart.data.datasets[1].data = summary.timeseries.map((b) => b.completionTokens);
    timeseriesChart.update();

    const topModels = summary.byModel.slice(0, 10);
    modelChart.data.labels = topModels.map((m) => m.model);
    modelChart.data.datasets[0].data = topModels.map((m) => m.totalTokens);
    modelChart.update();

    envChart.data.labels = summary.byEnvironment.map((e) => e.environment);
    envChart.data.datasets[0].data = summary.byEnvironment.map((e) => e.totalTokens);
    envChart.update();
  }

  // ---- Data loading ----
  async function loadModelOptions() {
    const res = await fetch('/api/models');
    const data = await res.json();
    const modelSelect = document.getElementById('modelSelect');
    for (const model of data.models) {
      const opt = document.createElement('option');
      opt.value = model; opt.textContent = model;
      modelSelect.appendChild(opt);
    }
  }

  const KIND_LABEL = { local: 'yerel', proxy: 'proxy', 'eski-kayit': 'eski kayıt' };

  async function loadEnvironments() {
    const res = await fetch('/api/environments');
    const data = await res.json();
    state.allEnvironmentIds = data.environments.map((e) => e.id);
    if (state.environments.size === 0) {
      state.environments = new Set(state.allEnvironmentIds);
    }
    const box = document.getElementById('envCheckboxes');
    box.innerHTML = '';
    for (const env of data.environments) {
      const id = `env-${env.id}`;
      const wrap = document.createElement('label');
      wrap.className = 'env-checkbox' + (env.enabled ? '' : ' env-disabled');
      wrap.innerHTML = `
        <input type="checkbox" id="${id}" ${state.environments.has(env.id) ? 'checked' : ''} />
        <span>${env.label}</span>
        <span class="badge">${KIND_LABEL[env.kind] || env.kind}</span>
        ${env.enabled ? '' : '<span class="badge badge-off">kapalı</span>'}
      `;
      wrap.querySelector('input').addEventListener('change', (ev) => {
        if (ev.target.checked) state.environments.add(env.id);
        else state.environments.delete(env.id);
        refreshAll();
      });
      box.appendChild(wrap);
    }
  }

  async function loadSummary() {
    const res = await fetch('/api/summary?' + currentQuery());
    const summary = await res.json();
    document.getElementById('statTotal').textContent = fmtInt(summary.totals.totalTokens);
    document.getElementById('statPrompt').textContent = fmtInt(summary.totals.promptTokens);
    document.getElementById('statCompletion').textContent = fmtInt(summary.totals.completionTokens);
    document.getElementById('statCount').textContent = fmtInt(summary.totals.requestCount);
    const avg = summary.byModel.length
      ? summary.byModel.reduce((s, m) => s + (m.avgGenTps || 0) * m.requestCount, 0) /
        Math.max(1, summary.byModel.reduce((s, m) => s + (m.avgGenTps ? m.requestCount : 0), 0))
      : null;
    document.getElementById('statAvgTps').textContent = fmtTps(avg);
    updateCharts(summary);
  }

  async function loadEvents() {
    const params = currentQuery();
    params.set('limit', '100');
    const res = await fetch('/api/events?' + params);
    const data = await res.json();
    const body = document.getElementById('eventsBody');
    body.innerHTML = '';
    for (const e of data.events) {
      const tr = document.createElement('tr');
      if (e.truncated || e.estimated) tr.className = 'truncated';
      const durum = e.truncated ? 'kesildi' : e.estimated ? '≈ tahmini' : 'tamam';
      tr.innerHTML = `
        <td>${fmtTime(e.ts)}</td>
        <td>${e.environment}</td>
        <td>${e.model}</td>
        <td>${fmtInt(e.promptTokens)}</td>
        <td>${fmtInt(e.completionTokens)}</td>
        <td>${fmtInt(e.totalTokens)}</td>
        <td>${e.genTps != null ? e.genTps.toFixed(1) : '–'}</td>
        <td>${durum}</td>
      `;
      body.appendChild(tr);
    }
  }

  async function loadHealth() {
    const res = await fetch('/api/health');
    const h = await res.json();
    const dot = document.getElementById('healthDot');
    const text = document.getElementById('healthText');
    dot.className = 'health-dot';
    if (h.lastEventTs == null) {
      text.textContent = 'henüz veri yok';
    } else if (h.secondsSinceLastEvent < 300) {
      dot.classList.add('ok');
      text.textContent = `aktif · son istek ${h.secondsSinceLastEvent}s önce`;
    } else if (h.secondsSinceLastEvent < 3600) {
      dot.classList.add('stale');
      text.textContent = `son istek ${Math.round(h.secondsSinceLastEvent / 60)} dk önce`;
    } else {
      dot.classList.add('dead');
      text.textContent = `son istek ${Math.round(h.secondsSinceLastEvent / 3600)} saat önce`;
    }
  }

  async function refreshAll() {
    await Promise.all([loadSummary(), loadEvents(), loadHealth()]);
  }

  // ---- Live SSE ----
  let liveIdleTimer = null;
  function connectLive() {
    const es = new EventSource('/api/live');
    es.onmessage = (ev) => {
      const tick = JSON.parse(ev.data);
      const liveTps = document.getElementById('liveTps');
      const liveSub = document.getElementById('liveSub');
      liveTps.textContent = `${tick.approx ? '≈' : ''}${tick.tokensPerSecond.toFixed(1)} t/s`;
      liveSub.textContent = `${tick.environment} · ${tick.model} · ${tick.phase === 'prompt' ? 'prompt işleniyor' : 'üretiliyor'}`;
      clearTimeout(liveIdleTimer);
      liveIdleTimer = setTimeout(() => {
        liveTps.textContent = 'boşta';
        liveSub.textContent = '';
      }, 5000);
    };
    es.onerror = () => {
      // tarayici otomatik yeniden baglanir
    };
  }

  // ---- Filter wiring ----
  function wireFilters() {
    document.getElementById('presets').addEventListener('click', (ev) => {
      const btn = ev.target.closest('button[data-range]');
      if (!btn) return;
      document.querySelectorAll('#presets button').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      state.range = btn.dataset.range;
      const { from, to } = rangeToFromTo(state.range);
      state.from = from; state.to = to;
      document.getElementById('fromInput').value = from ? toLocalInput(from) : '';
      document.getElementById('toInput').value = to ? toLocalInput(to) : '';
      refreshAll();
    });

    document.getElementById('fromInput').addEventListener('change', (ev) => {
      state.from = ev.target.value ? new Date(ev.target.value).getTime() : null;
      clearPresetActive();
      refreshAll();
    });
    document.getElementById('toInput').addEventListener('change', (ev) => {
      state.to = ev.target.value ? new Date(ev.target.value).getTime() : null;
      clearPresetActive();
      refreshAll();
    });
    document.getElementById('envAllBtn').addEventListener('click', () => {
      state.environments = new Set(state.allEnvironmentIds);
      document.querySelectorAll('#envCheckboxes input[type="checkbox"]').forEach((cb) => (cb.checked = true));
      refreshAll();
    });
    document.getElementById('envNoneBtn').addEventListener('click', () => {
      state.environments = new Set();
      document.querySelectorAll('#envCheckboxes input[type="checkbox"]').forEach((cb) => (cb.checked = false));
      refreshAll();
    });
    document.getElementById('modelSelect').addEventListener('change', (ev) => {
      state.model = ev.target.value;
      refreshAll();
    });
    document.getElementById('exportBtn').addEventListener('click', () => {
      window.location.href = '/api/events.csv?' + currentQuery();
    });
  }

  function clearPresetActive() {
    document.querySelectorAll('#presets button').forEach((b) => b.classList.remove('active'));
  }

  function toLocalInput(ts) {
    const d = new Date(ts);
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  }

  async function init() {
    ensureCharts();
    wireFilters();
    const { from, to } = rangeToFromTo(state.range);
    state.from = from; state.to = to;
    await Promise.all([loadEnvironments(), loadModelOptions()]);
    await refreshAll();
    connectLive();

    setInterval(() => {
      if (document.getElementById('autoRefresh').checked) refreshAll();
    }, 8000);
  }

  init();
})();

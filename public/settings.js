(() => {
  'use strict';

  const form = document.getElementById('providerForm');
  const listEl = document.getElementById('providerList');
  const submitBtn = document.getElementById('submitBtn');
  const cancelEditBtn = document.getElementById('cancelEditBtn');

  function proxyUrlFor(id) {
    return `${window.location.origin}/proxy/${id}`;
  }

  function resetForm() {
    document.getElementById('editId').value = '';
    form.reset();
    document.getElementById('fEnabled').checked = true;
    submitBtn.textContent = 'Ekle';
    cancelEditBtn.hidden = true;
  }

  async function loadProviders() {
    const res = await fetch('/api/providers');
    const data = await res.json();
    listEl.innerHTML = '';
    if (!data.providers.length) {
      listEl.innerHTML = '<p class="hint">Henüz sağlayıcı eklenmedi.</p>';
      return;
    }
    for (const p of data.providers) {
      const row = document.createElement('div');
      row.className = 'provider-card';
      row.innerHTML = `
        <div class="provider-main">
          <strong>${p.label}</strong>
          <span class="badge">${p.protocol}</span>
          ${p.enabled ? '<span class="badge badge-on">etkin</span>' : '<span class="badge badge-off">devre dışı</span>'}
          <div class="hint">upstream: ${p.upstreamBaseUrl}${p.hasApiKey ? '' : ' · <b>API key yok</b>'}</div>
          <div class="proxy-url-row">
            <input readonly value="${proxyUrlFor(p.id)}" />
            <button type="button" class="copy-btn" data-url="${proxyUrlFor(p.id)}">Kopyala</button>
          </div>
        </div>
        <div class="provider-actions">
          <button type="button" class="edit-btn">Düzenle</button>
          <button type="button" class="toggle-btn">${p.enabled ? 'Devre dışı bırak' : 'Etkinleştir'}</button>
          <button type="button" class="delete-btn">Sil</button>
        </div>
      `;
      row.querySelector('.copy-btn').addEventListener('click', async (ev) => {
        await navigator.clipboard.writeText(ev.target.dataset.url).catch(() => {});
        ev.target.textContent = 'Kopyalandı';
        setTimeout(() => (ev.target.textContent = 'Kopyala'), 1200);
      });
      row.querySelector('.edit-btn').addEventListener('click', () => {
        document.getElementById('editId').value = p.id;
        document.getElementById('fLabel').value = p.label;
        document.getElementById('fProtocol').value = p.protocol;
        document.getElementById('fUrl').value = p.upstreamBaseUrl;
        document.getElementById('fKey').value = '';
        document.getElementById('fEnabled').checked = p.enabled;
        document.getElementById('fAuthHeader').value = p.authHeader || '';
        document.getElementById('fAuthScheme').value = p.authScheme || '';
        submitBtn.textContent = 'Güncelle';
        cancelEditBtn.hidden = false;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      row.querySelector('.toggle-btn').addEventListener('click', async () => {
        await fetch(`/api/providers/${p.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !p.enabled }),
        });
        loadProviders();
      });
      row.querySelector('.delete-btn').addEventListener('click', async () => {
        if (!confirm(`"${p.label}" silinsin mi?`)) return;
        await fetch(`/api/providers/${p.id}`, { method: 'DELETE' });
        loadProviders();
      });
      listEl.appendChild(row);
    }
  }

  cancelEditBtn.addEventListener('click', resetForm);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const id = document.getElementById('editId').value;
    const payload = {
      label: document.getElementById('fLabel').value.trim(),
      protocol: document.getElementById('fProtocol').value,
      upstreamBaseUrl: document.getElementById('fUrl').value.trim(),
      apiKey: document.getElementById('fKey').value,
      authHeader: document.getElementById('fAuthHeader').value.trim() || undefined,
      authScheme: document.getElementById('fAuthScheme').value.trim(),
      enabled: document.getElementById('fEnabled').checked,
    };
    const res = await fetch(id ? `/api/providers/${id}` : '/api/providers', {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'bilinmeyen hata' }));
      alert('Hata: ' + err.error);
      return;
    }
    resetForm();
    loadProviders();
  });

  loadProviders();
})();

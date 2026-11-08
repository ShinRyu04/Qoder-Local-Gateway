'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Qoder Proxy — Web Console App
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Theme ─────────────────────────────────────────────────────────────────────

let currentTheme = 'dark';

function initTheme() {
  var prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  currentTheme = prefersDark ? 'dark' : 'light';
  applyTheme();
}

function toggleTheme() {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  applyTheme();
}

function applyTheme() {
  document.body.classList.remove('dark', 'light');
  document.body.classList.add(currentTheme);
  var icon = document.getElementById('theme-icon');
  if (icon) {
    icon.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
  }
}

// ─── Language (ID / EN) ────────────────────────────────────────────────────────

var LANG_STORAGE = 'qoder-proxy-lang';
var currentLang = 'id';

function msg(id, en) {
  return currentLang === 'id' ? id : en;
}

function applyStaticLang() {
  document.querySelectorAll('[data-id-text]').forEach(function (el) {
    el.textContent = currentLang === 'id' ? el.dataset.idText : el.dataset.enText;
  });
  document.querySelectorAll('[data-id-html]').forEach(function (el) {
    el.innerHTML = currentLang === 'id' ? el.dataset.idHtml : el.dataset.enHtml;
  });
  document.querySelectorAll('[data-id-placeholder]').forEach(function (el) {
    el.placeholder = currentLang === 'id' ? el.dataset.idPlaceholder : el.dataset.enPlaceholder;
  });
  document.querySelectorAll('[data-id-title]').forEach(function (el) {
    el.title = currentLang === 'id' ? el.dataset.idTitle : el.dataset.enTitle;
  });
  document.documentElement.lang = currentLang === 'id' ? 'id' : 'en';
  var select = document.getElementById('lang-select');
  if (select) select.value = currentLang;
}

function setLang(lang) {
  currentLang = lang === 'en' ? 'en' : 'id';
  try {
    window.localStorage.setItem(LANG_STORAGE, currentLang);
  } catch (_) {
    // Storage can be unavailable; the choice still applies for this session.
  }
  applyStaticLang();
  ['dashboard-content', 'models-content', 'usage-content', 'accounts-content'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.dataset.loaded = '0';
  });
  var active = document.querySelector('.nav-item.active');
  switchTab(active ? active.dataset.tab : 'dashboard');
}

function initLang() {
  try {
    var saved = window.localStorage.getItem(LANG_STORAGE);
    if (saved === 'id' || saved === 'en') currentLang = saved;
  } catch (_) {
    // Default to Indonesian.
  }
  var select = document.getElementById('lang-select');
  if (select) {
    select.value = currentLang;
    select.addEventListener('change', function () {
      setLang(select.value);
    });
  }
  applyStaticLang();
}

// ─── Sidebar ───────────────────────────────────────────────────────────────────

function initSidebar() {
  var toggleBtn = document.getElementById('sidebar-toggle');
  var sidebar = document.getElementById('sidebar');
  var overlay = document.getElementById('sidebar-overlay');

  if (!toggleBtn || !sidebar) return;

  function openSidebar() {
    sidebar.classList.add('open');
    if (overlay) overlay.classList.add('open');
  }

  function closeSidebar() {
    sidebar.classList.remove('open');
    if (overlay) overlay.classList.remove('open');
  }

  toggleBtn.addEventListener('click', function () {
    if (sidebar.classList.contains('open')) {
      closeSidebar();
    } else {
      openSidebar();
    }
  });

  if (overlay) {
    overlay.addEventListener('click', closeSidebar);
  }
}

// ─── Tab Switching ─────────────────────────────────────────────────────────────

function initTabs() {
  var navItems = document.querySelectorAll('.nav-item');
  navItems.forEach(function (item) {
    item.addEventListener('click', function () {
      switchTab(item.dataset.tab);
    });
  });
}

function switchTab(tab) {
  // Update nav
  document.querySelectorAll('.nav-item').forEach(function (b) {
    b.classList.toggle('active', b.dataset.tab === tab);
  });

  // Update content
  document.querySelectorAll('.tab-content').forEach(function (c) {
    c.classList.toggle('active', c.id === tab);
  });

  // Close mobile sidebar
  var sidebar = document.getElementById('sidebar');
  if (sidebar) sidebar.classList.remove('open');
  var overlay = document.getElementById('sidebar-overlay');
  if (overlay) overlay.classList.remove('open');

  // Load data
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'models') loadModels();
  if (tab === 'accounts') loadAccounts();
  if (tab === 'usage') loadUsage();
}

// ─── API helpers ───────────────────────────────────────────────────────────────

// The console is a browser client like any other, so when PROXY_API_KEY is set
// it must present the key too. Kept in localStorage so it survives reloads.
var API_KEY_STORAGE = 'qoder-proxy-api-key';

function getApiKey() {
  try {
    return window.localStorage.getItem(API_KEY_STORAGE) || '';
  } catch (_) {
    return '';
  }
}

function setApiKey(value) {
  try {
    if (value) {
      window.localStorage.setItem(API_KEY_STORAGE, value);
    } else {
      window.localStorage.removeItem(API_KEY_STORAGE);
    }
  } catch (_) {
    // Private browsing modes can refuse storage; the key just won't persist.
  }
}

function api(path, options) {
  var opts = options || {};
  var headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  var key = getApiKey();
  if (key) {
    headers['Authorization'] = 'Bearer ' + key;
  }

  return fetch(path, Object.assign({}, opts, { headers: headers })).then(function (res) {
    if (!res.ok) {
      return res
        .json()
        .catch(function () {
          return {};
        })
        .then(function (body) {
          var message =
            (body.error && body.error.message) ||
            msg('Permintaan gagal: ', 'Request failed: ') + res.status;
          if (res.status === 401) {
            message = msg(
              'Tidak diizinkan. Isi API key proxy di tab Config.',
              'Unauthorized. Set the proxy API key in the Config tab.'
            );
          }
          throw new Error(message);
        });
    }
    return res.json();
  });
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────

function loadDashboard() {
  var container = document.getElementById('dashboard-content');
  if (!container || container.dataset.loaded === '1') return;
  container.innerHTML = '<div class="loading">' + msg('Memuat...', 'Loading...') + '</div>';

  Promise.all([api('/'), api('/health'), api('/v1/models')])
    .then(function (data) {
      var info = data[0];
      var models = data[2];
      var modelCount = models.data ? models.data.length : 0;

      var backendName = info.cli_backend === 'global' ? 'Global (qodercli)' : 'CN (qoderclicn)';

      container.innerHTML =
        '<div class="stat-grid">' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Status', 'Status') + '</div>' +
            '<div class="stat-value success"><span class="status-dot green"></span>' + msg('Berjalan', 'Running') + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Backend CLI', 'CLI Backend') + '</div>' +
            '<div class="stat-value">' + escapeHtml(backendName) + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Model', 'Models') + '</div>' +
            '<div class="stat-value">' + modelCount + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">Base URL</div>' +
            '<div class="stat-value muted">127.0.0.1:3000</div>' +
          '</div>' +
        '</div>' +
        '<div class="alert info">' +
          msg(
            'Adapter protokol lokal berjalan. Buka Web UI di <code>http://127.0.0.1:3000/ui</code>',
            'Local protocol adapter running. Access the Web UI at <code>http://127.0.0.1:3000/ui</code>'
          ) +
        '</div>';
      container.dataset.loaded = '1';
    })
    .catch(function (err) {
      container.innerHTML =
        '<div class="alert error">' + msg('Gagal memuat dashboard: ', 'Failed to load dashboard: ') + escapeHtml(err.message) + '</div>';
    });
}

// ─── Models ────────────────────────────────────────────────────────────────────

function loadModels() {
  var container = document.getElementById('models-content');
  if (!container || container.dataset.loaded === '1') return;
  container.innerHTML = '<div class="loading">' + msg('Memuat...', 'Loading...') + '</div>';

  api('/v1/models')
    .then(function (data) {
      if (!data.data || data.data.length === 0) {
        container.innerHTML = '<div class="alert info">' + msg('Tidak ada model.', 'No models found.') + '</div>';
        return;
      }

      var rows = data.data.map(function (m) {
        var reasoning = m.capabilities && m.capabilities.reasoning ? '<span style="color:var(--success)">&#9679;</span>' : '';
        var badge = m.effort_alias ? ' <span style="font-size:0.7rem;color:var(--text-secondary)">(' + msg('alias effort', 'effort alias') + ')</span>' : '';
        return (
          '<tr>' +
            '<td><code>' + escapeHtml(m.id) + '</code></td>' +
            '<td>' + escapeHtml(m.name || '') + badge + '</td>' +
            '<td>' + reasoning + '</td>' +
          '</tr>'
        );
      }).join('');

      container.innerHTML =
        '<div class="glass card" style="padding:0;overflow:hidden;">' +
          '<table>' +
            '<thead><tr><th style="padding:0.75rem 1rem">ID</th><th style="padding:0.75rem 1rem">' + msg('Nama', 'Name') + '</th><th style="padding:0.75rem 1rem">' + msg('Reasoning', 'Reasoning') + '</th></tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>';
      container.dataset.loaded = '1';
    })
    .catch(function (err) {
      container.innerHTML =
        '<div class="alert error">' + msg('Gagal memuat model: ', 'Failed to load models: ') + escapeHtml(err.message) + '</div>';
    });
}

// ─── Chat Test ─────────────────────────────────────────────────────────────────

var chatMessages = [];
var isChatSending = false;

function addChatMessage(role, text, html) {
  var messagesEl = document.getElementById('chat-messages');
  if (!messagesEl) return;
  if (chatMessages.length === 0) {
    messagesEl.innerHTML = '';
  }
  var msgDiv = document.createElement('div');
  msgDiv.className = 'chat-msg ' + role;
  var avatar = role === 'user' ? '&#128100;' : '&#129302;';
  var content = html || escapeHtml(text);
  msgDiv.innerHTML =
    '<div class="chat-msg-avatar">' + avatar + '</div>' +
    '<div class="chat-msg-body">' + content + '</div>';
  messagesEl.appendChild(msgDiv);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  chatMessages.push({ role: role, text: text });
}

function setChatLoading(loading) {
  var messagesEl = document.getElementById('chat-messages');
  if (!messagesEl) return;
  if (loading) {
    var div = document.createElement('div');
    div.className = 'chat-msg assistant';
    div.id = 'chat-loading';
    div.innerHTML =
      '<div class="chat-msg-avatar">&#129302;</div>' +
      '<div class="chat-msg-body"><span style="opacity:0.6">' + msg('Berpikir...', 'Thinking...') + '</span></div>';
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  } else {
    var loadingEl = document.getElementById('chat-loading');
    if (loadingEl) loadingEl.remove();
  }
}

function initChat() {
  var sendBtn = document.getElementById('chat-send');
  var textarea = document.getElementById('chat-message');
  var modelSelect = document.getElementById('chat-model');

  if (!sendBtn || !textarea) return;

  // Populate model dropdown
  api('/v1/models')
    .then(function (data) {
      if (!data.data || !modelSelect) return;
      data.data.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m.id;
        opt.textContent = m.id + ' (' + (m.name || '') + ')';
        modelSelect.appendChild(opt);
      });
    })
    .catch(function () {});

  // Send on button click
  sendBtn.addEventListener('click', function () {
    doChat();
  });

  // Send on Enter (Shift+Enter for newline)
  textarea.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      doChat();
    }
  });
}

function doChat() {
  var textarea = document.getElementById('chat-message');
  var modelSelect = document.getElementById('chat-model');
  var sendBtn = document.getElementById('chat-send');

  if (!textarea || !modelSelect) return;
  var message = textarea.value.trim();
  if (!message) return;
  if (isChatSending) return;

  isChatSending = true;
  sendBtn.disabled = true;
  sendBtn.innerHTML = '<span class="send-icon">&#9670;</span>';

  // Show user message
  addChatMessage('user', message);

  // Clear textarea
  textarea.value = '';

  // Show loading
  setChatLoading(true);

  api('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: modelSelect.value,
      messages: [{ role: 'user', content: message }],
    }),
  })
    .then(function (data) {
      setChatLoading(false);
      var content = (data.choices && data.choices[0] && data.choices[0].message)
        ? data.choices[0].message.content
        : msg('Tidak ada isi respons', 'No response content');
      addChatMessage('assistant', content);
    })
    .catch(function (err) {
      setChatLoading(false);
      addChatMessage('assistant', msg('Kesalahan: ', 'Error: ') + err.message);
    })
    .finally(function () {
      sendBtn.disabled = false;
      sendBtn.innerHTML = '<span class="send-icon">&#8594;</span>';
      isChatSending = false;
    });
}

// ─── Config ────────────────────────────────────────────────────────────────────

function initApiKey() {
  var input = document.getElementById('api-key-input');
  var saveBtn = document.getElementById('api-key-save');
  var status = document.getElementById('api-key-status');
  if (!input || !saveBtn) return;

  input.value = getApiKey();

  function showStatus(text, kind) {
    if (!status) return;
    status.textContent = text;
    status.className = 'api-key-status ' + (kind || '');
  }

  if (getApiKey()) {
    showStatus(msg('Key tersimpan di browser ini.', 'A key is saved in this browser.'), 'ok');
  }

  saveBtn.addEventListener('click', function () {
    var value = input.value.trim();
    setApiKey(value);
    showStatus(
      value
        ? msg('Key disimpan. Memuat ulang data konsol…', 'Key saved. Reloading console data…')
        : msg('Key dihapus.', 'Key cleared.'),
      value ? 'ok' : ''
    );
    // Re-fetch every tab with the new credential.
    ['dashboard-content', 'models-content', 'usage-content', 'accounts-content'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.dataset.loaded = '0';
    });
    loadDashboard();
  });

  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      saveBtn.click();
    }
  });
}

function initConfig() {
  document.querySelectorAll('.btn.copy').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var target = document.getElementById(btn.dataset.target);
      if (!target) return;
      var text = target.textContent;
      navigator.clipboard.writeText(text).then(function () {
        var original = btn.textContent;
        btn.textContent = msg('Tersalin!', 'Copied!');
        setTimeout(function () { btn.textContent = original; }, 1500);
      }).catch(function () {
        btn.textContent = msg('Gagal', 'Failed');
        setTimeout(function () { btn.textContent = msg('Salin', 'Copy'); }, 1500);
      });
    });
  });
}

// ─── Usage / Credits ─────────────────────────────────────────────────────────

function formatCredits(value) {
  var n = Number(value) || 0;
  return n.toFixed(3);
}

function loadUsage() {
  var container = document.getElementById('usage-content');
  if (!container || container.dataset.loaded === '1') return;
  container.innerHTML = '<div class="loading">' + msg('Memuat...', 'Loading...') + '</div>';

  api('/usage/local')
    .then(function (data) {
      var creditsByModel = data.creditsByModel || {};
      var requestsByModel = data.requestsByModel || {};
      var modelNames = Object.keys(creditsByModel);
      Object.keys(requestsByModel).forEach(function (model) {
        if (modelNames.indexOf(model) === -1) modelNames.push(model);
      });

      var modelRows = '';
      if (modelNames.length > 0) {
        var rows = modelNames.map(function (model) {
          return (
            '<tr>' +
              '<td><code>' + escapeHtml(model) + '</code></td>' +
              '<td>' + (requestsByModel[model] || 0) + '</td>' +
              '<td>' + formatCredits(creditsByModel[model]) + '</td>' +
            '</tr>'
          );
        }).join('');
        modelRows =
          '<div class="glass card" style="padding:0;overflow:hidden;">' +
            '<table>' +
              '<thead><tr>' +
                '<th style="padding:0.75rem 1rem">' + msg('Model', 'Model') + '</th>' +
                '<th style="padding:0.75rem 1rem">' + msg('Request', 'Requests') + '</th>' +
                '<th style="padding:0.75rem 1rem">' + msg('Kredit', 'Credits') + '</th>' +
              '</tr></thead>' +
              '<tbody>' + rows + '</tbody>' +
            '</table>' +
          '</div>';
      }

      var burn = data.burnRate || {};
      var rate = Number(burn.ratePerHour) || 0;
      var remaining = burn.remaining;
      var requiredRate = burn.requiredRatePerHour;
      var hoursLeft = burn.hoursLeft;
      var paceLabels = {
        ahead: msg('Lebih cepat dari deadline', 'Ahead of deadline'),
        on_track: msg('Sesuai jalur', 'On track'),
        behind: msg('Tertinggal dari deadline', 'Behind deadline'),
      };
      var pace = burn.pace && paceLabels[burn.pace] ? paceLabels[burn.pace] : msg('Belum ada pace', 'No pace yet');
      var projection = msg(
        'Masukkan sisa kredit SOTA dari panel Qoder untuk memproyeksikan sisa waktu.',
        'Enter the remaining SOTA credits from the Qoder panel to project burn-down.'
      );
      if (remaining !== null && remaining !== undefined) {
        if (rate > 0 && burn.projectedHours !== null) {
          projection =
            msg('Sisa ', 'Remaining ') + '<strong>' + formatCredits(remaining) + '</strong>' +
            msg(' &middot; laju ~', ' &middot; burn ~') + '<strong>' + formatCredits(rate) + '</strong>' +
            msg(' kredit/jam', ' credits/hour') +
            msg(' &middot; habis dalam ', ' &middot; empty in ') + '<strong>' + Number(burn.projectedHours).toFixed(1) +
            msg(' jam</strong>', ' h</strong>') +
            (burn.projectedEmptyAt
              ? msg(' (sekitar ', ' (around ') + new Date(burn.projectedEmptyAt).toLocaleString() + ')'
              : '');
        } else {
          projection =
            msg('Sisa ', 'Remaining ') + '<strong>' + formatCredits(remaining) + '</strong>' +
            msg(
              ' &middot; sampel kredit belum cukup untuk menghitung laju.',
              ' &middot; not enough credit samples yet for a rate.'
            );
        }
        if (requiredRate !== null && requiredRate !== undefined) {
          projection +=
            msg('<br/>Dibutuhkan: ', '<br/>Needed: ') + '<strong>' + formatCredits(requiredRate) + '</strong>' +
            msg(' kredit/jam untuk sisa ', ' credits/hour for the ') +
            Number(hoursLeft).toFixed(1) + msg(' jam &middot; <strong>', ' h left &middot; <strong>') + pace + '</strong>';
        }
      }

      var sourceAlert = data.source === 'cli-reported'
        ? '<div class="alert info">' +
            msg(
              'Biaya kredit <strong>dilaporkan oleh CLI</strong> per request (<code>total_credits</code>). Ini pemakaian, bukan sisa kuota resmi; isi saldo panel di bawah untuk proyeksi.',
              'Credit charges are <strong>reported by the CLI</strong> per request (<code>total_credits</code>). This is usage, not the official remaining quota; enter the panel balance below for projections.'
            ) +
          '</div>'
        : '<div class="alert warning">' +
            msg(
              'Belum ada kredit dari CLI. Angka token adalah <strong>estimasi lokal</strong>; total kredit muncul setelah request pertama yang berhasil.',
              'No CLI-reported credits yet. Token numbers are <strong>local estimates</strong>; credit totals appear after the first successful request.'
            ) +
          '</div>';

      var lastReq = data.lastRequestAt
        ? new Date(data.lastRequestAt).toLocaleString()
        : msg('Belum pernah', 'Never');

      container.innerHTML =
        sourceAlert +

        '<div class="stat-grid">' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Total Kredit', 'Credits Total') + '</div>' +
            '<div class="stat-value">' + formatCredits(data.creditsTotal) + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Kredit Hari Ini', 'Credits Today') + '</div>' +
            '<div class="stat-value">' + formatCredits(data.creditsToday) + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Biaya (USD)', 'Cost (USD)') + '</div>' +
            '<div class="stat-value">$' + formatCredits(data.creditsCostUsd) + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Kredit 1 Jam Terakhir', 'Credits Last 1h') + '</div>' +
            '<div class="stat-value">' + formatCredits(burn.creditsLastHour) + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Kredit 6 Jam Terakhir', 'Credits Last 6h') + '</div>' +
            '<div class="stat-value">' + formatCredits(burn.creditsLast6Hours) + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Kredit 24 Jam Terakhir', 'Credits Last 24h') + '</div>' +
            '<div class="stat-value">' + formatCredits(burn.creditsLast24Hours) + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="glass card">' +
          '<h3 style="font-size:0.8125rem;color:var(--text-secondary);margin-bottom:0.75rem">' + msg('Laju Pemakaian', 'Burn Rate') + '</h3>' +
          '<p style="margin-bottom:0.75rem">' + projection + '</p>' +
          '<label for="sota-remaining" style="display:block;margin-bottom:0.375rem;color:var(--text-secondary);font-size:0.8125rem">' + msg('Sisa kredit SOTA', 'SOTA credits remaining') + '</label>' +
          '<div style="display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;">' +
            '<input id="sota-remaining" type="number" min="0" step="0.001" value="' + (remaining !== null && remaining !== undefined ? remaining : '') + '" placeholder="e.g. 2000" style="flex:1 1 160px;padding:0.5rem 0.75rem;border-radius:0.5rem;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);" />' +
            '<input id="sota-deadline" type="date" value="' + (burn.deadline ? String(burn.deadline).slice(0, 10) : '') + '" style="flex:0 1 170px;padding:0.5rem 0.75rem;border-radius:0.5rem;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);" />' +
            '<button class="btn" id="save-target-btn">' + msg('Simpan', 'Save') + '</button>' +
          '</div>' +
          '<p style="margin-top:0.5rem;font-size:0.75rem;color:var(--text-secondary)">' +
            msg(
              'Deadline dipakai untuk menghitung required rate dan status pace.',
              'The deadline drives the required rate and pace status.'
            ) +
          '</p>' +
        '</div>' +

        modelRows +

        '<div class="stat-grid">' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Total Request', 'Total Requests') + '</div>' +
            '<div class="stat-value">' + data.totalRequests + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Hari Ini', 'Today') + '</div>' +
            '<div class="stat-value">' + data.requestsToday + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Error', 'Errors') + '</div>' +
            '<div class="stat-value ' + (data.errorCount > 0 ? 'error' : '') + '">' + data.errorCount + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Est. Token Input', 'Est. Input Tokens') + '</div>' +
            '<div class="stat-value">' + data.estimatedInputTokens.toLocaleString() + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Est. Token Output', 'Est. Output Tokens') + '</div>' +
            '<div class="stat-value">' + data.estimatedOutputTokens.toLocaleString() + '</div>' +
          '</div>' +
          '<div class="glass stat-item">' +
            '<div class="stat-label">' + msg('Est. Total Token', 'Est. Total Tokens') + '</div>' +
            '<div class="stat-value">' + data.estimatedTotalTokens.toLocaleString() + '</div>' +
          '</div>' +
        '</div>' +

        '<div class="glass card">' +
          '<h3 style="font-size:0.8125rem;color:var(--text-secondary);margin-bottom:0.75rem">' + msg('Info Sesi', 'Session Info') + '</h3>' +
          '<table>' +
            '<tbody>' +
              '<tr><td>' + msg('Mulai', 'Started') + '</td><td>' + new Date(data.startedAt).toLocaleString() + '</td></tr>' +
              '<tr><td>' + msg('Request Terakhir', 'Last Request') + '</td><td>' + lastReq + '</td></tr>' +
            '</tbody>' +
          '</table>' +
        '</div>' +

        '<button class="btn danger" id="reset-usage-btn">' + msg('Reset Statistik Lokal', 'Reset Local Stats') + '</button>';
      container.dataset.loaded = '1';

      document.getElementById('save-target-btn').addEventListener('click', saveTarget);
      document.getElementById('reset-usage-btn').addEventListener('click', resetUsage);
    })
    .catch(function (err) {
      container.innerHTML =
        '<div class="alert error">' + msg('Gagal memuat penggunaan: ', 'Failed to load usage: ') + escapeHtml(err.message) + '</div>';
    });
}

function reloadUsage() {
  var container = document.getElementById('usage-content');
  if (container) container.dataset.loaded = '0';
  loadUsage();
}

function saveTarget() {
  var input = document.getElementById('sota-remaining');
  if (!input) return;
  var deadlineInput = document.getElementById('sota-deadline');
  var raw = input.value.trim();
  var payload = {
    creditsRemaining: raw === '' ? null : Number(raw),
    deadline: deadlineInput && deadlineInput.value ? deadlineInput.value : null,
  };

  api('/usage/target', { method: 'POST', body: JSON.stringify(payload) })
    .then(reloadUsage)
    .catch(function (err) {
      alert(msg('Gagal menyimpan target: ', 'Failed to save target: ') + err.message);
    });
}

function reloadAccounts() {
  var container = document.getElementById('accounts-content');
  if (container) container.dataset.loaded = '0';
  return loadAccounts();
}

function loadAccounts() {
  var container = document.getElementById('accounts-content');
  if (!container) return Promise.resolve();
  if (container.dataset.loaded === '1') return Promise.resolve();
  container.innerHTML = '<div class="loading">' + msg('Memuat...', 'Loading...') + '</div>';

  return Promise.all([api('/accounts'), api('/usage/local')])
    .then(function (results) {
      var accounts = results[0] || { profiles: [] };
      var usage = results[1] || {};
      var creditsByProfile = usage.creditsByProfile || {};

      var rows = (accounts.profiles || []).map(function (profile) {
        var status = profile.active ? msg('aktif', 'active') : msg('siap', 'idle');
        if (profile.cooldownUntil) {
          status = msg('cooldown sampai ', 'cooldown until ') + new Date(profile.cooldownUntil).toLocaleTimeString();
        }
        var auth = profile.auth ? msg('sudah login', 'logged in') : msg('belum login', 'no auth');
        var loginButton = accounts.oauth
          ? '<button class="btn" data-account-login="' + escapeHtml(profile.name) + '">' +
              (profile.auth ? msg('Login ulang', 'Re-login') : 'Login') +
            '</button> '
          : '';
        return (
          '<tr>' +
            '<td><strong>' + escapeHtml(profile.label || profile.name) + '</strong><br/><code>' + escapeHtml(profile.name) + '</code></td>' +
            '<td><code style="font-size:0.75rem">' + escapeHtml(profile.home || '~ (default)') + '</code></td>' +
            '<td>' + auth + '<br/>' + escapeHtml(status) + '</td>' +
            '<td>' + formatCredits(creditsByProfile[profile.name]) + '</td>' +
            '<td>' +
              loginButton +
              (profile.active ? '' : '<button class="btn" data-account-switch="' + escapeHtml(profile.name) + '">' + msg('Aktifkan', 'Activate') + '</button> ') +
              (profile.name === 'default' ? '' : '<button class="btn danger" data-account-remove="' + escapeHtml(profile.name) + '">' + msg('Hapus', 'Delete') + '</button>') +
            '</td>' +
          '</tr>'
        );
      }).join('');

      var backendNote = accounts.oauth
        ? msg(
            'Klik <strong>Hubungkan akun</strong> untuk membuat profil baru, atau <strong>Login</strong> pada profil lama. Setelah disetujui, status menjadi <code>sudah login</code>.',
            'Click <strong>Hubungkan akun</strong> to create a profile, or <strong>Login</strong> on an existing one. After approval the status becomes <code>logged in</code>.'
          )
        : msg(
            'Backend <code>' + escapeHtml(accounts.backend || 'cn') + '</code> memakai Personal Access Token, jadi tidak ada link OAuth. Isi token di <code>.env</code>.',
            'Backend <code>' + escapeHtml(accounts.backend || 'cn') + '</code> uses a Personal Access Token, so there is no OAuth link. Set the token in <code>.env</code>.'
          );

      container.innerHTML =
        '<div class="alert warning">' +
          msg(
            'Rotasi otomatis saat quota/rate/billing habis memakai akun lain di ring. Ini bisa melanggar ketentuan Qoder; <strong>risiko ditanggung sendiri</strong>. Tiap profil harus login sendiri.',
            'Automatic rotation uses another account in the ring when one hits quota/rate/billing limits. This may violate Qoder terms; <strong>you accept the risk</strong>. Each profile must log in separately.'
          ) +
        '</div>' +
        '<div class="glass card" style="padding:0;overflow:hidden;">' +
          '<table><thead><tr><th style="padding:0.75rem 1rem">' + msg('Profil', 'Profile') + '</th><th style="padding:0.75rem 1rem">Home</th><th style="padding:0.75rem 1rem">Status</th><th style="padding:0.75rem 1rem">' + msg('Kredit', 'Credits') + '</th><th style="padding:0.75rem 1rem"></th></tr></thead>' +
          '<tbody>' + (rows || '<tr><td colspan="5">' + msg('Belum ada profil.', 'No profiles.') + '</td></tr>') + '</tbody></table>' +
        '</div>' +
        '<div class="glass card">' +
          '<h3 style="font-size:0.8125rem;color:var(--text-secondary);margin-bottom:0.75rem">' + msg('Hubungkan akun baru', 'Connect a new account') + '</h3>' +
          '<p style="margin-bottom:0.75rem;font-size:0.8125rem;color:var(--text-secondary)">' + backendNote + '</p>' +
          '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">' +
            '<input id="account-label" placeholder="' + msg('Label akun baru (mis. kerja) — opsional', 'New account label (e.g. work) — optional') + '" style="flex:1 1 280px;padding:0.5rem 0.75rem;border-radius:0.5rem;border:1px solid var(--border);background:var(--bg-secondary);color:var(--text-primary);" />' +
            '<button class="btn primary" id="link-account-btn">' + msg('Hubungkan akun', 'Connect account') + '</button>' +
          '</div>' +
        '</div>';

      container.dataset.loaded = '1';

      var linkButton = document.getElementById('link-account-btn');
      if (linkButton) {
        linkButton.addEventListener('click', linkAccount);
        var labelInput = document.getElementById('account-label');
        if (labelInput) {
          labelInput.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') linkAccount();
          });
        }
      }

      Array.prototype.forEach.call(container.querySelectorAll('[data-account-login]'), function (button) {
        button.addEventListener('click', function () {
          startAccountLogin(button.getAttribute('data-account-login'));
        });
      });
      Array.prototype.forEach.call(container.querySelectorAll('[data-account-switch]'), function (button) {
        button.addEventListener('click', function () {
          switchProfile(button.getAttribute('data-account-switch'));
        });
      });
      Array.prototype.forEach.call(container.querySelectorAll('[data-account-remove]'), function (button) {
        button.addEventListener('click', function () {
          removeAccount(button.getAttribute('data-account-remove'));
        });
      });
    })
    .catch(function (err) {
      container.innerHTML =
        '<div class="alert error">' + msg('Gagal memuat akun: ', 'Failed to load accounts: ') + escapeHtml(err.message) + '</div>';
    });
}

var loginPollToken = 0;
var createdByLinkFlow = null;

function setLoginStatus(message, isError) {
  var element = document.getElementById('login-status');
  if (!element) return;
  element.textContent = message || '';
  element.className = isError ? 'alert error' : '';
}

function showLoginPanel(name, url, message, isError) {
  var panel = document.getElementById('accounts-login');
  if (!panel) return;
  var actions = url
    ? '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin:0.75rem 0">' +
        '<a class="btn primary" href="' + escapeHtml(url) + '" target="_blank" rel="noopener">' + msg('Buka halaman izin', 'Open authorization page') + '</a>' +
        '<button class="btn" id="copy-login-link">' + msg('Salin tautan', 'Copy link') + '</button>' +
        '<button class="btn danger" id="cancel-login-btn">' + msg('Batal', 'Cancel') + '</button>' +
      '</div>'
    : '';
  panel.innerHTML =
    '<div class="glass card">' +
      '<h3 style="font-size:0.8125rem;color:var(--text-secondary);margin-bottom:0.5rem">' + msg('Hubungkan akun', 'Connect account') + ' — <code>' + escapeHtml(name) + '</code></h3>' +
      (url ? '<p style="margin:0;font-size:0.8125rem;color:var(--text-secondary)">' + msg('Setujui tautan ini di browser yang sudah login ke Qoder:', 'Approve this link in a browser already logged in to Qoder:') + '</p>' : '') +
      actions +
      '<p id="login-status" class="' + (isError ? 'alert error' : '') + '" style="margin:0;white-space:pre-wrap">' + escapeHtml(message || '') + '</p>' +
    '</div>';

  var copyButton = document.getElementById('copy-login-link');
  if (copyButton && url) {
    copyButton.addEventListener('click', function () {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(
          function () {
            setLoginStatus(msg('Tautan disalin.', 'Link copied.'));
          },
          function () {
            window.prompt(msg('Salin tautan login:', 'Copy this login link:'), url);
          }
        );
      } else {
        window.prompt(msg('Salin tautan login:', 'Copy this login link:'), url);
      }
    });
  }

  var cancelButton = document.getElementById('cancel-login-btn');
  if (cancelButton) {
    cancelButton.addEventListener('click', function () {
      cancelAccountLogin(name);
    });
  }
}

function cancelAccountLogin(name) {
  loginPollToken += 1;
  var wasCreated = createdByLinkFlow === name;
  createdByLinkFlow = null;

  api('/accounts/login/cancel', { method: 'POST', body: JSON.stringify({ name: name }) })
    .then(function () {
      if (!wasCreated) {
        showLoginPanel(name, null, msg('Dibatalkan.', 'Cancelled.'), false);
        return null;
      }
      return api('/accounts?name=' + encodeURIComponent(name), { method: 'DELETE' }).then(function () {
        showLoginPanel(name, null, msg('Dibatalkan.', 'Cancelled.'), false);
        return reloadAccounts();
      });
    })
    .catch(function (err) {
      showLoginPanel(name, null, msg('Gagal membatalkan: ', 'Failed to cancel: ') + err.message, true);
    });
}

function pollLogin(name, attempt, token) {
  if (token !== loginPollToken) return;
  if (attempt >= 150) {
    setLoginStatus(msg('Waktu login habis. Klik Login untuk mencoba lagi.', 'Login timed out. Click Login to try again.'), true);
    return;
  }
  setTimeout(function () {
    if (token !== loginPollToken) return;
    Promise.all([
      api('/accounts'),
      api('/accounts/login?name=' + encodeURIComponent(name)),
    ])
      .then(function (results) {
        if (token !== loginPollToken) return;
        var accounts = results[0] || {};
        var status = results[1] || {};
        var profile = (accounts.profiles || []).find(function (entry) {
          return entry.name === name;
        });
        if (profile && profile.auth) {
          loginPollToken += 1;
          createdByLinkFlow = null;
          showLoginPanel(name, null, msg('Login berhasil. Profil siap dipakai.', 'Login successful. The profile is ready.'), false);
          reloadAccounts();
          return;
        }
        if (status.error) {
          showLoginPanel(name, status.url || null, status.error, true);
          return;
        }
        setLoginStatus(msg('Menunggu persetujuan...', 'Waiting for approval...'));
        pollLogin(name, attempt + 1, token);
      })
      .catch(function () {
        if (token === loginPollToken) pollLogin(name, attempt + 1, token);
      });
  }, 2000);
}

function startAccountLogin(name, createdFlow) {
  createdByLinkFlow = createdFlow ? name : null;
  var token = ++loginPollToken;
  showLoginPanel(name, null, msg('Membuka halaman login Qoder...', 'Opening the Qoder login page...'), false);
  api('/accounts/login', { method: 'POST', body: JSON.stringify({ name: name }) })
    .then(function (result) {
      if (token !== loginPollToken) return;
      if (result.url) {
        showLoginPanel(name, result.url, msg('Menunggu persetujuan...', 'Waiting for approval...'), false);
        pollLogin(name, 0, token);
      } else {
        showLoginPanel(name, null, result.error || msg('Gagal mendapatkan tautan login Qoder.', 'Could not get the Qoder login link.'), true);
      }
    })
    .catch(function (err) {
      if (token !== loginPollToken) return;
      showLoginPanel(name, null, msg('Gagal memulai login: ', 'Failed to start login: ') + err.message, true);
    });
}

function nextProfileName(label, existing) {
  var names = (existing || []).map(function (profile) {
    return profile.name;
  });
  var base =
    String(label || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 26) || 'akun';
  var candidate = base;
  if (!/^[a-z0-9_-]{1,32}$/.test(candidate) || names.indexOf(candidate) !== -1) {
    do {
      candidate = base.slice(0, 25) + '-' + Math.random().toString(36).slice(2, 7);
    } while (names.indexOf(candidate) !== -1);
  }
  return candidate;
}

function linkAccount() {
  var labelInput = document.getElementById('account-label');
  var label = labelInput ? labelInput.value.trim() : '';

  api('/accounts')
    .then(function (accounts) {
      var name = nextProfileName(label, accounts.profiles);
      return api('/accounts', {
        method: 'POST',
        body: JSON.stringify({ name: name, label: label || name }),
      }).then(function (created) {
        return { name: name, accounts: created };
      });
    })
    .then(function (result) {
      if (labelInput) labelInput.value = '';
      reloadAccounts();
      if (result.accounts.oauth) {
        startAccountLogin(result.name, true);
      } else {
        showLoginPanel(
          result.name,
          null,
          msg(
            'Backend CN memakai PAT; isi token di .env lalu restart proxy.',
            'The CN backend uses a PAT; set the token in .env and restart the proxy.'
          ),
          true
        );
      }
    })
    .catch(function (err) {
      alert(msg('Gagal menghubungkan akun: ', 'Failed to connect account: ') + err.message);
    });
}

function switchProfile(name) {
  api('/accounts/active', { method: 'POST', body: JSON.stringify({ name: name }) })
    .then(reloadAccounts)
    .catch(function (err) {
      alert(msg('Gagal mengganti profil: ', 'Failed to switch profile: ') + err.message);
    });
}

function removeAccount(name) {
  if (!window.confirm(
    msg(
      'Hapus profil "' + name + '"? File login tidak ikut dihapus.',
      'Remove profile "' + name + '"? Its login files are not deleted.'
    )
  )) return;
  api('/accounts?name=' + encodeURIComponent(name), { method: 'DELETE' })
    .then(function () {
      showLoginPanel(name, null, '');
      return reloadAccounts();
    })
    .catch(function (err) {
      alert(msg('Gagal menghapus profil: ', 'Failed to remove profile: ') + err.message);
    });
}

function resetUsage() {
  if (!confirm(
    msg(
      'Reset semua statistik penggunaan lokal? Tindakan ini tidak bisa dibatalkan.',
      'Reset all local usage statistics? This cannot be undone.'
    )
  )) return;

  api('/usage/reset-local', { method: 'POST' })
    .then(function () {
      document.getElementById('usage-content').dataset.loaded = '0';
      loadUsage();
    })
    .catch(function (err) {
      alert(msg('Gagal reset: ', 'Failed to reset: ') + err.message);
    });
}

// ─── Utilities ─────────────────────────────────────────────────────────────────

function escapeHtml(text) {
  if (!text) return '';
  var div = document.createElement('div');
  div.appendChild(document.createTextNode(text));
  return div.innerHTML;
}

// ─── Init ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', function () {
  initTheme();
  initLang();
  initSidebar();
  initTabs();
  initChat();
  initConfig();
  initApiKey();

  // Theme toggle
  var themeBtn = document.getElementById('theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', toggleTheme);
  }

  // Load initial tab
  loadDashboard();
});

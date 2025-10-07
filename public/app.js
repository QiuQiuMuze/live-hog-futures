const API = {
  register: '/api/register',
  login: '/api/login',
  logout: '/api/logout',
  summary: '/api/summary',
  history: '/api/history',
  ai: '/api/ai-insights'
};

const SESSION_KEY = 'futures-session';

const MARKETS = {
  HOG: { name: '生猪期货', unit: '元/吨', currency: 'CNY' },
  GOLD: { name: '黄金期货', unit: '元/克', currency: 'CNY' },
  MOUTAI: { name: '白酒主力（茅台）', unit: '元/手', currency: 'CNY' },
  CRUDE: { name: '原油期货', unit: '元/桶', currency: 'CNY' },
  SOY: { name: '豆粕期货', unit: '元/吨', currency: 'CNY' }
};

let token = null;
let username = null;
let aiTimer = null;

const authShell = document.getElementById('auth-shell');
const dashboard = document.getElementById('dashboard');
const tabs = document.querySelectorAll('.tab');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginMessage = document.getElementById('login-message');
const registerMessage = document.getElementById('register-message');
const logoutBtn = document.getElementById('logout-btn');
const userDisplay = document.getElementById('user-display');
const balanceEl = document.getElementById('account-balance');
const holdingsBody = document.getElementById('holdings-body');
const historyBody = document.getElementById('history-body');
const aiContent = document.getElementById('ai-content');
const aiNextEl = document.getElementById('ai-next');
const sessionAlert = document.getElementById('session-alert');
const sessionAlertText = document.getElementById('session-alert-text');
const sessionAlertClose = document.getElementById('session-alert-close');

function formatCurrency(value, currency = 'CNY') {
  return Number(value || 0).toLocaleString('zh-CN', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2
  });
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('zh-CN');
}

function setMessage(el, message, isError = false) {
  if (!el) return;
  el.textContent = message;
  el.style.color = isError ? '#ef4444' : '#94a3b8';
}

function toggleForms(targetId) {
  document.querySelectorAll('.form').forEach((form) => {
    form.classList.toggle('active', form.id === targetId);
  });
  tabs.forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.target === targetId);
  });
  setMessage(loginMessage, '');
  setMessage(registerMessage, '');
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => toggleForms(tab.dataset.target));
});

function saveSession(data) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(data));
}

function restoreSession() {
  const stored = sessionStorage.getItem(SESSION_KEY);
  if (!stored) return false;
  try {
    const parsed = JSON.parse(stored);
    if (parsed && parsed.token && parsed.username) {
      token = parsed.token;
      username = parsed.username;
      return true;
    }
  } catch (err) {
    console.warn('无法解析会话信息', err);
  }
  return false;
}

function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
  token = null;
  username = null;
}

function showAlert(message) {
  sessionAlertText.textContent = message;
  sessionAlert.classList.remove('hidden');
}

function hideAlert() {
  sessionAlert.classList.add('hidden');
  sessionAlertText.textContent = '';
}

sessionAlertClose.addEventListener('click', hideAlert);

async function request(url, options = {}) {
  const headers = options.headers ? { ...options.headers } : {};
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetch(url, { ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    handleUnauthorized(data.error || '登录状态已失效，请重新登录。');
    throw new Error(data.error || '未授权');
  }
  if (!response.ok) {
    throw new Error(data.error || '请求失败');
  }
  return data;
}

function handleUnauthorized(message) {
  clearSession();
  dashboard.classList.add('hidden');
  authShell.classList.remove('hidden');
  loginForm.reset();
  registerForm.reset();
  setMessage(loginMessage, message, true);
  showAlert(message);
  stopAiAutoRefresh();
  setAiNextText('下次预计生成：-');
}

registerForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const usernameValue = document.getElementById('register-username').value.trim();
  const password = document.getElementById('register-password').value.trim();
  try {
    await request(API.register, {
      method: 'POST',
      body: JSON.stringify({ username: usernameValue, password })
    });
    setMessage(registerMessage, '注册成功，请切换到登录。');
    toggleForms('login-form');
  } catch (error) {
    setMessage(registerMessage, error.message, true);
  }
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const usernameValue = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value.trim();
  try {
    const data = await request(API.login, {
      method: 'POST',
      body: JSON.stringify({ username: usernameValue, password })
    });
    token = data.token;
    username = usernameValue;
    saveSession({ token, username });
    await enterDashboard();
  } catch (error) {
    setMessage(loginMessage, error.message, true);
  }
});

logoutBtn.addEventListener('click', async () => {
  try {
    if (token) {
      await request(API.logout, { method: 'POST' });
    }
  } catch (err) {
    console.warn('退出登录失败', err);
  } finally {
    clearSession();
    dashboard.classList.add('hidden');
    authShell.classList.remove('hidden');
    hideAlert();
    loginForm.reset();
    registerForm.reset();
    setMessage(loginMessage, '');
    setMessage(registerMessage, '');
    stopAiAutoRefresh();
    setAiNextText('下次预计生成：-');
  }
});

async function enterDashboard() {
  stopAiAutoRefresh();
  authShell.classList.add('hidden');
  dashboard.classList.remove('hidden');
  userDisplay.textContent = username;
  hideAlert();
  setAiNextText('下次预计生成：计算中…');
  await Promise.all([refreshSummary(), refreshHistory()]);
  try {
    await fetchAiInsights();
  } catch (error) {
    console.warn('AI 洞察加载失败', error);
    aiContent.innerHTML = `<p class="placeholder">${error.message}</p>`;
    setAiNextText('下次预计生成：获取失败');
  }
}

async function refreshSummary() {
  const data = await request(API.summary, { method: 'GET' });
  balanceEl.textContent = formatCurrency(data.balance);
  renderHoldings(data.holdings || {});
}

function getMarketMeta(symbol) {
  return MARKETS[symbol] || { name: symbol, unit: '', currency: 'CNY' };
}

function renderHoldings(holdings) {
  holdingsBody.innerHTML = '';
  const entries = Object.entries(holdings);
  if (entries.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.className = 'placeholder';
    cell.textContent = '暂无持仓，前往下方品种页面开始交易。';
    row.appendChild(cell);
    holdingsBody.appendChild(row);
    return;
  }
  entries
    .sort(([a], [b]) => a.localeCompare(b))
    .forEach(([symbol, info]) => {
      const row = document.createElement('tr');
      const meta = getMarketMeta(symbol);
      const nameCell = document.createElement('td');
      nameCell.textContent = meta.name;
      const posCell = document.createElement('td');
      posCell.textContent = formatNumber(info.position);
      const avgCell = document.createElement('td');
      avgCell.textContent = info.position
        ? `${formatCurrency(info.averagePrice, meta.currency)}${meta.unit ? ` · ${meta.unit}` : ''}`
        : '-';
      row.append(nameCell, posCell, avgCell);
      holdingsBody.appendChild(row);
    });
}

async function refreshHistory() {
  const data = await request(API.history, { method: 'GET' });
  const records = (data.history || []).slice(0, 10);
  historyBody.innerHTML = '';
  if (records.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 6;
    cell.className = 'placeholder';
    cell.textContent = '暂无交易。';
    row.appendChild(cell);
    historyBody.appendChild(row);
    return;
  }
  records.forEach((entry) => {
    const row = document.createElement('tr');
    const timeCell = document.createElement('td');
    timeCell.textContent = new Date(entry.timestamp).toLocaleString('zh-CN');
    const symbolCell = document.createElement('td');
    const meta = getMarketMeta(entry.symbol);
    symbolCell.textContent = meta.name;
    const sideCell = document.createElement('td');
    sideCell.textContent = entry.type === 'buy' ? '买入' : '卖出';
    const qtyCell = document.createElement('td');
    qtyCell.textContent = formatNumber(entry.quantity);
    const priceCell = document.createElement('td');
    priceCell.textContent = formatCurrency(entry.price, meta.currency);
    const balanceCell = document.createElement('td');
    balanceCell.textContent = formatCurrency(entry.balanceAfter);
    row.append(timeCell, symbolCell, sideCell, qtyCell, priceCell, balanceCell);
    historyBody.appendChild(row);
  });
}

function formatAiTime(isoString) {
  if (!isoString) return '-';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('zh-CN', { hour12: false });
}

function renderAiInsights(insights = []) {
  aiContent.innerHTML = '';
  if (!insights.length) {
    aiContent.innerHTML = '<p class="placeholder">暂未生成新的 AI 观点。</p>';
    return;
  }
  insights.forEach((entry) => {
    const item = document.createElement('article');
    item.className = `ai-item ai-${entry.direction || 'neutral'}`;

    const header = document.createElement('div');
    header.className = 'ai-item-header';

    const badge = document.createElement('span');
    badge.className = `ai-direction ${entry.direction === 'down' ? 'ai-down' : 'ai-up'}`;
    badge.textContent = entry.direction === 'down' ? '看跌' : '看涨';

    const title = document.createElement('h3');
    title.textContent = entry.headline;

    header.append(badge, title);

    const time = document.createElement('p');
    time.className = 'ai-time';
    time.textContent = `发布时间：${formatAiTime(entry.issuedAt)}`;

    const impact = document.createElement('p');
    impact.className = 'ai-impact';
    impact.textContent = `走势影响：${entry.impact || '—'}`;

    const narrative = document.createElement('p');
    narrative.textContent = entry.narrative;

    const suggestion = document.createElement('p');
    suggestion.className = 'ai-suggestion';
    suggestion.textContent = entry.suggestion;

    item.append(header, time, impact, narrative, suggestion);
    aiContent.appendChild(item);
  });
}

function updateAiNext(nextRefreshAt) {
  if (!aiNextEl) return;
  if (!nextRefreshAt) {
    setAiNextText('下次预计生成：系统准备中');
    return;
  }
  setAiNextText(`下次预计生成：${formatAiTime(nextRefreshAt)}`);
}

function setAiNextText(text) {
  if (aiNextEl) {
    aiNextEl.textContent = text;
  }
}

function stopAiAutoRefresh() {
  if (aiTimer) {
    clearTimeout(aiTimer);
    aiTimer = null;
  }
}

function scheduleAiAutoRefresh(nextRefreshAt) {
  if (aiTimer) {
    clearTimeout(aiTimer);
    aiTimer = null;
  }
  if (!nextRefreshAt) return;
  const targetTime = Date.parse(nextRefreshAt);
  if (Number.isNaN(targetTime)) return;
  const delay = Math.max(targetTime - Date.now(), 60 * 1000);
  aiTimer = setTimeout(async () => {
    try {
      await fetchAiInsights();
    } catch (error) {
      console.warn('自动刷新 AI 洞察失败', error);
    }
  }, delay);
}

async function fetchAiInsights() {
  const markets = Object.keys(MARKETS);
  const target = markets[Math.floor(Math.random() * markets.length)] || 'HOG';
  const data = await request(`${API.ai}?symbol=${encodeURIComponent(target)}`, {
    method: 'GET'
  });
  renderAiInsights(data.insights || []);
  updateAiNext(data.nextRefreshAt);
  scheduleAiAutoRefresh(data.nextRefreshAt);
  return data;
}

window.addEventListener('DOMContentLoaded', async () => {
  if (restoreSession()) {
    try {
      await enterDashboard();
    } catch (err) {
      console.warn('自动登录失败', err);
      clearSession();
      authShell.classList.remove('hidden');
      dashboard.classList.add('hidden');
    }
  }
});

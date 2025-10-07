const API = {
  register: '/api/register',
  login: '/api/login',
  logout: '/api/logout',
  summary: '/api/summary',
  trade: '/api/trade',
  history: '/api/history',
  ai: '/api/ai-insights'
};

const SESSION_KEY = 'futures-session';


const AI_REFRESH_INTERVAL = 60000;


const body = document.body;
const {
  symbol: symbolRaw,
  name: marketName,
  unit: marketUnit,
  description: marketDescription,
  startPrice: startPriceRaw,
  minPrice: minPriceRaw,
  volatility: volatilityRaw
} = body.dataset;

const symbol = (symbolRaw || 'HOG').toUpperCase();
const basePrice = Number(startPriceRaw) || 100;
const minPrice = Number(minPriceRaw) || 10;
const volatility = Number(volatilityRaw) || 5;

let token = null;
let username = null;
let chart = null;
let priceSeries = [];
let timestamps = [];
let currentPrice = basePrice;
let previousPrice = basePrice;
let priceTimer = null;

let aiTimer = null;
let aiRefreshing = false;

let currentHolding = { position: 0, averagePrice: 0 };

const authShell = document.getElementById('auth-shell');
const marketApp = document.getElementById('market-app');
const tabs = document.querySelectorAll('.tab');
const loginForm = document.getElementById('login-form');
const registerForm = document.getElementById('register-form');
const loginMessage = document.getElementById('login-message');
const registerMessage = document.getElementById('register-message');
const logoutBtn = document.getElementById('logout-btn');
const userDisplay = document.getElementById('user-display');
const balanceEl = document.getElementById('account-balance');
const positionEl = document.getElementById('account-position');
const averageEl = document.getElementById('account-average');
const unrealizedEl = document.getElementById('unrealized-pnl');
const historyBody = document.getElementById('history-body');
const quantityInput = document.getElementById('trade-quantity');
const buyBtn = document.getElementById('buy-btn');
const sellBtn = document.getElementById('sell-btn');
const aiContent = document.getElementById('ai-content');
const refreshAiBtn = document.getElementById('refresh-ai');

const aiUpdatedAt = document.getElementById('ai-updated-at');

const currentPriceEl = document.getElementById('current-price');
const priceChangeEl = document.getElementById('price-change');
const marketTitle = document.getElementById('market-title');
const marketDescriptionEl = document.getElementById('market-description');
const sessionAlert = document.getElementById('session-alert');
const sessionAlertText = document.getElementById('session-alert-text');
const sessionAlertClose = document.getElementById('session-alert-close');
const kickoutBanner = document.getElementById('kickout-banner');

function setupCopy() {
  marketTitle.textContent = `${marketName || symbol} (${marketUnit || ''})`;
  marketDescriptionEl.textContent = marketDescription || '';
}

function formatCurrency(value) {
  return Number(value || 0).toLocaleString('zh-CN', {
    style: 'currency',
    currency: marketUnit && marketUnit.includes('美元') ? 'USD' : 'CNY',
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

tabs.forEach((tab) => tab.addEventListener('click', () => toggleForms(tab.dataset.target)));

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

function showKickout(message) {
  if (kickoutBanner) {
    kickoutBanner.textContent = message;
    kickoutBanner.classList.add('active');
  }
}

function hideKickout() {
  if (kickoutBanner) {
    kickoutBanner.classList.remove('active');
  }
}

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
  stopPriceStream();

  stopAiAutoRefresh();

  marketApp.classList.add('hidden');
  authShell.classList.remove('hidden');
  setMessage(loginMessage, message, true);
  showAlert(message);
  showKickout(message);
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
  } catch (err) {
    setMessage(registerMessage, err.message, true);
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
    await enterMarket();
  } catch (err) {
    setMessage(loginMessage, err.message, true);
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
    stopPriceStream();

    stopAiAutoRefresh();

    if (chart) {
      chart.destroy();
      chart = null;
    }
    authShell.classList.remove('hidden');
    marketApp.classList.add('hidden');
    loginForm.reset();
    registerForm.reset();
    setMessage(loginMessage, '');
    setMessage(registerMessage, '');
    hideAlert();
    hideKickout();
  }
});

buyBtn.addEventListener('click', () => submitTrade('buy'));
sellBtn.addEventListener('click', () => submitTrade('sell'));

async function submitTrade(type) {
  const quantity = Number(quantityInput.value || 0);
  if (!quantity || quantity <= 0) {
    showAlert('请输入正确的数量。');
    return;
  }
  try {
    const payload = {
      type,
      quantity,
      price: Number(currentPrice.toFixed(2)),
      symbol
    };
    await request(API.trade, {
      method: 'POST',
      body: JSON.stringify(payload)
    });
    await refreshSummary();
    await refreshHistory();
  } catch (err) {
    showAlert(err.message);
  }
}

async function enterMarket() {
  authShell.classList.add('hidden');
  marketApp.classList.remove('hidden');
  hideAlert();
  hideKickout();
  userDisplay.textContent = username;
  initializeChart();
  startPriceStream();

  if (aiUpdatedAt) {
    aiUpdatedAt.textContent = '上次更新：加载中...';
  }
  await Promise.all([refreshSummary(), refreshHistory(), fetchAiInsights()]);
  startAiAutoRefresh();

}

async function refreshSummary() {
  const data = await request(API.summary, { method: 'GET' });
  balanceEl.textContent = formatCurrency(data.balance);
  const holding = data.holdings?.[symbol] || { position: 0, averagePrice: 0 };
  currentHolding = {
    position: Number(holding.position) || 0,
    averagePrice: Number(holding.averagePrice) || 0
  };
  positionEl.textContent = formatNumber(currentHolding.position);
  averageEl.textContent = currentHolding.position ? formatCurrency(currentHolding.averagePrice) : '-';
  updateUnrealized();
}

async function refreshHistory() {
  const data = await request(`${API.history}?symbol=${encodeURIComponent(symbol)}`, { method: 'GET' });
  const records = data.history || [];
  historyBody.innerHTML = '';
  if (records.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'placeholder';
    cell.textContent = '暂无交易';
    row.appendChild(cell);
    historyBody.appendChild(row);
    return;
  }
  records.forEach((entry) => {
    const row = document.createElement('tr');
    const timeCell = document.createElement('td');
    timeCell.textContent = new Date(entry.timestamp).toLocaleString('zh-CN');
    const sideCell = document.createElement('td');
    sideCell.textContent = entry.type === 'buy' ? '买入' : '卖出';
    const qtyCell = document.createElement('td');
    qtyCell.textContent = formatNumber(entry.quantity);
    const priceCell = document.createElement('td');
    priceCell.textContent = formatCurrency(entry.price);
    const balanceCell = document.createElement('td');
    balanceCell.textContent = formatCurrency(entry.balanceAfter);
    row.append(timeCell, sideCell, qtyCell, priceCell, balanceCell);
    historyBody.appendChild(row);
  });
}

async function fetchAiInsights() {

  if (aiRefreshing) return;
  aiRefreshing = true;
  try {
    const data = await request(`${API.ai}?symbol=${encodeURIComponent(symbol)}`, { method: 'GET' });
    aiContent.innerHTML = '';
    const headline = document.createElement('h3');
    headline.textContent = data.headline;
    const narrative = document.createElement('p');
    narrative.textContent = data.narrative;
    const suggestion = document.createElement('p');
    suggestion.className = 'ai-suggestion';
    suggestion.textContent = data.suggestion;
    aiContent.append(headline, narrative, suggestion);
    if (aiUpdatedAt) {
      const timestamp = new Date().toLocaleString('zh-CN', { hour12: false });
      aiUpdatedAt.textContent = `上次更新：${timestamp}`;
    }
  } finally {
    aiRefreshing = false;
  }
}

if (refreshAiBtn) {
  refreshAiBtn.addEventListener('click', async () => {
    try {
      await fetchAiInsights();
      startAiAutoRefresh();
    } catch (err) {
      aiContent.innerHTML = `<p class="placeholder">${err.message}</p>`;
      if (aiUpdatedAt) {
        aiUpdatedAt.textContent = '上次更新：刷新失败';
      }
    }
  });
}

function initializeChart() {
  const ctx = document.getElementById('price-chart').getContext('2d');
  priceSeries = [];
  timestamps = [];
  if (chart) {
    chart.destroy();
  }
  chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: timestamps,
      datasets: [
        {
          label: `${marketName || symbol} 价格`,
          data: priceSeries,
          borderColor: '#0f172a',
          backgroundColor: 'rgba(15, 23, 42, 0.1)',
          borderWidth: 2,
          tension: 0.25,
          fill: true,
          pointRadius: 0
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          ticks: { color: 'rgba(15, 23, 42, 0.6)' },
          grid: { color: 'rgba(15, 23, 42, 0.05)' }
        },
        y: {
          ticks: { color: 'rgba(15, 23, 42, 0.6)' },
          grid: { color: 'rgba(15, 23, 42, 0.05)' }
        }
      },
      plugins: {
        legend: { display: false }
      }
    }
  });
}

function startPriceStream() {
  if (priceTimer) return;
  updatePrice();
  priceTimer = setInterval(updatePrice, 4000);
}

function stopPriceStream() {
  if (priceTimer) {
    clearInterval(priceTimer);
    priceTimer = null;
  }
}


function startAiAutoRefresh() {
  stopAiAutoRefresh();
  aiTimer = setInterval(async () => {
    try {
      await fetchAiInsights();
    } catch (err) {
      console.warn('自动刷新 AI 洞察失败', err);
      if (aiUpdatedAt) {
        aiUpdatedAt.textContent = '上次更新：自动刷新失败';
      }
    }
  }, AI_REFRESH_INTERVAL);
}

function stopAiAutoRefresh() {
  if (aiTimer) {
    clearInterval(aiTimer);
    aiTimer = null;
  }
  if (aiUpdatedAt) {
    aiUpdatedAt.textContent = '上次更新：-';
  }
}


function updatePrice() {
  previousPrice = currentPrice;
  const delta = (Math.random() - 0.5) * volatility * 2;
  currentPrice = Math.max(minPrice, currentPrice + delta);
  const changePercent = previousPrice === 0 ? 0 : ((currentPrice - previousPrice) / previousPrice) * 100;
  const now = new Date();
  const label = now.toLocaleTimeString('zh-CN', { hour12: false });
  timestamps.push(label);
  priceSeries.push(Number(currentPrice.toFixed(2)));
  if (timestamps.length > 50) {
    timestamps.shift();
    priceSeries.shift();
  }
  currentPriceEl.textContent = `${currentPrice.toFixed(2)} ${marketUnit || ''}`.trim();
  const changeText = `${changePercent >= 0 ? '+' : ''}${changePercent.toFixed(2)}%`;
  priceChangeEl.textContent = changeText;
  priceChangeEl.style.color = changePercent >= 0 ? '#16a34a' : '#dc2626';
  chart.update();
  updateUnrealized();
}

function updateUnrealized() {
  if (!unrealizedEl) return;
  if (!currentHolding.position) {
    unrealizedEl.textContent = '-';
    return;
  }
  const pnl = (currentPrice - currentHolding.averagePrice) * currentHolding.position;
  unrealizedEl.textContent = formatCurrency(pnl);
  unrealizedEl.style.color = pnl >= 0 ? '#16a34a' : '#dc2626';
}

window.addEventListener('DOMContentLoaded', async () => {
  setupCopy();
  if (restoreSession()) {
    try {
      await enterMarket();
    } catch (err) {
      console.warn('自动登录失败', err);
      clearSession();
      authShell.classList.remove('hidden');
      marketApp.classList.add('hidden');
    }
  } else {
    authShell.classList.remove('hidden');
  }
});

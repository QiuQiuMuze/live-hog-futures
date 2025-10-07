const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(USERS_FILE, JSON.stringify({}), 'utf-8');
}

const INITIAL_BALANCE = 1000000;
const AI_MIN_INTERVAL = 12 * 60 * 60 * 1000;
const AI_MAX_INTERVAL = 24 * 60 * 60 * 1000;
const sessions = new Map();
const userSessions = new Map();

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
}

function normalizeUsers(users) {
  let updated = false;
  for (const [username, user] of Object.entries(users)) {
    if (!user) continue;
    if (!user.holdings) {
      const holdings = {};
      if (typeof user.position === 'number' && user.position !== 0) {
        holdings.HOG = {
          position: user.position,
          averagePrice: Number(user.averagePrice || 0)
        };
      }
      user.holdings = holdings;
      delete user.position;
      delete user.averagePrice;
      updated = true;
    }
    if (!Array.isArray(user.history)) {
      user.history = [];
      updated = true;
    }
    if (!user.aiInsights) {
      user.aiInsights = {};
      updated = true;
    }
    let historyUpdated = false;
    user.history = user.history.map((entry) => {
      if (entry && !entry.symbol) {
        historyUpdated = true;
        return { ...entry, symbol: 'HOG' };
      }
      return entry;
    });
    if (historyUpdated) {
      updated = true;
    }
  }
  if (updated) {
    writeUsers(users);
  }
  return users;
}

function readUsers() {
  const raw = fs.readFileSync(USERS_FILE, 'utf-8');
  const users = JSON.parse(raw);
  return normalizeUsers(users);
}

function createSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  if (userSessions.has(username)) {
    const previousToken = userSessions.get(username);
    sessions.delete(previousToken);
  }
  userSessions.set(username, token);
  sessions.set(token, { username, createdAt: Date.now() });
  return token;
}

function clearSession(token) {
  if (!token) return;
  const session = sessions.get(token);
  if (!session) return;
  const { username } = session;
  if (userSessions.get(username) === token) {
    userSessions.delete(username);
  }
  sessions.delete(token);
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 1e6) {
        req.socket.destroy();
        reject(new Error('请求体过大'));
      }
    });
    req.on('end', () => {
      if (!data) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error('无效的 JSON 格式'));
      }
    });
    req.on('error', reject);
  });
}

function authenticate(req) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token && sessions.has(token)) {
    return sessions.get(token).username;
  }
  return null;
}

function serveStatic(req, res, pathname) {
  let filePath = pathname === '/' ? path.join(PUBLIC_DIR, 'index.html') : path.join(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendText(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendText(res, 404, 'Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const type =
      ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.js'
        ? 'application/javascript; charset=utf-8'
        : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(data);
  });
}

function handleRegister(req, res) {
  parseBody(req)
    .then(({ username, password }) => {
      if (!username || !password) {
        sendJson(res, 400, { error: '用户名和密码均为必填。' });
        return;
      }
      const users = readUsers();
      if (users[username]) {
        sendJson(res, 400, { error: '该用户名已存在，请选择其他用户名。' });
        return;
      }
      users[username] = {
        password,
        balance: INITIAL_BALANCE,
        holdings: {},
        history: [],
        aiInsights: {}
      };
      writeUsers(users);
      sendJson(res, 200, { message: '注册成功，请登录。' });
    })
    .catch((err) => {
      sendJson(res, 400, { error: err.message });
    });
}

function handleLogin(req, res) {
  parseBody(req)
    .then(({ username, password }) => {
      if (!username || !password) {
        sendJson(res, 400, { error: '用户名和密码均为必填。' });
        return;
      }
      const users = readUsers();
      const user = users[username];
      if (!user || user.password !== password) {
        sendJson(res, 401, { error: '用户名或密码错误。' });
        return;
      }
      const token = createSession(username);
      sendJson(res, 200, { message: '登录成功。', token });
    })
    .catch((err) => {
      sendJson(res, 400, { error: err.message });
    });
}

function handleLogout(req, res) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (token) {
    clearSession(token);
  }
  sendJson(res, 200, { message: '已退出登录。' });
}

function withAuth(req, res, handler) {
  const user = authenticate(req);
  if (!user) {
    sendJson(res, 401, { error: '登录状态已失效，请重新登录（可能因在其他页面登录）。' });
    return;
  }
  handler(user);
}

function handleSummary(req, res) {
  withAuth(req, res, (username) => {
    const users = readUsers();
    const user = users[username];
    if (!user) {
      sendJson(res, 404, { error: '用户不存在。' });
      return;
    }
    sendJson(res, 200, {
      balance: user.balance,
      holdings: user.holdings || {},
      history: user.history || []
    });
  });
}

function handleHistory(req, res, searchParams) {
  withAuth(req, res, (username) => {
    const users = readUsers();
    const user = users[username];
    if (!user) {
      sendJson(res, 404, { error: '用户不存在。' });
      return;
    }
    const symbol = (searchParams.get('symbol') || '').toUpperCase();
    const history =
      symbol && symbol.length
        ? (user.history || []).filter((entry) => entry.symbol === symbol)
        : user.history || [];
    sendJson(res, 200, { history });
  });
}

function ensureHoldingStructure(holding = {}) {
  return {
    position: Number(holding.position) || 0,
    averagePrice: Number(holding.averagePrice) || 0
  };
}

function handleTrade(req, res) {
  withAuth(req, res, (username) => {
    parseBody(req)
      .then(({ type, quantity, price, symbol }) => {
        const qty = Number(quantity);
        const tradePrice = Number(price);
        const trimmedSymbol = typeof symbol === 'string' ? symbol.trim().toUpperCase() : '';
        if (!['buy', 'sell'].includes(type)) {
          sendJson(res, 400, { error: '交易类型不合法。' });
          return;
        }
        if (!trimmedSymbol) {
          sendJson(res, 400, { error: '请选择交易合约。' });
          return;
        }
        if (!qty || qty <= 0 || !tradePrice || tradePrice <= 0) {
          sendJson(res, 400, { error: '数量和价格必须为正数。' });
          return;
        }

        const users = readUsers();
        const user = users[username];
        if (!user) {
          sendJson(res, 404, { error: '用户不存在。' });
          return;
        }

        user.holdings = user.holdings || {};
        const holding = ensureHoldingStructure(user.holdings[trimmedSymbol]);
        let realizedPnl = 0;
        if (type === 'buy') {
          const cost = tradePrice * qty;
          if (user.balance < cost) {
            sendJson(res, 400, { error: '余额不足，无法买入。' });
            return;
          }
          const newPosition = holding.position + qty;
          const newAvgPrice =
            newPosition === 0 ? 0 : (holding.averagePrice * holding.position + tradePrice * qty) / newPosition;
          user.balance -= cost;
          holding.position = newPosition;
          holding.averagePrice = Number(newAvgPrice.toFixed(2));
        } else {
          if (holding.position < qty) {
            sendJson(res, 400, { error: '持仓不足，无法卖出。' });
            return;
          }
          const revenue = tradePrice * qty;
          realizedPnl = (tradePrice - holding.averagePrice) * qty;
          user.balance += revenue;
          holding.position -= qty;
          if (holding.position === 0) {
            holding.averagePrice = 0;
          }
        }

        if (holding.position === 0) {
          delete user.holdings[trimmedSymbol];
        } else {
          user.holdings[trimmedSymbol] = holding;
        }

        const entry = {
          id: crypto.randomUUID(),
          timestamp: new Date().toISOString(),
          type,
          symbol: trimmedSymbol,
          quantity: qty,
          price: tradePrice,
          balanceAfter: user.balance,
          positionAfter: holding.position,
          realizedPnl: Number(realizedPnl.toFixed(2))
        };

        user.history = [entry, ...(user.history || [])];
        users[username] = user;
        writeUsers(users);
        sendJson(res, 200, { message: '交易成功。', entry });
      })
      .catch((err) => {
        sendJson(res, 400, { error: err.message });
      });
  });
}

const aiThemes = {
  HOG: {
    headline: '生猪期货AI快报',
    drivers: ['饲料成本变动', '供给调控政策', '疫病防控动态', '消费淡旺季切换', '冻品库存变化'],
    outcomes: [
      {
        direction: 'up',
        impact: '可能推动生猪期价震荡走高',
        advice: '可考虑逢低吸纳多单，并严格设置风险位。'
      },
      {
        direction: 'up',
        impact: '有望带动盘面延续升势',
        advice: '顺势加仓需注意节奏，建议分批布局。'
      },
      {
        direction: 'down',
        impact: '或令生猪期价承压回落',
        advice: '多单宜减仓观望，可适当考虑防御性空单。'
      },
      {
        direction: 'down',
        impact: '大概率触发短线回调',
        advice: '建议锁定利润，控制杠杆等待企稳信号。'
      }
    ]
  },
  GOLD: {
    headline: '黄金期货AI播报',
    drivers: ['美联储利率预期', '美元指数波动', '避险需求', '实物金流入', '全球通胀走势'],
    outcomes: [
      {
        direction: 'up',
        impact: '料将支撑金价震荡上行',
        advice: '可逢回调逐步建立多单，并关注美元走势。'
      },
      {
        direction: 'up',
        impact: '或触发突破性上涨',
        advice: '顺势做多同时控制仓位，警惕突发消息。'
      },
      {
        direction: 'down',
        impact: '恐加剧金价回落压力',
        advice: '建议减轻多头敞口，关注支撑位表现。'
      },
      {
        direction: 'down',
        impact: '可能引发避险情绪降温后的下行',
        advice: '可考虑短线试空，并设置紧密止损。'
      }
    ]
  },
  MOUTAI: {
    headline: '白酒主力AI简报',
    drivers: ['渠道动销反馈', '批价走势', '节假日备货', '消费信心指数', '原料成本'],
    outcomes: [
      {
        direction: 'up',
        impact: '有望推升白酒主力期价稳步走强',
        advice: '多单可持有并择机加仓，但需关注成交量。'
      },
      {
        direction: 'up',
        impact: '或令盘面重拾升势',
        advice: '建议逢低布局多单，同时设置浮盈保护。'
      },
      {
        direction: 'down',
        impact: '可能压制价格重心下移',
        advice: '多单需及时止盈，空单可轻仓尝试。'
      },
      {
        direction: 'down',
        impact: '大概率引发短线调整',
        advice: '建议观望或采取空头对冲策略。'
      }
    ]
  },
  CRUDE: {
    headline: '原油期货AI速递',
    drivers: ['OPEC+产量指引', '全球需求预期', '地缘政治风险', '美元走势', '库存数据'],
    outcomes: [
      {
        direction: 'up',
        impact: '或推升油价震荡走高',
        advice: '建议分批做多并关注库存数据变化。'
      },
      {
        direction: 'up',
        impact: '有望带来拉升行情',
        advice: '顺势持有多单，但应做好风险对冲。'
      },
      {
        direction: 'down',
        impact: '可能引发油价回落',
        advice: '多单需收紧止损，短线空单可尝试介入。'
      },
      {
        direction: 'down',
        impact: '大概率压制反弹力度',
        advice: '以反弹做空为主，谨慎追高。'
      }
    ]
  },
  SOY: {
    headline: '豆粕期货AI观察',
    drivers: ['南美产量预估', '国内压榨开机率', '饲料需求', '进口成本', '远期基差'],
    outcomes: [
      {
        direction: 'up',
        impact: '预计支撑豆粕价格震荡抬升',
        advice: '多单可逐步建立，但需留意原料供应。'
      },
      {
        direction: 'up',
        impact: '或推动盘面偏强运行',
        advice: '建议沿趋势做多，同时关注美元粮价联动。'
      },
      {
        direction: 'down',
        impact: '可能拖累价格下行',
        advice: '多单应减持，空单可轻仓跟进。'
      },
      {
        direction: 'down',
        impact: '大概率导致盘面承压震荡',
        advice: '以逢高沽空为主，控制仓位防反抽。'
      }
    ]
  }
};

function randomAiInterval(baseMillis) {
  const span = AI_MIN_INTERVAL + Math.random() * (AI_MAX_INTERVAL - AI_MIN_INTERVAL);
  return baseMillis + span;
}

function createAiInsight(symbol, pool, issuedAtMillis) {
  const driver = pool.drivers[Math.floor(Math.random() * pool.drivers.length)];
  const outcome = pool.outcomes[Math.floor(Math.random() * pool.outcomes.length)];
  const confidence = Math.floor(Math.random() * 41) + 55;
  const issuedAt = new Date(issuedAtMillis).toISOString();
  const issuedLabel = new Date(issuedAt).toLocaleString('zh-CN', { hour12: false });
  const directionLabel = outcome.direction === 'up' ? '看涨' : '看跌';
  const narrative = `${issuedLabel}，模型监测到${driver}，判断${outcome.impact}，置信度约为${confidence}%。`;
  return {
    id: crypto.randomUUID(),
    symbol,
    issuedAt,
    headline: `${pool.headline}｜${directionLabel}`,
    narrative,
    suggestion: outcome.advice,
    direction: outcome.direction,
    driver,
    impact: outcome.impact,
    confidence
  };
}

function ensureAiState(user, symbol, pool) {
  if (!user.aiInsights) {
    user.aiInsights = {};
  }
  if (!user.aiInsights[symbol]) {
    const initialInsight = createAiInsight(symbol, pool, Date.now());
    user.aiInsights[symbol] = {
      entries: [initialInsight],
      nextRefreshAt: new Date(randomAiInterval(Date.now())).toISOString()
    };
  }
  const state = user.aiInsights[symbol];
  if (!Array.isArray(state.entries)) {
    state.entries = [];
  }
  if (!state.entries.length) {
    const initialInsight = createAiInsight(symbol, pool, Date.now());
    state.entries = [initialInsight];
    state.nextRefreshAt = new Date(randomAiInterval(Date.now())).toISOString();
  }
  if (!state.nextRefreshAt) {
    const lastIssued = Date.parse(state.entries[0]?.issuedAt || Date.now());
    const base = Number.isNaN(lastIssued) ? Date.now() : lastIssued;
    state.nextRefreshAt = new Date(randomAiInterval(base)).toISOString();
  }
  return state;
}

function rollAiState(state, pool, symbol) {
  const now = Date.now();
  let nextMillis = Date.parse(state.nextRefreshAt || '');
  if (Number.isNaN(nextMillis)) {
    const lastIssued = Date.parse(state.entries[0]?.issuedAt || Date.now());
    const base = Number.isNaN(lastIssued) ? Date.now() : lastIssued;
    nextMillis = randomAiInterval(base);
  }
  let iterations = 0;
  while (nextMillis <= now && iterations < 10) {
    const insight = createAiInsight(symbol, pool, nextMillis);
    state.entries.unshift(insight);
    state.entries = state.entries.slice(0, 3);
    nextMillis = randomAiInterval(nextMillis);
    iterations += 1;
  }
  state.nextRefreshAt = new Date(nextMillis).toISOString();
  return state;
}

function handleAiInsights(req, res, searchParams) {
  withAuth(req, res, (username) => {
    const users = readUsers();
    const user = users[username];
    if (!user) {
      sendJson(res, 404, { error: '用户不存在。' });
      return;
    }
    if (!user.aiInsights) {
      user.aiInsights = {};
    }
    const symbol = (searchParams.get('symbol') || 'HOG').toUpperCase();
    const pool = aiThemes[symbol] || aiThemes.HOG;
    const state = ensureAiState(user, symbol, pool);
    rollAiState(state, pool, symbol);
    users[username] = user;
    writeUsers(users);
    sendJson(res, 200, {
      symbol,
      insights: state.entries,
      nextRefreshAt: state.nextRefreshAt
    });
  });
}

const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  if (pathname.startsWith('/api/')) {
    if (req.method === 'POST' && pathname === '/api/register') {
      handleRegister(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/login') {
      handleLogin(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/logout') {
      handleLogout(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/summary') {
      handleSummary(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/history') {
      handleHistory(req, res, parsedUrl.searchParams);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/trade') {
      handleTrade(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/api/ai-insights') {
      handleAiInsights(req, res, parsedUrl.searchParams);
      return;
    }
    sendJson(res, 404, { error: '接口不存在。' });
    return;
  }

  if (req.method === 'GET') {
    serveStatic(req, res, pathname);
    return;
  }

  sendText(res, 405, 'Method Not Allowed');
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

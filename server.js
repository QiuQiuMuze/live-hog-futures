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
        history: []
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
    tones: ['看涨', '震荡偏强', '震荡整理', '快速回调', '筑底反弹']
  },
  GOLD: {
    headline: '黄金期货AI播报',
    drivers: ['美联储利率预期', '美元指数波动', '避险需求', '实物金流入', '全球通胀走势'],
    tones: ['稳步走高', '高位震荡', '回调蓄势', '突破上行', '承压回落']
  },
  MOUTAI: {
    headline: '白酒主力AI简报',
    drivers: ['渠道动销反馈', '批价走势', '节假日备货', '消费信心指数', '原料成本'],
    tones: ['震荡盘整', '缓步上扬', '冲高回落', '底部企稳', '震荡偏弱']
  },
  CRUDE: {
    headline: '原油期货AI速递',
    drivers: ['OPEC+产量指引', '全球需求预期', '地缘政治风险', '美元走势', '库存数据'],
    tones: ['震荡上行', '区间整理', '冲高回落', '快速反弹', '缓慢回升']
  },
  SOY: {
    headline: '豆粕期货AI观察',
    drivers: ['南美产量预估', '国内压榨开机率', '饲料需求', '进口成本', '远期基差'],
    tones: ['偏强震荡', '承压下探', '整理筑底', '宽幅震荡', '震荡上行']
  }
};

function handleAiInsights(req, res, searchParams) {
  withAuth(req, res, () => {
    const symbol = (searchParams.get('symbol') || '').toUpperCase();
    const pool = aiThemes[symbol] || aiThemes.HOG;
    const driver = pool.drivers[Math.floor(Math.random() * pool.drivers.length)];
    const tone = pool.tones[Math.floor(Math.random() * pool.tones.length)];
    const confidence = Math.floor(Math.random() * 41) + 55;
    const headline = `${pool.headline}：${tone}`;
    const narrative = `AI研判：${driver}使得当前行情呈现${tone}态势，模型信心约为${confidence}%。请结合自身策略审慎操作。`;
    const suggestion = tone.includes('涨') || tone.includes('上行') || tone.includes('走高')
      ? '趋势偏多，建议控制节奏分批建仓。'
      : tone.includes('回落') || tone.includes('承压') || tone.includes('下探')
      ? '风险加剧，可适当减仓或考虑对冲保护。'
      : '行情区间震荡，建议轻仓观望并关注关键位置突破情况。';
    sendJson(res, 200, { headline, narrative, suggestion, symbol: symbol || 'HOG' });
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

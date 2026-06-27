import fs from 'node:fs/promises';

const TIME_ZONE = 'Asia/Taipei';
const TRACKED_DEFAULT = ['0050', '0056', '006208', '00919', '2886', '00878', '00713'];

async function main() {
  const portfolioPath = new URL('./portfolio.json', import.meta.url);
  const config = JSON.parse(await fs.readFile(portfolioPath, 'utf8'));
  const today = new Date();

  if (isWeekend(today) && process.env.FORCE_SEND !== 'true') {
    console.log('Weekend in Asia/Taipei; skipped.');
    return;
  }

  const codes = unique([
    ...config.holdings.map((item) => item.code),
    ...config.watchlist.map((item) => item.code),
    ...TRACKED_DEFAULT,
  ]);

  const market = await fetchLatestMarket(codes);
  const kd = await fetchTaiexKd(config.kdThreshold || 25);
  const holdings = enrichHoldings(config.holdings, market);
  const plan = computePlan(holdings, config);
  const tradePlan = buildTradePlan(plan, holdings, config.watchlist, market, kd, config);
  const report = buildReport({ config, holdings, plan, market, kd, tradePlan });

  console.log(report.subject);
  console.log(report.body);

  if (!process.env.RESEND_API_KEY) {
    throw new Error('Missing RESEND_API_KEY secret.');
  }

  const from = process.env.ETF_EMAIL_FROM || 'ETF Daily <onboarding@resend.dev>';
  const to = process.env.ETF_EMAIL_TO || config.recipient;
  await sendWithResend({ from, to, subject: report.subject, text: report.body });
  console.log(`Sent ETF report to ${to}.`);
}

async function fetchLatestMarket(codes) {
  let lastError;
  for (let back = 0; back < 14; back += 1) {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - back);
    const ymd = formatDate(d, 'yyyyMMdd');
    const url = `https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd}&type=ALLBUT0999&response=json`;

    try {
      const json = await fetchJson(url);
      const parsed = parseMiIndex(json, codes);
      if (Object.keys(parsed.stocks).length > 0 || parsed.taiex.close) {
        return { date: ymd, sourceUrl: url, ...parsed };
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Cannot fetch recent TWSE market data: ${lastError?.message || lastError}`);
}

async function fetchTaiexKd(threshold) {
  const byDate = new Map();
  let latestSourceUrl = '';

  for (let backMonth = 0; backMonth < 6; backMonth += 1) {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() - backMonth);
    const ymd = formatDate(d, 'yyyyMM') + '01';
    const url = `https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${ymd}&response=json`;

    try {
      const json = await fetchJson(url);
      for (const point of parseTaiexHistory(json)) {
        byDate.set(point.key, point);
      }
      latestSourceUrl ||= url;
    } catch {
      // Continue; TWSE sometimes returns empty data for holidays or endpoint maintenance.
    }
  }

  const points = [...byDate.values()]
    .sort((a, b) => a.key.localeCompare(b.key))
    .filter((point) => point.high > 0 && point.low > 0 && point.close > 0);

  if (points.length < 30) {
    return {
      available: false,
      triggered: false,
      status: `KD 資料不足，目前只取得 ${points.length} 筆`,
      sourceUrl: latestSourceUrl,
    };
  }

  let k = 50;
  let d = 50;
  for (let i = 0; i < points.length; i += 1) {
    const window = points.slice(Math.max(0, i - 8), i + 1);
    const high = Math.max(...window.map((point) => point.high));
    const low = Math.min(...window.map((point) => point.low));
    const rsv = high === low ? 50 : ((points[i].close - low) / (high - low)) * 100;
    k = k * (2 / 3) + rsv * (1 / 3);
    d = d * (2 / 3) + k * (1 / 3);
  }

  const latest = points.at(-1);
  return {
    available: true,
    date: latest.key,
    close: latest.close,
    k,
    d,
    triggered: k < threshold || d < threshold,
    strongLow: k < threshold && d < threshold,
    status: k < threshold || d < threshold ? '低檔買入提醒' : '未觸發低檔買入',
    sourceUrl: latestSourceUrl,
  };
}

function parseMiIndex(json, codes) {
  const wanted = new Set(codes.map(normalizeCode));
  const result = { stocks: {}, taiex: {} };

  for (const table of json.tables || []) {
    const fields = table.fields || [];
    const data = table.data || [];
    const codeIndex = fields.indexOf('證券代號');
    const closeIndex = fields.indexOf('收盤價');

    if (codeIndex >= 0 && closeIndex >= 0) {
      for (const row of data) {
        const code = normalizeCode(row[codeIndex]);
        if (!wanted.has(code)) continue;

        const close = parseNumber(row[closeIndex]);
        const change = signedChange(row, fields);
        const previousClose = close && Number.isFinite(change) ? close - change : 0;
        result.stocks[code] = {
          code,
          name: row[fields.indexOf('證券名稱')] || '',
          open: parseNumberByField(row, fields, '開盤價'),
          high: parseNumberByField(row, fields, '最高價'),
          low: parseNumberByField(row, fields, '最低價'),
          close,
          change,
          changePct: previousClose ? change / previousClose : 0,
          volume: parseNumberByField(row, fields, '成交股數'),
        };
      }
    }

    for (const row of data) {
      if (!row.join(' ').includes('發行量加權股價指數')) continue;
      const nums = row.map(parseNumber).filter((n) => Number.isFinite(n));
      const close = nums.find((n) => n > 1000) || 0;
      const change = nums.find((n) => Math.abs(n) > 0 && Math.abs(n) < 1000 && n !== close) || 0;
      const pctCandidate = nums.find((n) => Math.abs(n) < 20 && n !== change && n !== close);
      result.taiex = {
        close,
        change,
        changePct: pctCandidate ? pctCandidate / 100 : 0,
      };
    }
  }

  return result;
}

function parseTaiexHistory(json) {
  const fields = json.fields || json.tables?.[0]?.fields || [];
  const data = json.data || json.tables?.[0]?.data || [];
  const dateIndex = fields.indexOf('日期');
  const openIndex = fields.indexOf('開盤指數');
  const highIndex = fields.indexOf('最高指數');
  const lowIndex = fields.indexOf('最低指數');
  const closeIndex = fields.indexOf('收盤指數');

  return data.map((row) => ({
    key: normalizeTwseDate(row[dateIndex]),
    open: parseNumber(row[openIndex]),
    high: parseNumber(row[highIndex]),
    low: parseNumber(row[lowIndex]),
    close: parseNumber(row[closeIndex]),
  })).filter((row) => row.key);
}

function enrichHoldings(holdings, market) {
  return holdings.map((holding) => {
    const quote = market.stocks[holding.code] || {};
    const latestPrice = quote.close || holding.fallbackPrice || 0;
    const marketValue = holding.shares * latestPrice;
    const cost = holding.shares * holding.avgCost;
    return {
      ...holding,
      latestPrice,
      change: quote.change || 0,
      changePct: quote.changePct || 0,
      volume: quote.volume || 0,
      marketValue,
      cost,
      unrealizedPnl: marketValue - cost,
      annualDividend: marketValue * holding.yieldRate,
    };
  });
}

function computePlan(holdings, config) {
  const totalMarketValue = sum(holdings.map((item) => item.marketValue));
  const totalCost = sum(holdings.map((item) => item.cost));
  const annualDividend = sum(holdings.map((item) => item.annualDividend));
  const coreValue = sum(holdings.filter((item) => item.kind.includes('核心')).map((item) => item.marketValue));
  const dividendValue = sum(holdings.filter((item) => item.kind.includes('配息')).map((item) => item.marketValue));
  const stockValue = sum(holdings.filter((item) => item.kind.includes('金融股') || item.kind.includes('個股')).map((item) => item.marketValue));

  return {
    totalMarketValue,
    totalCost,
    unrealizedPnl: totalMarketValue - totalCost,
    unrealizedPnlPct: totalCost ? (totalMarketValue - totalCost) / totalCost : 0,
    annualDividend,
    annualDividendGap: Math.max(config.annualDividendTarget - annualDividend, 0),
    assetsWithCash: totalMarketValue + config.investableCash,
    coreWeight: totalMarketValue ? coreValue / totalMarketValue : 0,
    dividendWeight: totalMarketValue ? dividendValue / totalMarketValue : 0,
    stockWeight: totalMarketValue ? stockValue / totalMarketValue : 0,
  };
}

function buildTradePlan(plan, holdings, watchlist, market, kd, config) {
  const usableCash = Math.max(config.investableCash - config.targetReserve, 0);
  let trialAmount = 0;
  if (config.extraBuyLimit > 0) {
    trialAmount = Math.min(config.monthlyDca + config.extraBuyLimit, usableCash);
  } else if (config.monthlyDca > 0) {
    trialAmount = Math.min(config.monthlyDca, usableCash);
  } else {
    trialAmount = Math.min(usableCash * 0.1, usableCash);
  }

  if (!kd.available || !kd.triggered || trialAmount <= 0) {
    return { trialAmount, candidates: [] };
  }

  const holdingByCode = Object.fromEntries(holdings.map((item) => [item.code, item]));
  const candidates = watchlist
    .filter((item) => item.active)
    .map((item) => {
      const holding = holdingByCode[item.code] || {};
      const quote = market.stocks[item.code] || {};
      const price = quote.close || holding.latestPrice || 0;
      const weight = plan.totalMarketValue && holding.marketValue ? holding.marketValue / plan.totalMarketValue : 0;
      let score = 0;
      if (item.kind.includes('配息ETF')) score += 40;
      if (item.code === '0056') score += 15;
      if (item.code === '00919') score += 8;
      if (item.code === '00878' || item.code === '00713') score += 7;
      if (weight > config.maxSingleWeight) score -= 100;
      if (plan.coreWeight > 0.6 && item.kind.includes('核心')) score -= 20;
      if (item.kind.includes('金融股') || item.kind.includes('個股')) score -= 25;
      return { ...item, price, weight, score };
    })
    .filter((item) => item.price > 0 && item.score > -50)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, Math.min(3, config.candidateCount || 2)));

  const totalScore = sum(candidates.map((item) => Math.max(item.score, 1))) || 1;
  return {
    trialAmount,
    candidates: candidates.map((item) => {
      const amount = trialAmount * (Math.max(item.score, 1) / totalScore);
      return {
        ...item,
        amount,
        oddLotShares: Math.floor(amount / item.price),
        boardLots: Math.floor(amount / (item.price * 1000)),
      };
    }),
  };
}

function buildReport(ctx) {
  const todayText = formatDate(new Date(), 'yyyy-MM-dd');
  const subject = `台股 ETF 股票分析師日報 - ${todayText}`;
  const lines = [];

  if (ctx.kd.available && ctx.kd.triggered) {
    lines.push('第一重點：KD 低於 25 買入提醒');
    lines.push(`今日觸發低檔買入規則。加權指數 K=${formatNumber(ctx.kd.k, 1)}，D=${formatNumber(ctx.kd.d, 1)}，狀態：${ctx.kd.strongLow ? '強低檔區' : '低檔區'}。`);
    if (ctx.tradePlan.candidates.length) {
      lines.push(`本次可動用試算金額：${formatMoney(ctx.tradePlan.trialAmount)}。優先試算如下：`);
      for (const item of ctx.tradePlan.candidates) {
        lines.push(`- ${item.code} ${item.name}：試算 ${formatMoney(item.amount)}，參考價 ${formatNumber(item.price, 2)}，可買零股 ${item.oddLotShares} 股，${item.boardLots > 0 ? `可買整張 ${item.boardLots} 張` : '整張不足，零股試算'}。`);
      }
      lines.push('選擇理由：你的策略偏長期定期定額與配息現金流，目前核心市值型部位占比較高，因此低檔時優先用配息型 ETF 做小額分批試算。');
    }
  } else {
    lines.push('第一重點：今日未觸發 KD<25 買入規則');
    if (ctx.kd.available) {
      lines.push(`加權指數 K=${formatNumber(ctx.kd.k, 1)}，D=${formatNumber(ctx.kd.d, 1)}，尚未低於 ${ctx.config.kdThreshold || 25}。今日維持定期定額紀律，不主動追價。`);
    } else {
      lines.push(`${ctx.kd.status}。今天不啟動低檔買入試算，避免在資料不完整時做操作判斷。`);
    }
  }

  lines.push('');
  lines.push('1. 今日市場趨勢');
  lines.push(`資料日期：${ctx.market.date}。加權指數收盤 ${formatNumber(ctx.market.taiex.close, 2)}，漲跌 ${formatNumber(ctx.market.taiex.change, 2)}，漲跌幅 ${formatPercent(ctx.market.taiex.changePct)}。`);

  lines.push('');
  lines.push('2. 加權指數 KD 低檔提醒');
  if (ctx.kd.available) {
    lines.push(`KD 日期：${ctx.kd.date}。K=${formatNumber(ctx.kd.k, 1)}，D=${formatNumber(ctx.kd.d, 1)}，狀態：${ctx.kd.status}。`);
  } else {
    lines.push(ctx.kd.status);
  }

  lines.push('');
  lines.push('3. 我的資金計畫狀態');
  lines.push(`目前總市值約 ${formatMoney(ctx.plan.totalMarketValue)}，未實現損益 ${formatMoney(ctx.plan.unrealizedPnl)}（${formatPercent(ctx.plan.unrealizedPnlPct)}）。`);
  lines.push(`可投入現金 ${formatMoney(ctx.config.investableCash)}，每月定期定額 ${formatMoney(ctx.config.monthlyDca)}，預估年配息 ${formatMoney(ctx.plan.annualDividend)}，距離年度配息目標仍差約 ${formatMoney(ctx.plan.annualDividendGap)}。`);
  lines.push(`配置概況：核心市值型 ${formatPercent(ctx.plan.coreWeight)}，配息型 ${formatPercent(ctx.plan.dividendWeight)}，金融個股 ${formatPercent(ctx.plan.stockWeight)}。`);

  lines.push('');
  lines.push('4. 持有清單觀察');
  for (const item of ctx.holdings) {
    const weight = ctx.plan.totalMarketValue ? item.marketValue / ctx.plan.totalMarketValue : 0;
    lines.push(`- ${item.code} ${item.name}（${item.kind}）：參考價 ${formatNumber(item.latestPrice, 2)}，日漲跌 ${formatPercent(item.changePct)}，部位占比 ${formatPercent(weight)}，估計殖利率 ${formatPercent(item.yieldRate)}，未實現損益 ${formatMoney(item.unrealizedPnl)}。${item.note}`);
  }

  lines.push('');
  lines.push('5. 今日操作提醒');
  lines.push(`實際下單前請以 ${ctx.config.brokerApp} 的即時價格、委託狀態與自身風險承受度為準。`);

  lines.push('');
  lines.push('6. 風險與免責提醒');
  lines.push('本日報為自動化理財紀律提醒與資料整理，不是保證獲利或個別投資建議。資料可能延遲、估算或受來源調整影響，投資前請自行確認。');

  lines.push('');
  lines.push('資料來源：');
  lines.push(`- TWSE 每日收盤行情：${ctx.market.sourceUrl}`);
  if (ctx.kd.sourceUrl) lines.push(`- TWSE 加權指數歷史資料：${ctx.kd.sourceUrl}`);

  return { subject, body: lines.join('\n') };
}

async function sendWithResend({ from, to, subject, text }) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: HTTP ${res.status} ${await res.text()}`);
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ETF Daily Bot/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${url}`);
  return res.json();
}

function parseNumberByField(row, fields, fieldName) {
  const index = fields.indexOf(fieldName);
  return index >= 0 ? parseNumber(row[index]) : 0;
}

function signedChange(row, fields) {
  const diff = parseNumberByField(row, fields, '漲跌價差');
  const signIndex = fields.indexOf('漲跌(+/-)');
  const signText = signIndex >= 0 ? String(row[signIndex] || '') : '';
  return signText.includes('-') || signText.includes('−') ? -Math.abs(diff) : diff;
}

function parseNumber(value) {
  if (typeof value === 'number') return value;
  const text = String(value || '')
    .replace(/<[^>]*>/g, '')
    .replace(/,/g, '')
    .replace(/%/g, '')
    .replace(/--/g, '')
    .replace(/－/g, '-')
    .replace(/−/g, '-')
    .trim();
  if (!text) return 0;
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
}

function normalizeTwseDate(value) {
  const parts = String(value || '').trim().split('/');
  if (parts.length !== 3) return String(value || '').trim();
  let year = Number(parts[0]);
  if (year < 1911) year += 1911;
  return `${String(year).padStart(4, '0')}-${String(Number(parts[1])).padStart(2, '0')}-${String(Number(parts[2])).padStart(2, '0')}`;
}

function normalizeCode(value) {
  return String(value || '').trim().replace(/\.TW$/i, '');
}

function unique(values) {
  return [...new Set(values.map(normalizeCode).filter(Boolean))];
}

function sum(values) {
  return values.reduce((acc, value) => acc + (Number.isFinite(value) ? value : 0), 0);
}

function isWeekend(date) {
  const day = Number(new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' })
    .format(date)
    .replace('Sun', '0')
    .replace('Mon', '1')
    .replace('Tue', '2')
    .replace('Wed', '3')
    .replace('Thu', '4')
    .replace('Fri', '5')
    .replace('Sat', '6'));
  return day === 0 || day === 6;
}

function formatDate(date, pattern) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (pattern === 'yyyyMMdd') return `${map.year}${map.month}${map.day}`;
  if (pattern === 'yyyyMM') return `${map.year}${map.month}`;
  return `${map.year}-${map.month}-${map.day}`;
}

function formatMoney(value) {
  return `NT$${Math.round(value).toLocaleString('zh-TW')}`;
}

function formatNumber(value, digits) {
  return Number(value || 0).toLocaleString('zh-TW', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(2)}%`;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

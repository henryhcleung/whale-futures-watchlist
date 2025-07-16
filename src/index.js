require('dotenv').config();
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const config = require('./config');
const PositionManager = require('./PositionManager');
const { getOpenInterest, getFundingRate } = require('./binanceApi');
const redisClient = require('./redisClient');

const oiHistory = {}; // { symbol: [ { timestamp, value } ] }
const fundingRateHistory = {}; // { symbol: [ { timestamp, value } ] }
const trendLookbackMs = 15 * 60 * 1000; // 15 minutes
const telegramAlertHistory = {}; // { symbol: [ timestamps ] }
const TELEGRAM_ALERT_LIMIT = 3;
const TELEGRAM_ALERT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const {
  symbols,
  largeTradeThresholds,
  tradeWindowsMs,
  rsiPeriods,
  rsiOverbought,
  rsiOversold,
  signalPersistenceMs,
  signalCooldownMs,
  volatilityLookback,
  telegram,
  netVolumeThresholds,
} = config;

const serverPort = process.env.PORT || config.serverPort || 3000;
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));

const tradesMap = new Map();
symbols.forEach(s => tradesMap.set(s.toUpperCase(), []));

const signalState = {};
const positionManager = new PositionManager();

const TRADES_KEY = 'tradesMap';
const SIGNAL_STATE_KEY = 'signalState';

// Indicator functions (implementations below)
const {
  calculateRSI,
  calculateMACD,
  calculateBollingerBands,
  calculateATR,
  calculateVolatilityProxy,
} = require('./indicators');

// Load persisted data from Redis on startup
(async () => {
  try {
    const tradesData = await redisClient.get(TRADES_KEY);
    if (tradesData) {
      const tradesObj = JSON.parse(tradesData);
      for (const symbol in tradesObj) {
        tradesMap.set(symbol, tradesObj[symbol]);
      }
      console.info('Loaded tradesMap from Redis');
    }
    const signalData = await redisClient.get(SIGNAL_STATE_KEY);
    if (signalData) {
      Object.assign(signalState, JSON.parse(signalData));
      console.info('Loaded signalState from Redis');
    }
  } catch (err) {
    console.error('Error loading from Redis:', err);
  }
})();

// Persist tradesMap and signalState to Redis every 30 seconds
setInterval(async () => {
  try {
    const tradesObj = {};
    for (const [symbol, trades] of tradesMap.entries()) {
      tradesObj[symbol] = trades;
    }
    await redisClient.set(TRADES_KEY, JSON.stringify(tradesObj));
    await redisClient.set(SIGNAL_STATE_KEY, JSON.stringify(signalState));
    console.info('Persisted tradesMap and signalState to Redis');
  } catch (err) {
    console.error('Error persisting to Redis:', err);
  }
}, 30000);

let cachedNews = [];

async function updateNewsCache() {
  try {
    cachedNews = await fetchAllNews();
    io.emit('news', cachedNews);
    console.info(`News cache updated with ${cachedNews.length} items`);
  } catch (err) {
    console.error('Error updating news cache:', err);
  }
}
updateNewsCache();
setInterval(updateNewsCache, 5 * 60 * 1000);

// Telegram messaging helpers
async function sendTelegramMessage(text) {
  if (!telegram.enabled) return;
  try {
    await axios.post(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
      chat_id: telegram.chatId,
      text,
      parse_mode: 'Markdown',
    });
    console.info('Telegram message sent');
  } catch (err) {
    console.error('Telegram send error:', err.response?.data || err.message);
  }
}

async function canSendTelegramAlert(symbol) {
  const now = Date.now();
  telegramAlertHistory[symbol] = telegramAlertHistory[symbol] || [];
  telegramAlertHistory[symbol] = telegramAlertHistory[symbol].filter(ts => now - ts < TELEGRAM_ALERT_WINDOW_MS);
  if (telegramAlertHistory[symbol].length >= TELEGRAM_ALERT_LIMIT) {
    return false;
  }
  telegramAlertHistory[symbol].push(now);
  return true;
}

// Trade data management
function cleanOldTrades() {
  const now = Date.now();
  const maxWindow = Math.max(...Object.values(tradeWindowsMs));
  for (const [symbol, trades] of tradesMap.entries()) {
    tradesMap.set(symbol, trades.filter(t => now - t.timestamp <= maxWindow));
  }
}

function aggregateTrades(symbol, windowMs) {
  const now = Date.now();
  const trades = tradesMap.get(symbol) || [];
  return trades.filter(t => now - t.timestamp <= windowMs);
}

function classifyOrder(quantity, symbol) {
  const largeThreshold = largeTradeThresholds[symbol] || 100;
  if (quantity >= largeThreshold * 5) return 'INSTITUTION';
  if (quantity >= largeThreshold) return 'WHALE';
  return 'RETAIL';
}

async function enrichSummaryWithOIandFunding(summary) {
  for (const s of summary) {
    try {
      const [oi, fr] = await Promise.all([
        getOpenInterest(s.symbol),
        getFundingRate(s.symbol),
      ]);
      s.openInterest = oi;
      s.fundingRate = fr;

      const now = Date.now();

      oiHistory[s.symbol] = oiHistory[s.symbol] || [];
      fundingRateHistory[s.symbol] = fundingRateHistory[s.symbol] || [];

      oiHistory[s.symbol].push({ timestamp: now, value: oi });
      fundingRateHistory[s.symbol].push({ timestamp: now, value: fr });

      oiHistory[s.symbol] = oiHistory[s.symbol].filter(e => now - e.timestamp <= trendLookbackMs);
      fundingRateHistory[s.symbol] = fundingRateHistory[s.symbol].filter(e => now - e.timestamp <= trendLookbackMs);

      const oiValues = oiHistory[s.symbol];
      const frValues = fundingRateHistory[s.symbol];

      s.openInterestTrend = oiValues.length > 1 ? oiValues[oiValues.length - 1].value - oiValues[0].value : 0;
      s.fundingRateTrend = frValues.length > 1 ? frValues[frValues.length - 1].value - frValues[0].value : 0;

    } catch (err) {
      console.error(`Error fetching OI/Funding for ${s.symbol}:`, err);
      s.openInterest = null;
      s.fundingRate = null;
      s.openInterestTrend = 0;
      s.fundingRateTrend = 0;
    }
  }
}

function aggregateData() {
  const summary = [];
  for (const symbol of symbols.map(s => s.toUpperCase())) {
    const tradesMain = aggregateTrades(symbol, tradeWindowsMs.main);
    if (tradesMain.length === 0) continue;

    const pricesMain = tradesMain.map(t => t.price);
    const buyVolumeMain = tradesMain.filter(t => t.side === 'BUY').reduce((a, t) => a + t.quantity, 0);
    const sellVolumeMain = tradesMain.filter(t => t.side === 'SELL').reduce((a, t) => a + t.quantity, 0);
    const netVolumeMain = buyVolumeMain - sellVolumeMain;
    const lastPrice = pricesMain[pricesMain.length - 1];

    const pricesShort = aggregateTrades(symbol, tradeWindowsMs.short).map(t => t.price);
    const pricesLong = aggregateTrades(symbol, tradeWindowsMs.long).map(t => t.price);
    const pricesExtended = aggregateTrades(symbol, tradeWindowsMs.extended).map(t => t.price);
    const pricesUltraLong = aggregateTrades(symbol, tradeWindowsMs.ultraLong).map(t => t.price);

    const rsiShort = calculateRSI(pricesShort, rsiPeriods.short);
    const rsiMain = calculateRSI(pricesMain, rsiPeriods.main);
    const rsiLong = calculateRSI(pricesLong, rsiPeriods.long);
    const rsiExtended = calculateRSI(pricesExtended, rsiPeriods.extended);
    const rsiUltraLong = calculateRSI(pricesUltraLong, rsiPeriods.ultraLong);

    const macdResult = calculateMACD(pricesMain, symbol);
    const macd = macdResult ? macdResult.macd : null;
    const signal = macdResult ? macdResult.signal : null;

    const bb = calculateBollingerBands(pricesMain);
    const atr = calculateATR(pricesMain);

    const volatilityProxy = calculateVolatilityProxy(pricesMain, volatilityLookback);

    summary.push({
      symbol,
      lastPrice: +lastPrice.toFixed(4),
      buyVolume: +buyVolumeMain.toFixed(2),
      sellVolume: +sellVolumeMain.toFixed(2),
      netVolume: +netVolumeMain.toFixed(2),
      rsiShort,
      rsiMain,
      rsiLong,
      rsiExtended,
      rsiUltraLong,
      macd,
      signal,
      bb,
      atr,
      volatilityProxy,
    });
  }
  return summary;
}

function generateSignal(summary) {
  const now = Date.now();

  summary.forEach(s => {
    const {
      symbol, netVolume, rsiMain, rsiShort, rsiLong,
      macd, signal, bb, fundingRate, fundingRateTrend,
      lastPrice, openInterest, openInterestTrend,
      volatilityProxy,
    } = s;

    let scoreLong = 0;
    let scoreShort = 0;

    // RSI scoring
    if (rsiMain !== null) {
      if (rsiMain < rsiOversold) scoreLong += 1;
      else if (rsiMain > rsiOverbought) scoreShort += 1;
    }
    if (rsiShort !== null) {
      if (rsiShort < rsiOversold) scoreLong += 0.5;
      else if (rsiShort > rsiOverbought) scoreShort += 0.5;
    }
    if (rsiLong !== null) {
      if (rsiLong < rsiOversold) scoreLong += 0.5;
      else if (rsiLong > rsiOverbought) scoreShort += 0.5;
    }

    // MACD scoring
    if (macd !== null && signal !== null) {
      if (macd > signal) scoreLong += 1;
      else if (macd < signal) scoreShort += 1;
    }

    // Bollinger Bands scoring
    if (bb) {
      if (lastPrice < bb.lower) scoreLong += 1;
      else if (lastPrice > bb.upper) scoreShort += 1;
    }

    // Net volume scoring
    if (netVolume !== null) {
      if (netVolume > (netVolumeThresholds[symbol] || 0)) scoreLong += 0.5;
      else if (netVolume < -(netVolumeThresholds[symbol] || 0)) scoreShort += 0.5;
    }

    // Funding rate scoring
    if (fundingRate !== null) {
      if (fundingRate > 0) scoreLong += 0.3;
      else if (fundingRate < 0) scoreShort += 0.3;
    }

    // Open interest trend scoring
    if (openInterestTrend !== null) {
      if (openInterestTrend > 0) scoreLong += 0.3;
      else if (openInterestTrend < 0) scoreShort += 0.3;
    }

    // Volatility proxy scoring (small boost)
    if (volatilityProxy !== null && volatilityProxy > 0) {
      scoreLong += 0.2;
      scoreShort += 0.2;
    }

    // Determine signal and confidence
    let newSignal = 'NEUTRAL';
    let confidence = 0;

    if (scoreLong > scoreShort && scoreLong >= 2) {
      newSignal = 'LONG';
      confidence = Math.min(scoreLong / 5, 1);
    } else if (scoreShort > scoreLong && scoreShort >= 2) {
      newSignal = 'SHORT';
      confidence = Math.min(scoreShort / 5, 1);
    }

    if (!signalState[symbol]) {
      signalState[symbol] = {
        currentSignal: 'NEUTRAL',
        lastChangeTimestamp: now,
        confirmedSignal: 'NEUTRAL',
        lastConfirmedTimestamp: 0,
        signalStartTimestamp: 0,
        lastConfidence: 0,
        lastTelegramSignal: null,
      };
    }

    const state = signalState[symbol];

    if (newSignal !== state.currentSignal) {
      state.currentSignal = newSignal;
      state.lastChangeTimestamp = now;
      state.lastConfidence = confidence;
    } else {
      state.lastConfidence = confidence;
    }

    const persistenceTime = now - state.lastChangeTimestamp;
    const cooldownTime = now - state.lastConfirmedTimestamp;

    if (
      newSignal !== state.confirmedSignal &&
      newSignal !== 'NEUTRAL' &&
      persistenceTime >= signalPersistenceMs &&
      cooldownTime >= signalCooldownMs
    ) {
      state.confirmedSignal = newSignal;
      state.lastConfirmedTimestamp = now;
      state.signalStartTimestamp = now;
      state.lastConfidence = confidence;
    }

    if (state.confirmedSignal === 'NEUTRAL') {
      state.signalStartTimestamp = 0;
      state.lastConfidence = 0;
    } else if (state.signalStartTimestamp === 0) {
      state.signalStartTimestamp = now;
    }
  });

  const signals = {};
  const signalDurations = {};
  const signalConfidences = {};
  for (const symbol of symbols.map(s => s.toUpperCase())) {
    const state = signalState[symbol];
    signals[symbol] = state.confirmedSignal;
    signalDurations[symbol] = state.signalStartTimestamp ? Math.floor((Date.now() - state.signalStartTimestamp) / 1000) : 0;
    signalConfidences[symbol] = state.lastConfidence;
  }

  return { signals, signalDurations, signalConfidences };
}

function updateSignalWithWhaleTrades(symbol) {
  const trades = tradesMap.get(symbol) || [];
  const now = Date.now();
  const recentWhaleTrades = trades.filter(t => t.classification === 'WHALE' && now - t.timestamp < 5 * 60 * 1000);
  const whaleBuyVol = recentWhaleTrades.filter(t => t.side === 'BUY').reduce((a, t) => a + t.quantity, 0);
  const whaleSellVol = recentWhaleTrades.filter(t => t.side === 'SELL').reduce((a, t) => a + t.quantity, 0);

  if (!signalState[symbol]) return;

  const state = signalState[symbol];

  if (whaleBuyVol > (largeTradeThresholds[symbol] || 0)) {
    if (state.currentSignal === 'LONG') {
      state.lastConfidence = Math.min(state.lastConfidence + 0.2, 1);
    } else {
      state.currentSignal = 'LONG';
      state.lastChangeTimestamp = now;
      state.lastConfidence = 0.5;
    }
  } else if (whaleSellVol > (largeTradeThresholds[symbol] || 0)) {
    if (state.currentSignal === 'SHORT') {
      state.lastConfidence = Math.min(state.lastConfidence + 0.2, 1);
    } else {
      state.currentSignal = 'SHORT';
      state.lastChangeTimestamp = now;
      state.lastConfidence = 0.5;
    }
  }
}

// Binance WebSocket connection
const wsUrl = `wss://fstream.binance.com/stream?streams=${symbols.map(s => s.toLowerCase() + '@aggTrade').join('/')}`;
let ws;

function connectWebSocket() {
  ws = new WebSocket(wsUrl);

  ws.on('open', () => {
    console.info('WebSocket connected');
  });

  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data);

      if (!message || !message.data || !message.stream) return;

      if (message.stream.endsWith('@aggTrade')) {
        const trade = message.data;
        const symbol = trade.s.toUpperCase();
        const price = parseFloat(trade.p);
        const quantity = parseFloat(trade.q);
        const side = trade.m ? 'SELL' : 'BUY';
        const classification = classifyOrder(quantity, symbol);

        if (tradesMap.has(symbol)) {
          tradesMap.get(symbol).push({
            price,
            quantity,
            side,
            timestamp: trade.T,
            classification,
          });
        }

        if (quantity >= (largeTradeThresholds[symbol] || 100)) {
          io.emit('largeTrade', {
            symbol,
            side,
            price,
            quantity,
            classification,
            time: new Date(trade.T).toLocaleTimeString(),
          });
        }
      }
    } catch (err) {
      console.error('Error parsing WebSocket message:', err, 'Raw message:', data);
    }
  });

  ws.on('close', () => {
    console.warn('WebSocket closed, reconnecting in 5s...');
    setTimeout(connectWebSocket, 5000);
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err);
    ws.close();
  });
}

connectWebSocket();

// News fetching (CryptoCompare + NewsAPI.org)
async function fetchCryptoCompareNews() {
  try {
    const res = await axios.get('https://min-api.cryptocompare.com/data/v2/news/', { params: { lang: 'EN' } });
    if (!res.data || !res.data.Data) return [];
    return res.data.Data.slice(0, 20).map(item => ({
      source: 'CryptoCompare',
      symbol: 'UNKNOWN',
      title: item.title,
      url: item.url,
      sentiment: 'neutral',
      time: new Date(item.published_on * 1000).toISOString(),
      body: item.body || '',
    }));
  } catch (e) {
    console.error('CryptoCompare news error:', e.message);
    return [];
  }
}

async function fetchNewsAPIOrg() {
  try {
    const apiKey = process.env.NEWSAPI_API_KEY;
    if (!apiKey) return [];
    const res = await axios.get('https://newsapi.org/v2/everything', {
      params: {
        q: 'cryptocurrency OR bitcoin OR ethereum',
        language: 'en',
        sortBy: 'publishedAt',
        apiKey,
        pageSize: 20,
      },
    });
    if (!res.data || !res.data.articles) return [];
    return res.data.articles.map(item => ({
      source: 'NewsAPI',
      symbol: 'UNKNOWN',
      title: item.title,
      url: item.url,
      sentiment: 'neutral',
      time: item.publishedAt,
      body: item.description || '',
    }));
  } catch (e) {
    console.error('NewsAPI.org error:', e.message);
    return [];
  }
}

async function fetchAllNews() {
  const [ccNews, newsApiNews] = await Promise.all([fetchCryptoCompareNews(), fetchNewsAPIOrg()]);
  const allNews = [...ccNews, ...newsApiNews];
  const seen = new Set();
  return allNews.filter(n => {
    if (seen.has(n.url)) return false;
    seen.add(n.url);
    return true;
  });
}

// Main loop emitting summary, news, and telegram notifications
setInterval(async () => {
  try {
    cleanOldTrades();
    const summary = aggregateData();
    await enrichSummaryWithOIandFunding(summary);

    const { signals, signalDurations, signalConfidences } = generateSignal(summary);

    symbols.forEach(symbol => updateSignalWithWhaleTrades(symbol.toUpperCase()));

    io.emit('summary', { summary, signals, signalDurations, signalConfidences });
    io.emit('news', cachedNews);

    if (telegram.enabled) {
      for (const symbol of Object.keys(signals)) {
        const currentSignal = signals[symbol];
        const confidence = signalConfidences[symbol];
        const state = signalState[symbol];
        if (!state) continue;

        if (state.lastTelegramSignal !== currentSignal) {
          if (currentSignal !== 'NEUTRAL' && await canSendTelegramAlert(symbol)) {
            state.lastTelegramSignal = currentSignal;
            const data = summary.find(s => s.symbol === symbol);
            const lastPrice = data ? data.lastPrice.toFixed(4) : 'N/A';
            const netVol = data ? data.netVolume.toFixed(2) : 'N/A';
            const rsi = data ? data.rsiMain.toFixed(2) : 'N/A';
            const macd = data ? data.macd.toFixed(4) : 'N/A';
            const duration = signalDurations[symbol] || 0;

            const msg = `🚨 *${symbol}* signal changed to *${currentSignal}* (Confidence: ${(confidence * 100).toFixed(0)}%)\n` +
                        `Price: $${lastPrice}\n` +
                        `Net Volume: ${netVol}\n` +
                        `RSI: ${rsi}\n` +
                        `MACD: ${macd}\n` +
                        `Duration: ${formatDuration(duration)}\n` +
                        `Suggested Action: ${currentSignal === 'LONG' ? 'Consider LONG position' : 'Consider SHORT position'}\n` +
                        `Check your watchlist for details.`;

            await sendTelegramMessage(msg);
          }
        }
      }
    }
  } catch (err) {
    console.error('Error in main loop:', err);
  }
}, 3000);

function formatDuration(seconds) {
  if (seconds < 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

io.on('connection', (socket) => {
  console.info('Client connected');
  socket.on('disconnect', () => {
    console.info('Client disconnected');
  });
});

server.listen(serverPort, async () => {
  console.info(`Server running at http://localhost:${serverPort}`);
  await sendTelegramMessage('🚀 Binance Whale Futures Watchlist monitoring started.');
});

async function shutdown() {
  console.info('Shutting down server...');
  await sendTelegramMessage('🛑 Binance Whale Futures Watchlist monitoring stopped.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
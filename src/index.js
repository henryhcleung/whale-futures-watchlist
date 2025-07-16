require('dotenv').config();
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const config = require('./config');
const PositionManager = require('./PositionManager');
const { getOpenInterest, getFundingRate } = require('./binanceApi');

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
  emaShortPeriod,
  emaLongPeriod,
  macdSignalPeriod,
  bbPeriod,
  bbStdDev,
  netVolumeThresholds,
  rsiOverbought,
  rsiOversold,
  signalPersistenceMs,
  signalCooldownMs,
  volatilityLookback,
  telegram,
} = config;

const serverPort = process.env.PORT || config.serverPort || 3000;
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

app.use(express.static('public'));

const tradesMap = new Map();
symbols.forEach(s => tradesMap.set(s.toUpperCase(), []));

const emaCache = {};
const macdCache = {};
const signalState = {};

const positionManager = new PositionManager();

const redisClient = require('./redisClient');

const TRADES_KEY = 'tradesMap';
const SIGNAL_STATE_KEY = 'signalState';

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

// Periodically persist tradesMap and signalState to Redis every 30 seconds
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

// Call once on server start
updateNewsCache();

// Refresh news cache every 5 minutes
setInterval(updateNewsCache, 5 * 60 * 1000);

/**
 * Send Telegram message with error handling
 */
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


// Indicator calculations (EMA, MACD, RSI, BB, ATR)

function calculateEMA(prices, period, prevEMA = null) {
  const k = 2 / (period + 1);
  if (prevEMA === null) {
    if (prices.length < period) return null;
    const sum = prices.slice(-period).reduce((a, b) => a + b, 0);
    return sum / period;
  }
  const price = prices[prices.length - 1];
  return price * k + prevEMA * (1 - k);
}

function calculateMACD(prices, symbol) {
  if (prices.length < emaLongPeriod) return null;

  if (!emaCache[symbol]) emaCache[symbol] = { short: null, long: null };
  if (!macdCache[symbol]) macdCache[symbol] = { macdValues: [], signal: null };

  const emaShort = calculateEMA(prices, emaShortPeriod, emaCache[symbol].short);
  const emaLong = calculateEMA(prices, emaLongPeriod, emaCache[symbol].long);

  if (emaShort === null || emaLong === null) return null;

  emaCache[symbol].short = emaShort;
  emaCache[symbol].long = emaLong;

  const macd = emaShort - emaLong;

  macdCache[symbol].macdValues.push(macd);
  if (macdCache[symbol].macdValues.length > macdSignalPeriod) {
    macdCache[symbol].macdValues.shift();
  }

  const signal = calculateEMA(macdCache[symbol].macdValues, macdSignalPeriod, macdCache[symbol].signal);
  macdCache[symbol].signal = signal;

  if (signal === null) return null;

  return { macd, signal };
}

function calculateRSI(prices, period) {
  if (prices.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return +(100 - 100 / (1 + rs)).toFixed(2);
}

function calculateBollingerBands(prices, period = bbPeriod, stdDevMultiplier = bbStdDev) {
  if (prices.length < period) return null;
  const slice = prices.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    upper: mean + stdDevMultiplier * stdDev,
    middle: mean,
    lower: mean - stdDevMultiplier * stdDev,
  };
}

function calculateATR(prices, period = volatilityLookback) {
  if (prices.length < period + 1) return null;
  let trSum = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const high = prices[i];
    const low = prices[i]; // Simplified proxy
    const prevClose = prices[i - 1];
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
    trSum += tr;
  }
  return trSum / period;
}

// Calculate rolling standard deviation of prices as volatility proxy
function calculateVolatilityProxy(prices, lookback) {
  if (prices.length < lookback) return null;
  const slice = prices.slice(-lookback);
  const mean = slice.reduce((a, b) => a + b, 0) / lookback;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / lookback;
  return Math.sqrt(variance);
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


/**
 * Aggregate trade data and calculate indicators including volatility proxy
 */
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

    // Calculate volatility proxy (rolling std dev)
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

      // Store history
      oiHistory[s.symbol] = oiHistory[s.symbol] || [];
      fundingRateHistory[s.symbol] = fundingRateHistory[s.symbol] || [];

      oiHistory[s.symbol].push({ timestamp: now, value: oi });
      fundingRateHistory[s.symbol].push({ timestamp: now, value: fr });

      // Remove old entries
      oiHistory[s.symbol] = oiHistory[s.symbol].filter(e => now - e.timestamp <= trendLookbackMs);
      fundingRateHistory[s.symbol] = fundingRateHistory[s.symbol].filter(e => now - e.timestamp <= trendLookbackMs);

      // Calculate simple trend (delta over lookback)
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

// Signal generation with persistence and cooldown
function generateSignal(summary) {
  const now = Date.now();

  summary.forEach(s => {
    const {
      symbol, netVolume, rsiMain, rsiShort, rsiLong,
      macd, signal, bb, fundingRate, fundingRateTrend,
      lastPrice, openInterest, openInterestTrend,
      volatilityProxy,
    } = s;

    let newSignal = 'NEUTRAL';
    let confidence = 0;

    if (
      rsiMain !== null && macd !== null && signal !== null &&
      bb !== null && fundingRate !== null && openInterest !== null && volatilityProxy !== null
    ) {
      const macdBullish = macd > signal;
      const macdBearish = macd < signal;

      const rsiOversoldZone = rsiMain < rsiOversold;
      const rsiOverboughtZone = rsiMain > rsiOverbought;

      const netVolLong = netVolume > netVolumeThresholds[symbol];
      const netVolStrongLong = netVolume > netVolumeThresholds[symbol] * 2;
      const netVolShort = netVolume < -netVolumeThresholds[symbol];
      const netVolStrongShort = netVolume < -netVolumeThresholds[symbol] * 2;

      const fundingLong = fundingRate > 0.001 || fundingRateTrend > 0;
      const fundingShort = fundingRate < -0.001 || fundingRateTrend < 0;

      const oiRising = openInterestTrend > 0;
      const oiFalling = openInterestTrend < 0;

      const priceBelowLowerBB = lastPrice < bb.lower;
      const priceAboveUpperBB = lastPrice > bb.upper;

      // LONG conditions
      if (
        rsiOversoldZone &&
        macdBullish &&
        (priceBelowLowerBB || netVolStrongLong) &&
        fundingLong &&
        netVolLong &&
        oiRising
      ) {
        newSignal = 'LONG';
        confidence = 0.3;
        if (rsiLong < rsiOversold) confidence += 0.15;
        if (netVolStrongLong) confidence += 0.25;
        if (oiRising) confidence += 0.15;
        if (volatilityProxy > 0) confidence += 0.15;
      }
      // SHORT conditions
      else if (
        rsiOverboughtZone &&
        macdBearish &&
        (priceAboveUpperBB || netVolStrongShort) &&
        fundingShort &&
        netVolShort &&
        oiFalling
      ) {
        newSignal = 'SHORT';
        confidence = 0.3;
        if (rsiLong > rsiOverbought) confidence += 0.15;
        if (netVolStrongShort) confidence += 0.25;
        if (oiFalling) confidence += 0.15;
        if (volatilityProxy > 0) confidence += 0.15;
      }

      // Penalize conflicting signals
      if (newSignal === 'LONG' && rsiOverboughtZone) confidence *= 0.7;
      if (newSignal === 'SHORT' && rsiOversoldZone) confidence *= 0.7;
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
    }

    const persistenceTime = now - state.lastChangeTimestamp;
    const cooldownTime = now - state.lastConfirmedTimestamp;

    // Confirm signal if persisted and cooldown passed
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

  if (whaleBuyVol > largeTradeThresholds[symbol]) {
    if (state.currentSignal === 'LONG') {
      state.lastConfidence = Math.min(state.lastConfidence + 0.2, 1);
    } else {
      state.currentSignal = 'LONG';
      state.lastChangeTimestamp = now;
      state.lastConfidence = 0.5;
      // Optional: immediate confirmation bypassing persistence
      // state.confirmedSignal = 'LONG';
      // state.lastConfirmedTimestamp = now;
      // state.signalStartTimestamp = now;
    }
  } else if (whaleSellVol > largeTradeThresholds[symbol]) {
    if (state.currentSignal === 'SHORT') {
      state.lastConfidence = Math.min(state.lastConfidence + 0.2, 1);
    } else {
      state.currentSignal = 'SHORT';
      state.lastChangeTimestamp = now;
      state.lastConfidence = 0.5;
      // Optional immediate confirmation as above
    }
  }
}

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

// Main loop emitting summary, news, and telegram notifications

setInterval(async () => {
  try {
    cleanOldTrades();
    const summary = aggregateData();
    await enrichSummaryWithOIandFunding(summary);

    const { signals, signalDurations, signalConfidences } = generateSignal(summary);

    symbols.forEach(symbol => updateSignalWithWhaleTrades(symbol.toUpperCase()));

    io.emit('summary', { summary, signals, signalDurations, signalConfidences });

    // Emit cached news to clients
    io.emit('news', cachedNews);

    // Telegram alerts (your existing code)
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
const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const axios = require('axios');
const config = require('./config');
const PositionManager = require('./PositionManager');
const { getOpenInterest, getFundingRate } = require('./binanceApi');

const {
  symbols,
  largeTradeThresholds,
  serverPort,
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

async function sendTelegramMessage(text) {
  if (!telegram.enabled) return;
  try {
    await axios.post(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
      chat_id: telegram.chatId,
      text,
      parse_mode: 'Markdown',
    });
    console.log('Telegram message sent:', text);
  } catch (err) {
    console.error('Telegram send error:', err.response?.data || err.message);
  }
}

// Indicator calculations (EMA, MACD, RSI, BB, ATR) - as you provided, unchanged

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

// Trade data management

function cleanOldTrades() {
  const now = Date.now();
  for (const [symbol, trades] of tradesMap.entries()) {
    tradesMap.set(symbol, trades.filter(t => now - t.timestamp <= tradeWindowsMs.long));
  }
}

function aggregateTrades(symbol, windowMs) {
  const now = Date.now();
  const trades = tradesMap.get(symbol) || [];
  return trades.filter(t => now - t.timestamp <= windowMs);
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

    const rsiShort = calculateRSI(pricesShort, rsiPeriods.short);
    const rsiMain = calculateRSI(pricesMain, rsiPeriods.main);
    const rsiLong = calculateRSI(pricesLong, rsiPeriods.long);

    const macdResult = calculateMACD(pricesMain, symbol);
    const macd = macdResult ? macdResult.macd : null;
    const signal = macdResult ? macdResult.signal : null;

    const bb = calculateBollingerBands(pricesMain);
    const atr = calculateATR(pricesMain);

    summary.push({
      symbol,
      lastPrice: +lastPrice.toFixed(4),
      buyVolume: +buyVolumeMain.toFixed(2),
      sellVolume: +sellVolumeMain.toFixed(2),
      netVolume: +netVolumeMain.toFixed(2),
      rsiShort,
      rsiMain,
      rsiLong,
      macd,
      signal,
      bb,
      atr,
    });
  }
  return summary;
}

async function enrichSummaryWithOIandFunding(summary) {
  await Promise.all(summary.map(async (item) => {
    try {
      item.openInterest = await getOpenInterest(item.symbol);
      item.fundingRate = await getFundingRate(item.symbol);
    } catch (e) {
      item.openInterest = null;
      item.fundingRate = null;
    }
  }));
}

// Signal generation with persistence and cooldown

function generateSignal(summary) {
  const now = Date.now();
  const signals = {};
  const signalDurations = {};
  const signalConfidences = {};

  summary.forEach(s => {
    const { symbol, netVolume, rsiShort, rsiMain, rsiLong, macd, signal, bb, fundingRate, lastPrice, atr } = s;
    let newSignal = 'NEUTRAL';
    let confidence = 0;

    if (
      rsiMain !== null && macd !== null && signal !== null &&
      bb !== null && fundingRate !== null && atr !== null
    ) {
      // LONG signal conditions
      if (
        rsiMain < rsiOversold &&
        rsiShort <= rsiMain &&
        macd > signal &&
        lastPrice < bb.lower &&
        netVolume > netVolumeThresholds[symbol] &&
        fundingRate < 0.01
      ) {
        newSignal = 'LONG';
        confidence = 0.3;
        if (rsiLong < rsiOversold) confidence += 0.2;
        if (macd > 0) confidence += 0.2;
        if (netVolume > netVolumeThresholds[symbol] * 2) confidence += 0.3;
      }
      // SHORT signal conditions
      else if (
        rsiMain > rsiOverbought &&
        rsiShort >= rsiMain &&
        macd < signal &&
        lastPrice > bb.upper &&
        netVolume < -netVolumeThresholds[symbol] &&
        fundingRate > -0.01
      ) {
        newSignal = 'SHORT';
        confidence = 0.3;
        if (rsiLong > rsiOverbought) confidence += 0.2;
        if (macd < 0) confidence += 0.2;
        if (netVolume < -netVolumeThresholds[symbol] * 2) confidence += 0.3;
      }
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

    signals[symbol] = state.confirmedSignal;
    signalDurations[symbol] = state.signalStartTimestamp ? Math.floor((now - state.signalStartTimestamp) / 1000) : 0;
    signalConfidences[symbol] = state.lastConfidence;
  });

  return { signals, signalDurations, signalConfidences };
}

// News fetching (CryptoCompare + NewsAPI.org) - unchanged from your code

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

// Binance WebSocket for aggregated trades

const wsUrl = `wss://fstream.binance.com/stream?streams=${symbols.map(s => s.toLowerCase() + '@aggTrade').join('/')}`;
let ws = new WebSocket(wsUrl);

ws.on('open', () => {
  console.log('WebSocket connected');
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

      if (tradesMap.has(symbol)) {
        tradesMap.get(symbol).push({
          price,
          quantity,
          side,
          timestamp: trade.T,
        });
      }

      if (quantity >= largeTradeThresholds[symbol]) {
        io.emit('largeTrade', {
          symbol,
          side,
          price,
          quantity,
          time: new Date(trade.T).toLocaleTimeString(),
        });
      }
    }
  } catch (e) {
    console.error('WS message parse error:', e);
  }
});

ws.on('close', () => {
  console.log('WebSocket closed, reconnecting in 5s...');
  setTimeout(() => {
    ws = new WebSocket(wsUrl);
  }, 5000);
});

ws.on('error', (err) => {
  console.error('WebSocket error:', err);
  ws.close();
});

// Main loop

setInterval(async () => {
  try {
    cleanOldTrades();
    const summary = aggregateData();
    await enrichSummaryWithOIandFunding(summary);
    const { signals, signalDurations, signalConfidences } = generateSignal(summary);

    io.emit('summary', { summary, signals, signalDurations, signalConfidences });

    if (!global.lastNewsFetch || Date.now() - global.lastNewsFetch > 30000) {
      global.lastNewsFetch = Date.now();
      const news = await fetchAllNews();
      io.emit('news', news);
    }

    // Telegram notifications on signal changes
    if (telegram.enabled) {
      for (const symbol of Object.keys(signals)) {
        const currentSignal = signals[symbol];
        const confidence = signalConfidences[symbol];
        if (!signalState[symbol]) continue;
        if (signalState[symbol].lastTelegramSignal !== currentSignal) {
          signalState[symbol].lastTelegramSignal = currentSignal;
          if (currentSignal !== 'NEUTRAL') {
            const msg = `*${symbol}* signal changed to *${currentSignal}* (Confidence: ${(confidence * 100).toFixed(0)}%).\nCheck your watchlist for details.`;
            try {
              await axios.post(`https://api.telegram.org/bot${telegram.botToken}/sendMessage`, {
                chat_id: telegram.chatId,
                text: msg,
                parse_mode: 'Markdown',
              });
            } catch (err) {
              console.error('Telegram send error:', err.message);
            }
          }
        }
      }
    }
  } catch (err) {
    console.error('Error in main loop:', err);
  }
}, 1000);

// Socket.IO connection

io.on('connection', (socket) => {
  console.log('Client connected');
  socket.on('disconnect', () => {
    console.log('Client disconnected');
  });
});

// Start server

server.listen(serverPort, async () => {
  console.log(`Server running at http://localhost:${serverPort}`);
  await sendTelegramMessage('🚀 Binance Whale Futures Watchlist monitoring started.');
});

// Graceful shutdown

async function shutdown() {
  console.log('Shutting down server...');
  await sendTelegramMessage('🛑 Binance Whale Futures Watchlist monitoring stopped.');
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
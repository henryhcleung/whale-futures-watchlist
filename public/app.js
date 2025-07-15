const socket = io();
const PositionManager = require('./PositionManager'); // Client-side import (assumes bundling)

const summaryBody = document.getElementById('summaryBody');
const largeTradesDiv = document.getElementById('largeTrades');
const insightsDiv = document.getElementById('insights');

const MAX_LARGE_TRADES = 50;

const config = {
  netVolumeThreshold: 50, // Fallback, overridden by server
  rsiOverbought: 70,
  rsiOversold: 30,
};

const largeTrades = [];
const positionManager = new PositionManager(); // Initialize with default portfolio balance

function formatNumber(num, decimals = 2) {
  return num !== null && num !== undefined ? num.toFixed(decimals) : 'N/A';
}

function formatDuration(seconds) {
  if (seconds < 0) return '';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function renderSummary(data) {
  const { summary, signals, signalDurations, signalConfidences } = data;
  summaryBody.innerHTML = '';
  summary.forEach(s => {
    const {
      symbol, lastPrice, buyVolume, sellVolume, netVolume,
      rsiShort, rsiMain, rsiLong, macd, signal, bb,
      openInterest, fundingRate, atr,
    } = s;

    const netClass = netVolume > 0 ? 'positive' : netVolume < 0 ? 'negative' : '';
    const rsiClassShort = rsiShort > config.rsiOverbought ? 'rsi-high' : rsiShort < config.rsiOversold ? 'rsi-low' : '';
    const rsiClassMain = rsiMain > config.rsiOverbought ? 'rsi-high' : rsiMain < config.rsiOversold ? 'rsi-low' : '';
    const rsiClassLong = rsiLong > config.rsiOverbought ? 'rsi-high' : rsiLong < config.rsiOversold ? 'rsi-low' : '';

    const signalText = signals[symbol] || 'NEUTRAL';
    const signalColor = signalText === 'LONG' ? 'positive' : signalText === 'SHORT' ? 'negative' : '';
    const duration = signalDurations[symbol] || 0;
    const confidence = signalConfidences[symbol] || 0;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${symbol}</td>
      <td>${formatNumber(lastPrice, 4)}</td>
      <td>${formatNumber(buyVolume)}</td>
      <td>${formatNumber(sellVolume)}</td>
      <td class="${netClass}">${formatNumber(netVolume)}</td>
      <td class="${rsiClassShort}">${formatNumber(rsiShort)}</td>
      <td class="${rsiClassMain}">${formatNumber(rsiMain)}</td>
      <td class="${rsiClassLong}">${formatNumber(rsiLong)}</td>
      <td>${formatNumber(macd)}</td>
      <td>${formatNumber(signal)}</td>
      <td>${bb ? formatNumber(bb.lower) : 'N/A'}</td>
      <td>${bb ? formatNumber(bb.middle) : 'N/A'}</td>
      <td>${bb ? formatNumber(bb.upper) : 'N/A'}</td>
      <td>${formatNumber(atr, 4)}</td>
      <td>${openInterest !== undefined && openInterest !== null ? formatNumber(openInterest, 0) : 'N/A'}</td>
      <td>${fundingRate !== undefined && fundingRate !== null ? (fundingRate * 100).toFixed(4) + '%' : 'N/A'}</td>
      <td class="${signalColor}">${signalText} (${formatDuration(duration)}, Confidence: ${(confidence * 100).toFixed(0)}%)</td>
    `;
    summaryBody.appendChild(tr);
  });
}

function addLargeTradeAlert({ symbol, side, price, quantity, time }) {
  const div = document.createElement('div');
  div.classList.add('alert', side.toLowerCase());
  div.textContent = `${time} - ${symbol} ${side} ${quantity.toFixed(2)} @ ${price.toFixed(4)}`;
  largeTradesDiv.prepend(div);

  largeTrades.unshift(div);
  if (largeTrades.length > MAX_LARGE_TRADES) {
    const last = largeTrades.pop();
    largeTradesDiv.removeChild(last);
  }
}

function generateInsights(data) {
  const { summary, signals, signalDurations, signalConfidences } = data;
  if (!summary.length) {
    insightsDiv.textContent = 'No data available.';
    return;
  }

  const lines = summary.map(s => {
    const sig = signals[s.symbol] || 'NEUTRAL';
    const dur = signalDurations[s.symbol] || 0;
    const conf = signalConfidences[s.symbol] || 0;
    let advice = 'Caution advised. Monitor for stronger signals.';
    let details = [];

    if (sig === 'LONG') {
      advice = `Consider LONG position (Confidence: ${(conf * 100).toFixed(0)}%).`;
      details.push(`RSI: ${formatNumber(s.rsiMain)} (Oversold), MACD: ${formatNumber(s.macd)} > ${formatNumber(s.signal)}, Net Volume: ${formatNumber(s.netVolume)}`);
      if (s.fundingRate > 0.01) details.push(`Warning: High funding rate (${(s.fundingRate * 100).toFixed(2)}%) suggests crowded longs.`);
      if (positionManager.getPosition(s.symbol) === null && conf > 0.5) {
        positionManager.openPosition(s.symbol, s.lastPrice, conf, s.atr);
      }
    } else if (sig === 'SHORT') {
      advice = `Consider SHORT position (Confidence: ${(conf * 100).toFixed(0)}%).`;
      details.push(`RSI: ${formatNumber(s.rsiMain)} (Overbought), MACD: ${formatNumber(s.macd)} < ${formatNumber(s.signal)}, Net Volume: ${formatNumber(s.netVolume)}`);
      if (s.fundingRate < -0.01) details.push(`Warning: High negative funding rate (${(s.fundingRate * 100).toFixed(2)}%) suggests crowded shorts.`);
      if (positionManager.getPosition(s.symbol) === null && conf > 0.5) {
        positionManager.openPosition(s.symbol, s.lastPrice, conf, s.atr);
      }
    }

    if (positionManager.getPosition(s.symbol)) {
      positionManager.updatePrice(s.symbol, s.lastPrice);
      const pos = positionManager.getPosition(s.symbol);
      details.push(`Open Position: Size: ${pos.positionSize}, Stop: ${formatNumber(pos.stopLossPrice)}, Take Profit: ${formatNumber(pos.takeProfitPrice)}`);
    }

    return `${s.symbol}: ${sig} signal (active ${formatDuration(dur)}). ${advice}\n${details.join('\n')}`;
  });

  insightsDiv.textContent = lines.join('\n\n');
}

socket.on('summary', (data) => {
  renderSummary(data);
  generateInsights(data);
});

socket.on('largeTrade', (trade) => {
  addLargeTradeAlert(trade);
});
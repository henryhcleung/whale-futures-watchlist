const axios = require('axios');

const BASE_URL = 'https://fapi.binance.com';
const CACHE_DURATION_MS = 5 * 60 * 1000;

const openInterestCache = {};
const fundingRateCache = {};

async function getOpenInterest(symbol) {
  const now = Date.now();
  const cache = openInterestCache[symbol];
  if (cache && now - cache.timestamp < CACHE_DURATION_MS) {
    return cache.value;
  }
  try {
    const res = await axios.get(`${BASE_URL}/futures/data/openInterestHist`, {
      params: { symbol: symbol.toUpperCase(), period: '5m', limit: 1 },
    });
    if (res.data && res.data.length > 0) {
      const val = parseFloat(res.data[0].sumOpenInterest);
      openInterestCache[symbol] = { value: val, timestamp: now };
      return val;
    }
  } catch (e) {
    console.error(`Error fetching open interest for ${symbol}:`, e.message);
  }
  return cache ? cache.value : null;
}

async function getFundingRate(symbol) {
  const now = Date.now();
  const cache = fundingRateCache[symbol];
  if (cache && now - cache.timestamp < CACHE_DURATION_MS) {
    return cache.value;
  }
  try {
    const res = await axios.get(`${BASE_URL}/fapi/v1/fundingRate`, {
      params: { symbol: symbol.toUpperCase(), limit: 1 },
    });
    if (res.data && res.data.length > 0) {
      const val = parseFloat(res.data[0].fundingRate);
      fundingRateCache[symbol] = { value: val, timestamp: now };
      return val;
    }
  } catch (e) {
    console.error(`Error fetching funding rate for ${symbol}:`, e.message);
  }
  return cache ? cache.value : null;
}

module.exports = { getOpenInterest, getFundingRate };
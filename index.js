'use strict';
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');
const { ethers }      = require('ethers');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

// ─── Crash Guard ──────────────────────────────────────────────────────────────
process.on('unhandledRejection', (err) => { logFile('ERROR', 'Unhandled rejection: ' + (err?.message || err)); });
process.on('uncaughtException',  (err) => { logFile('ERROR', 'Uncaught exception: '  + (err?.message || err)); });

// ─── Graceful Shutdown ────────────────────────────────────────────────────────
let shuttingDown = false;
process.on('SIGINT',  () => { shuttingDown = true; });
process.on('SIGTERM', () => { shuttingDown = true; });

// ─── Config ───────────────────────────────────────────────────────────────────
let config       = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
let accountsData = [];
try { accountsData = JSON.parse(fs.readFileSync('./accounts.json', 'utf8')); } catch {}
const gs = config.settings || {};

// ─── Constants ────────────────────────────────────────────────────────────────
const DAILY_LIMIT_UTC             = 88;
const SELL_CC_MIN                 = 11.0;
const SELL_CC_MAX                 = 11.5;
const POSITION_MAX_HOLD_MS        = 8 * 60 * 1000;
const PRICE_CHECK_INTERVAL_MS     = 12000; // base; random per-check di hold loop
const MIN_DELAY_BETWEEN_TRADES_MS = 3  * 60 * 1000;
const MAX_DELAY_BETWEEN_TRADES_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS            = 30000;
const SUMMARY_INTERVAL_MS         = 60 * 1000;
const MIN_CC_GUARD                = Number(gs.minCCGuard) > 0 ? Number(gs.minCCGuard) : 5.0;
const LOG_MAX_HOURS               = Number(gs.logRotateHours) > 0 ? Number(gs.logRotateHours) : 24;

// ─── Adaptive Mode Thresholds ─────────────────────────────────────────────────
const MODE = {
  SAFE:       { feeLimit: 0.30 },  // progress < 0.3
  NORMAL:     { feeLimit: 0.40 },  // progress 0.3–0.7
  AGGRESSIVE: { feeLimit: 0.50 }   // progress > 0.7
};

// ─── Instruments ──────────────────────────────────────────────────────────────
const INSTRUMENTS = {
  CC:    { id: 'Amulet',  admin: 'DSO::1220b1431ef217342db44d516bb9befde802be7d8899637d290895fa58880f19accc' },
  CBTC:  { id: 'CBTC',    admin: 'cbtc-network::12205af3b949a04776fc48cdcc05a060f6bda2e470632935f375d1049a8546a3b262' },
  USDCx: { id: 'USDCx',   admin: 'decentralized-usdc-interchain-rep::12208115f1e168dd7e792320be9c4ca720c751a02a3053c7606e1c1cd3dad9bf60ef' }
};

// ─── File Logger (no console spam) ───────────────────────────────────────────
const LOG_FILE  = path.join(__dirname, 'bot.log');
let logStream   = fs.createWriteStream(LOG_FILE, { flags: 'a' });

setInterval(() => {
  try {
    const ageH = (Date.now() - fs.statSync(LOG_FILE).mtimeMs) / 3_600_000;
    if (ageH >= LOG_MAX_HOURS) {
      logStream.end();
      fs.writeFileSync(LOG_FILE, `[${new Date().toISOString()}] [INFO] Log rotated\n`);
      logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    }
  } catch {}
}, 3_600_000);

function logFile(level, msg) {
  try { logStream.write(`[${new Date().toISOString()}] [${level.padEnd(5)}] ${msg}\n`); } catch {}
}

// ─── Summary State ────────────────────────────────────────────────────────────
const summaryStats = { scanned: 0, valid: 0, traded: 0, skipped: 0 };
const recentLines  = []; // for terminal UI

function pushLine(line) {
  recentLines.push(line);
  if (recentLines.length > 15) recentLines.shift();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const RESET  = '\x1b[0m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';
const BOLD   = '\x1b[1m';
const DIM    = '\x1b[2m';

function c(color, str) { return color + str + RESET; }

function b64url(buf)   { return Buffer.from(buf).toString('base64url'); }
function sleep(ms)     { return new Promise(r => setTimeout(r, ms)); }
function rng(a, b)     { return a + Math.random() * (b - a); }
function ts()          { return new Date().toLocaleTimeString('id-ID', { hour12: false }); }
function utcDateStr()  { return new Date().toISOString().slice(0, 10); }
function pickSellAmt() {
  // Random 11.0–11.5, dibulatkan ke 2 desimal, dengan distribusi sedikit lebih berat di tengah
  const base = rng(SELL_CC_MIN, SELL_CC_MAX);
  const jitter = (Math.random() - 0.5) * 0.08; // ±0.04 extra noise
  return Math.round(Math.min(SELL_CC_MAX, Math.max(SELL_CC_MIN, base + jitter)) * 100) / 100;
}
function pickDelay()   { return rng(MIN_DELAY_BETWEEN_TRADES_MS, MAX_DELAY_BETWEEN_TRADES_MS); }

function fmtAmt(v, d = 10) {
  const f = 10 ** d;
  return (Math.floor(Math.max(0, v) * f) / f).toFixed(d).replace(/\.0+$/, '').replace(/(\..*?)0+$/, '$1');
}
function fmtDur(ms) {
  const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
  if (h > 0) return h + 'h' + (m % 60) + 'm';
  if (m > 0) return m + 'm' + (s % 60) + 's';
  return s + 's';
}
function fmtCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = String(Math.floor(total / 3600)).padStart(2, '0');
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
}
function secsUntilUtcMidnight() {
  const now = new Date();
  return Math.floor((new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)) - now) / 1000);
}

// ─── Adaptive Mode ────────────────────────────────────────────────────────────
function getMode(dailyDone) {
  const progress = dailyDone / DAILY_LIMIT_UTC;
  if (progress < 0.3)  return 'SAFE';
  if (progress < 0.7)  return 'NORMAL';
  return 'AGGRESSIVE';
}

// ─── Trade Decision ───────────────────────────────────────────────────────────
// CATATAN: shouldTrade hanya dipakai untuk CC→CBTC (same-denomination check).
// Untuk CC→USDCx, estimatedOut adalah USDCx — beda unit dari CC — sehingga
// perbandingan profit tidak valid. Filter USDCx dilakukan lewat fee limit saja.
function shouldTrade({ fee, mode }) {
  // Tolak hanya kalau fee benar-benar di luar batas wajar
  const feeLimit = mode === 'SAFE' ? 0.30 : mode === 'NORMAL' ? 0.40 : 0.50;
  if (fee > feeLimit) {
    return { ok: false, reason: `fee ${fee.toFixed(4)} > limit ${feeLimit} [${mode}]` };
  }
  return { ok: true, reason: 'OK' };
}

// ─── Ed25519 Key ──────────────────────────────────────────────────────────────
function createEd25519Key(hex) {
  const raw    = Buffer.from(hex, 'hex');
  if (raw.length !== 32) throw new Error('operatorKey must be 32 bytes');
  const prefix = Buffer.from('302e020100300506032b657004220420', 'hex');
  const pk     = crypto.createPrivateKey({ key: Buffer.concat([prefix, raw]), format: 'der', type: 'pkcs8' });
  const pub    = crypto.createPublicKey(pk);
  const spki   = pub.export({ type: 'spki', format: 'der' });
  return { privateKey: pk, pubHex: spki.subarray(spki.length - 32).toString('hex'), pubB64: b64url(spki.subarray(spki.length - 32)) };
}

// ─── secp256k1 DER Signing ────────────────────────────────────────────────────
function signDER(wallet, digestHex) {
  // FIX #2: guard against double 0x prefix jika server sudah mengirim 0x
  const sig = wallet.signingKey.sign(digestHex.startsWith('0x') ? digestHex : '0x' + digestHex);
  function toBytes(val) {
    let h = BigInt(val).toString(16);
    if (h.length % 2) h = '0' + h;
    if (parseInt(h.slice(0, 2), 16) >= 0x80) h = '00' + h;
    return Buffer.from(h, 'hex');
  }
  const r = toBytes(sig.r), s = toBytes(sig.s);
  const rT = Buffer.concat([Buffer.from([0x02, r.length]), r]);
  const sT = Buffer.concat([Buffer.from([0x02, s.length]), s]);
  const body = Buffer.concat([rT, sT]);
  return Buffer.concat([Buffer.from([0x30, body.length]), body]).toString('hex');
}

// ─── Account Class ────────────────────────────────────────────────────────────
class Account {
  constructor(name, creds, settings, proxy) {
    this.name         = name;
    this.baseUrl      = (settings.baseUrl || 'https://api.cantex.io').replace(/\/$/, '');
    this.opKey        = createEd25519Key(creds.operatorKey);
    // FIX #1: ethers v6 wajib prefix 0x pada private key
    this.intentWallet = new ethers.Wallet('0x' + creds.intentTradingKey.replace(/^0x/, ''));
    this.apiKey       = null;
    this.proxy        = proxy;
    this.settings     = settings;

    this.cc = 0; this.cbtc = 0; this.usdcx = 0;
    this.ccL = 0; this.cbtcL = 0; this.usdcxL = 0;

    this.totalTrades    = 0;
    this.okTrades       = 0;
    this.failTrades     = 0;
    this.tpCount        = 0;
    this.slCount        = 0;
    this.forceExits     = 0;
    this.totalNetGainCC = 0;

    this.dailyDate   = utcDateStr();
    this.dailyTrades = 0;

    this.status       = 'idle';
    this.lastErr      = '';
    this.phase        = '-';
    this.positionCC   = 0;
    this.positionRef  = 0;
    this.positionToken = '';
    this.positionPct  = 0;

    this._lowCCAlarmAt = 0;
    this._cycleCounter = 0;
  }

  // ── Networking ──────────────────────────────────────────────────────────────
  async _fetch(url, opts = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const fetchOpts = { ...opts, signal: controller.signal };
      if (this.proxy) fetchOpts.dispatcher = new ProxyAgent(this.proxy);
      return await undiciFetch(url, fetchOpts);
    } finally { clearTimeout(timer); }
  }

  async api(path, opts = {}) {
    for (let att = 0; att <= 3; att++) {
      const hdr = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
      if (this.apiKey) hdr['Authorization'] = 'Bearer ' + this.apiKey;
      try {
        const resp = await this._fetch(this.baseUrl + path, {
          method: opts.method || 'GET', headers: hdr, body: opts.body, redirect: 'manual'
        });
        const text = await resp.text();
        let data; try { data = JSON.parse(text); } catch { data = text; }
        if (resp.status === 401 && this.apiKey && att < 3) { try { await this.auth(); } catch {} continue; }
        if ([429, 502, 503, 504].includes(resp.status) && att < 3) {
          await sleep(Math.min(1000 * Math.pow(2, att), 10000) + Math.random() * 1000);
          continue;
        }
        return { status: resp.status, data };
      } catch (e) {
        if (att < 3) { await sleep(Math.min(3000 * Math.pow(2, att), 15000)); continue; }
        return { status: 0, data: null };
      }
    }
    return { status: 0, data: null };
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  async auth() {
    this.status = 'auth';
    const r1 = await this._fetch(this.baseUrl + '/v1/auth/api-key/begin', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: this.opKey.pubB64 })
    });
    if (r1.status !== 200) throw new Error('Auth begin ' + r1.status);
    const d1  = await r1.json();
    const sig = crypto.sign(null, Buffer.from(d1.message, 'utf8'), this.opKey.privateKey);
    const r2  = await this._fetch(this.baseUrl + '/v1/auth/api-key/finish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ challengeId: d1.challengeId, signature: b64url(sig) })
    });
    if (r2.status !== 200) throw new Error('Auth finish ' + r2.status);
    const d2    = await r2.json();
    this.apiKey = d2.api_key;
    logFile('INFO', `[${this.name}] Auth OK`);
  }

  async authRetry(max = 5) {
    for (let i = 0; i < max; i++) {
      try { await this.auth(); return true; } catch (e) {
        logFile('WARN', `[${this.name}] Auth fail (${i+1}/${max}): ${e.message}`);
        if (i < max - 1) await sleep(Math.min(5000 * Math.pow(2, i), 60000));
      }
    }
    this.status = 'error';
    return false;
  }

  async ensureAuth() {
    if (this.apiKey) {
      try { const c = await this.api('/v1/account/info'); if (c.status === 200) return true; } catch {}
    }
    return await this.authRetry();
  }

  // ── validateAccount — FIX 404 ──────────────────────────────────────────────
  // Validates that the Intent Trading Account exists before executing trades.
  // This prevents the "404 Intent Trading Account not found" error.
  async validateAccount() {
    const resp = await this.api('/v1/account/info');
    if (resp.status === 404) {
      logFile('ERROR', `[${this.name}] validateAccount: 404 Intent Trading Account not found. Check intentTradingKey.`);
      pushLine(c(RED, `[${this.name}] ❌ 404 — Intent Trading Account not found`));
      return false;
    }
    if (resp.status !== 200) {
      logFile('WARN', `[${this.name}] validateAccount: unexpected status ${resp.status}`);
      return false;
    }
    return true;
  }

  // ── Balance ────────────────────────────────────────────────────────────────
  async getBal() {
    const resp = await this.api('/v1/account/info');
    if (resp.status === 429) throw new Error('Rate limited');
    if (resp.status !== 200) throw new Error('Balance ' + resp.status);
    const bals = {};
    for (const t of resp.data.tokens || []) {
      bals[t.instrument_symbol] = {
        unlocked: parseFloat(t.balances.unlocked_amount),
        locked:   parseFloat(t.balances.locked_amount)
      };
    }
    this.cc    = bals.CC?.unlocked    || 0;
    this.cbtc  = bals.CBTC?.unlocked  || 0;
    this.usdcx = bals.USDCx?.unlocked || 0;
    this.ccL   = bals.CC?.locked      || 0;
    return bals;
  }

  // ── Quote ──────────────────────────────────────────────────────────────────
  async getQuote(sell, buy, amt) {
    const s = INSTRUMENTS[sell], b = INSTRUMENTS[buy];
    const resp = await this.api('/v2/pools/quote', {
      method: 'POST',
      body: JSON.stringify({
        sellInstrumentId:    s.id,  sellInstrumentAdmin: s.admin,
        sellAmount:          amt.toString(),
        buyInstrumentId:     b.id,  buyInstrumentAdmin:  b.admin
      })
    });
    return resp.status === 200 ? resp.data : null;
  }

  async quoteTokenToCC(token, amount) {
    if (!Number.isFinite(amount) || amount <= 0) return null;
    try {
      const q = await this.getQuote(token, 'CC', fmtAmt(amount, 10));
      const v = parseFloat(q?.returned?.amount || 0);
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch { return null; }
  }

  // ── Execute Trade — with retry ─────────────────────────────────────────────
  // executeTrade wraps doSwap with max 2 retries (for transient errors)
  async executeTrade(sell, buy, amt, retries = 2) {
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      const result = await this.doSwap(sell, buy, amt);
      if (result.ok === true) return result;
      if (result.ok === 'fee') return result; // don't retry fee rejections
      if (result.ok === '404') return result; // don't retry account not found

      if (attempt <= retries) {
        logFile('WARN', `[${this.name}] Trade attempt ${attempt} failed, retrying...`);
        pushLine(c(YELLOW, `[${this.name}] ⚠️ Retry ${attempt}/${retries}...`));
        await sleep(3000 * attempt);
      }
    }
    return { ok: false };
  }

  // ── doSwap ─────────────────────────────────────────────────────────────────
  async doSwap(sell, buy, amt) {
    this.status = 'swap';

    const quote = await this.getQuote(sell, buy, amt);
    if (!quote) { logFile('WARN', `[${this.name}] Quote failed`); return { ok: false }; }

    const netFee      = parseFloat(quote.fees?.network_fee?.amount || 0);
    const poolFeePct  = parseFloat(quote.fees?.fee_percentage || 0);
    const slippagePct = parseFloat(quote.slippage || 0);
    const estimatedOut = parseFloat(quote.returned?.amount || 0);
    const amountIn     = parseFloat(amt);
    const poolFeeAmt   = amountIn * poolFeePct;
    const slippageAmt  = amountIn * slippagePct;
    const totalFee     = netFee + poolFeeAmt + slippageAmt;

    // Pair preference: prefer CC→USDCx, be selective about CBTC
    if (sell === 'CC' && buy === 'CBTC') {
      // Only trade CBTC if clearly profitable (stricter threshold)
      const decision = shouldTrade({
        fee: totalFee,
        mode: getMode(this.dailyTrades)
      });
      if (!decision.ok) {
        summaryStats.scanned++;
        summaryStats.skipped++;
        const line = c(DIM, `[${this.name}] ${sell}→${buy} | Fee:${totalFee.toFixed(3)} | `) +
                     c(RED, `❌ SKIP [CBTC selective: ${decision.reason}]`);
        pushLine(line);
        return { ok: 'fee' };
      }
    }

    // Build intent
    const br = await this.api('/v1/intent/build/pool/swap', {
      method: 'POST',
      body: JSON.stringify({
        sellInstrumentId:      INSTRUMENTS[sell].id,    sellInstrumentAdmin: INSTRUMENTS[sell].admin,
        sellAmount:            amt,
        buyInstrumentId:       INSTRUMENTS[buy].id,     buyInstrumentAdmin:  INSTRUMENTS[buy].admin,
        intentTradingAddress:  this.intentWallet.address
      })
    });

    if (br.status === 404) {
      logFile('ERROR', `[${this.name}] 404 Intent Trading Account not found during build`);
      pushLine(c(RED, `[${this.name}] ❌ 404 — Trading account not found. Check intentTradingKey.`));
      return { ok: '404' };
    }
    if (br.status !== 200 || !br.data?.intent?.digest) {
      logFile('WARN', `[${this.name}] Build failed: ${br.status}`);
      return { ok: false };
    }

    const der = signDER(this.intentWallet, br.data.intent.digest);
    const sr  = await this.api('/v1/intent/submit', {
      method: 'POST',
      body: JSON.stringify({ id: br.data.id, intentTradingKeySignature: der })
    });

    if (!sr || sr.status !== 200 || sr.data?.verify !== true) {
      logFile('WARN', `[${this.name}] Submit failed: ${sr?.status} ${sr?.data?.error || ''}`);
      return { ok: false };
    }

    const balBefore = await this.getBal();
    const confirmed = await this.waitExec(sell, buy, balBefore, 90000, amountIn, estimatedOut);
    if (!confirmed) {
      logFile('WARN', `[${this.name}] Unconfirmed after 90s`);
      return { ok: false };
    }

    logFile('INFO', `[${this.name}] Swap OK: ${amt} ${sell}→${buy} | fee=${totalFee.toFixed(4)} est=${estimatedOut.toFixed(4)}`);
    return { ok: true, fees: { netFee, poolFeeAmt, slippageAmt, totalFee, estimatedOut } };
  }

  // ── waitExec ───────────────────────────────────────────────────────────────
  async waitExec(sell, buy, before, timeout, sellAmt, expectedBuyAmt) {
    const sB = before[sell]?.unlocked || 0;
    const bB = before[buy]?.unlocked  || 0;
    const checks = Math.max(3, Math.ceil(timeout / 10000));
    const minSellDrop = sellAmt * 0.95;
    const minBuyGain  = expectedBuyAmt > 0 ? expectedBuyAmt * 0.95 : 1e-8;
    for (let i = 0; i < checks; i++) {
      await sleep(10000);
      try {
        const bal = await this.getBal();
        if ((sB - (bal[sell]?.unlocked || 0)) >= minSellDrop &&
            ((bal[buy]?.unlocked || 0) - bB) >= minBuyGain) return true;
      } catch {}
    }
    return false;
  }

  // ── Daily Counter ──────────────────────────────────────────────────────────
  checkAndResetDaily() {
    const today = utcDateStr();
    if (this.dailyDate !== today) { this.dailyDate = today; this.dailyTrades = 0; }
  }
  get dailyRemaining() { this.checkAndResetDaily(); return Math.max(0, DAILY_LIMIT_UTC - this.dailyTrades); }
  recordTrade() { this.checkAndResetDaily(); this.dailyTrades++; this.totalTrades++; }

  // ── CC Guard ───────────────────────────────────────────────────────────────
  checkCCGuard() {
    if (this.cc < MIN_CC_GUARD) {
      const now = Date.now();
      if (now - this._lowCCAlarmAt > 10 * 60 * 1000) {
        this._lowCCAlarmAt = now;
        pushLine(c(RED, `[${this.name}] 🚨 CC LOW: ${this.cc.toFixed(2)} < ${MIN_CC_GUARD} — bot paused`));
        logFile('WARN', `[${this.name}] CC guard: ${this.cc.toFixed(2)} < ${MIN_CC_GUARD}`);
      }
      return false;
    }
    this._lowCCAlarmAt = 0;
    return true;
  }
}

// ─── logSummary ───────────────────────────────────────────────────────────────
function logSummary() {
  const line = c(CYAN, `[SUMMARY] Scan:${summaryStats.scanned} Valid:${summaryStats.valid} Trade:${summaryStats.traded} Skip:${summaryStats.skipped}`);
  pushLine(line);
  logFile('INFO', `[SUMMARY] Scan:${summaryStats.scanned} Valid:${summaryStats.valid} Trade:${summaryStats.traded} Skip:${summaryStats.skipped}`);
  summaryStats.scanned = 0; summaryStats.valid = 0;
  summaryStats.traded = 0;  summaryStats.skipped = 0;
}

// ─── State Writer (untuk dashboard) ───────────────────────────────────────────
const STATE_FILE = path.join(__dirname, 'state.json');

function writeState(accounts) {
  try {
    const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
    const state = {
      ts: Date.now(),
      totals: {
        trades:   accounts.reduce((a, x) => a + x.totalTrades, 0),
        ok:       accounts.reduce((a, x) => a + x.okTrades, 0),
        fail:     accounts.reduce((a, x) => a + x.failTrades, 0),
        netCC:    accounts.reduce((a, x) => a + x.totalNetGainCC, 0),
        ccGuard:  MIN_CC_GUARD,
        dailyLimit: DAILY_LIMIT_UTC,
      },
      accounts: accounts.map(a => ({
        name:         a.name,
        status:       a.status,
        cc:           a.cc,
        cbtc:         a.cbtc,
        usdcx:        a.usdcx,
        dailyTrades:  a.dailyTrades,
        mode:         getMode(a.dailyTrades),
        phase:        a.phase,
        netCC:        a.totalNetGainCC,
        okTrades:     a.okTrades,
        failTrades:   a.failTrades,
        tpCount:      a.tpCount,
        slCount:      a.slCount,
        positionCC:   a.positionCC,
        positionRef:  a.positionRef,
        positionToken:a.positionToken,
        positionPct:  a.positionPct,
        lastErr:      a.lastErr,
      })),
      recentLog: recentLines.slice().map(stripAnsi),
      summary:   { ...summaryStats },
    };
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) { logFile('WARN', 'writeState error: ' + e.message); }
}

// ─── Core Trade Cycle ─────────────────────────────────────────────────────────
async function runTradeCycle(acc) {
  acc.phase = 'sell';
  await acc.getBal();
  if (!acc.checkCCGuard()) return 'low_cc';

  // Validate account BEFORE attempting any trade (prevents 404)
  const accountValid = await acc.validateAccount();
  if (!accountValid) {
    await sleep(30000); // wait before retrying
    return 'error';
  }

  // Prefer USDCx, use CBTC only when clearly profitable
  const prefer = String(acc.settings.preferToken || 'usdcx').toLowerCase();
  let buyToken;
  if (prefer === 'cbtc')       buyToken = 'CBTC';
  else if (prefer === 'usdcx') buyToken = 'USDCx';
  else {
    // auto: prefer USDCx (80% of cycles), CBTC occasionally
    buyToken = (acc._cycleCounter % 5 === 0) ? 'CBTC' : 'USDCx';
    acc._cycleCounter++;
  }

  const sellAmt    = pickSellAmt();
  const sellAmtStr = fmtAmt(sellAmt, 10);
  const mode       = getMode(acc.dailyTrades);

  if (acc.cc < sellAmt + 0.2) {
    pushLine(c(YELLOW, `[${acc.name}] ⏸ CC low for sell (${acc.cc.toFixed(2)})`));
    return 'skip';
  }

  // Pre-flight: get quote and decide
  const preQuote = await acc.getQuote('CC', buyToken, sellAmtStr);
  summaryStats.scanned++;

  if (!preQuote) { return 'skip'; }

  const netFee       = parseFloat(preQuote.fees?.network_fee?.amount || 0);
  const poolFeePct   = parseFloat(preQuote.fees?.fee_percentage || 0);
  const slippagePct  = parseFloat(preQuote.slippage || 0);
  const estimatedOut = parseFloat(preQuote.returned?.amount || 0);
  const poolFeeAmt   = sellAmt * poolFeePct;
  const slippageAmt  = sellAmt * slippagePct;
  const totalFee     = netFee + poolFeeAmt + slippageAmt;

  // Untuk CC→USDCx: estimatedOut dalam USDCx, tidak bisa dibanding CC.
  // Filter hanya lewat fee limit — profitabilitas round-trip dinilai saat exit.
  // Untuk CC→CBTC: juga cukup fee limit di sini; CBTC check ada di doSwap.
  const decision = shouldTrade({ fee: totalFee, mode });

  if (!decision.ok) {
    summaryStats.skipped++;
    const line = c(DIM, `[${acc.name}] CC→${buyToken} | Fee:${totalFee.toFixed(3)} | `) +
                 c(RED, `❌ SKIP [${mode}] ${decision.reason}`);
    pushLine(line);
    return 'skip';
  }

  summaryStats.valid++;
  const line = c(BOLD, `[${acc.name}] CC→${buyToken} | Fee:${totalFee.toFixed(3)} | Est:${estimatedOut.toFixed(4)} ${buyToken} | `) +
               c(GREEN, `✅ EXECUTE [${mode}]`);
  pushLine(line);
  logFile('INFO', `[${acc.name}] EXECUTE ${mode}: CC→${buyToken} fee=${totalFee.toFixed(4)} profit=${(estimatedOut-sellAmt).toFixed(4)}`);

  // Execute with retry
  const sellResult = await acc.executeTrade('CC', buyToken, sellAmtStr);

  if (sellResult.ok === '404') return 'error';
  if (sellResult.ok !== true) {
    if (sellResult.ok === 'fee') return 'fee';
    acc.failTrades++;
    return 'error';
  }

  summaryStats.traded++;

  const sellFees    = sellResult.fees;
  const trueCostCC  = sellAmt + (sellFees?.totalFee || 0);

  await acc.getBal();

  const tokenField   = buyToken === 'USDCx' ? 'usdcx' : 'cbtc';
  const tokenHeld    = acc[tokenField];
  acc.positionCC     = sellAmt;
  acc.positionToken  = buyToken;
  acc.positionRef    = trueCostCC;
  acc.positionPct    = 0;

  pushLine(c(CYAN, `[${acc.name}] 📦 Holding ${tokenHeld.toFixed(6)} ${buyToken} | cost=${trueCostCC.toFixed(4)} CC`));

  // ── HOLD / MONITOR ────────────────────────────────────────────────────────
  acc.phase = 'hold';
  const holdStart = Date.now();
  let exitReason  = 'timeout';
  const TP_THRESHOLD_PCT = 0.003;
  const SL_THRESHOLD_PCT = -0.02;

  while (true) {
    if (shuttingDown) { exitReason = 'shutdown'; break; }
    // FIX #3: random per-check (bukan global) agar antar-akun tidak rate limit bersamaan
    await sleep(PRICE_CHECK_INTERVAL_MS + Math.floor(Math.random() * 6000));
    const elapsed = Date.now() - holdStart;

    try { await acc.getBal(); } catch {}
    const currentTokenAmt = acc[tokenField];
    if (currentTokenAmt < 1e-8) { exitReason = 'gone'; break; }

    const currentCC = await acc.quoteTokenToCC(buyToken, currentTokenAmt);
    if (currentCC == null) continue;

    const plPct = (currentCC - acc.positionRef) / acc.positionRef;
    acc.positionPct = plPct;

    const plStr  = (plPct >= 0 ? '+' : '') + (plPct * 100).toFixed(3) + '%';
    const plColor = plPct >= 0 ? GREEN : RED;
    pushLine(c(DIM, `[${acc.name}] 💹 ${buyToken} = ${currentCC.toFixed(4)} CC | P/L: `) + c(plColor, plStr));

    if (plPct >= TP_THRESHOLD_PCT) { exitReason = 'tp'; break; }
    if (plPct <= SL_THRESHOLD_PCT) { exitReason = 'sl'; break; }
    if (elapsed >= POSITION_MAX_HOLD_MS) { exitReason = 'timeout'; break; }
  }

  // ── EXIT ──────────────────────────────────────────────────────────────────
  acc.phase = 'buy';
  if (exitReason === 'gone') { acc.recordTrade(); return 'ok'; }

  await acc.getBal();
  const tokenToSell = acc[tokenField];
  if (tokenToSell < 1e-8) { acc.recordTrade(); return 'ok'; }

  const exitEmoji = exitReason === 'tp' ? '🟢' : exitReason === 'sl' ? '🔴' : '⏱';
  pushLine(c(BOLD, `[${acc.name}] ${exitEmoji} EXIT(${exitReason}): ${tokenToSell.toFixed(6)} ${buyToken}→CC`));

  const ccBeforeExit = acc.cc;
  const exitResult   = await acc.executeTrade(buyToken, 'CC', fmtAmt(tokenToSell, 10));

  if (exitResult.ok === true) {
    await acc.getBal();
    // FIX #4: kurangi trueCostCC (sellAmt + fee entry), bukan positionCC yang hanya sellAmt
    const netGain = (acc.cc - ccBeforeExit) - acc.positionRef;
    acc.totalNetGainCC += netGain;

    if (exitReason === 'tp')      { acc.tpCount++;    acc.okTrades++; }
    else if (exitReason === 'sl') { acc.slCount++;    acc.okTrades++; }
    else                          { acc.forceExits++; acc.okTrades++; }
    acc.recordTrade();

    const gainStr  = (netGain >= 0 ? '+' : '') + netGain.toFixed(4);
    const gainColor = netGain >= 0 ? GREEN : RED;
    pushLine(c(gainColor, `[${acc.name}] ✅ Cycle done | net=${gainStr} CC | total=${acc.totalNetGainCC.toFixed(4)} CC`));
    logFile('INFO', `[${acc.name}] CYCLE result=${exitReason} net=${gainStr}CC cumulative=${acc.totalNetGainCC.toFixed(4)}CC`);
  } else {
    acc.failTrades++;
    pushLine(c(RED, `[${acc.name}] ❌ Exit swap failed (${exitReason})`));
    logFile('ERROR', `[${acc.name}] Exit swap failed: ${exitReason}`);
  }

  acc.phase        = 'done';
  acc.positionToken = '';
  acc.positionPct  = 0;
  return exitResult.ok === true ? 'ok' : 'error';
}

// ─── Account Runner ───────────────────────────────────────────────────────────
async function runAcc(acc) {
  if (!await acc.authRetry(5)) {
    pushLine(c(RED, `[${acc.name}] ❌ Auth failed after 5 attempts — stopping`));
    logFile('ERROR', `[${acc.name}] Auth failed after 5 attempts`);
    return;
  }
  try { await acc.getBal(); } catch (e) {
    logFile('WARN', `[${acc.name}] getBal at start: ${e.message}`);
  }
  pushLine(c(GREEN, `[${acc.name}] 🚀 Bot started | limit=${DAILY_LIMIT_UTC}/day UTC`));

  while (!shuttingDown) {
    acc.checkAndResetDaily();

    if (acc.dailyRemaining <= 0) {
      const secsLeft = secsUntilUtcMidnight();
      acc.status = 'cooldown';
      acc.phase  = '-';
      await sleep(Math.min(secsLeft * 1000, 15000));
      continue;
    }

    acc.status = 'run';
    let result;
    try {
      if (!await acc.ensureAuth()) { await sleep(15000); continue; }
      result = await runTradeCycle(acc);
    } catch (e) {
      acc.lastErr = e.message;
      acc.status  = 'error';
      logFile('ERROR', `[${acc.name}] runTradeCycle: ${e.message}`);
      pushLine(c(RED, `[${acc.name}] ❌ Error: ${e.message}`));
      await sleep(e.message.includes('Rate') ? 30000 : 15000);
      continue;
    }

    acc.lastErr = '';

    if (result === 'low_cc') { acc.status = 'paused'; await sleep(60000); continue; }
    if (result === 'skip')   { acc.status = 'idle';   await sleep(5000);  continue; }
    if (result === 'fee')    { acc.status = 'fee';    await sleep(rng(60000, 120000)); continue; }
    if (result === 'error')  { acc.status = 'error';  await sleep(15000); continue; }

    const delay = pickDelay();
    acc.status = 'idle';
    acc.phase  = '-';
    pushLine(c(DIM, `[${acc.name}] ⏳ Next cycle: ${fmtDur(delay)} | daily ${acc.dailyTrades}/${DAILY_LIMIT_UTC}`));
    await sleep(delay);
  }

  pushLine(c(YELLOW, `[${acc.name}] 🛑 Graceful shutdown`));
}

// ─── Dashboard Renderer ───────────────────────────────────────────────────────
function render(accounts) {
  const wibStr = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false });

  // Tampilan saja: helper ini hanya merapikan lebar teks ANSI di terminal.
  const stripAnsi = s => String(s ?? '').replace(/\x1b\[[0-9;]*m/g, '');
  const vLen = s => stripAnsi(s).length;
  const fit = (s, width) => {
    s = String(s ?? '');
    if (vLen(s) <= width) return s + ' '.repeat(width - vLen(s));
    return stripAnsi(s).slice(0, Math.max(0, width - 1)) + '…';
  };
  const cleanLog = (line) => {
    let s = String(line ?? '');
    const words = [
      [/\[SUMMARY\]/g, '[REKAP]'],
      [/Scan:/g, 'Dipindai:'],
      [/Valid:/g, 'Lolos:'],
      [/Trade:/g, 'Swap:'],
      [/Skip:/g, 'Lewat:'],
      [/Fee:/g, 'Biaya:'],
      [/Est:/g, 'Estimasi:'],
      [/❌ SKIP/g, '⛔ DILEWATI'],
      [/EXECUTE/g, 'EKSEKUSI'],
      [/\[SAFE\]/g, '[AMAN]'],
      [/\[NORMAL\]/g, '[STABIL]'],
      [/\[AGGRESSIVE\]/g, '[CEPAT]'],
      [/fee /g, 'biaya '],
      [/ > limit /g, ' > batas '],
      [/Holding/g, 'Menahan posisi'],
      [/cost=/g, 'modal='],
      [/EXIT/g, 'KELUAR'],
      [/Cycle done/g, 'Siklus selesai'],
      [/net=/g, 'hasil='],
      [/total=/g, 'akumulasi='],
      [/Next cycle:/g, 'Siklus berikutnya:'],
      [/\| daily /g, '| harian '],
      [/Bot started/g, 'Sistem aktif'],
      [/limit=/g, 'batas='],
      [/Error:/g, 'Kendala:'],
      [/CC low for sell/g, 'CC tidak cukup untuk jual'],
      [/Trade attempt/g, 'Percobaan swap'],
      [/Retry/g, 'Coba ulang'],
      [/failed/g, 'gagal'],
      [/retrying/g, 'mengulang'],
      [/Graceful shutdown/g, 'Berhenti aman']
    ];
    for (const [a, b] of words) s = s.replace(a, b);
    return s;
  };

  const stMap  = {
    idle:     c(DIM, 'SIAGA'),
    run:      c(GREEN, 'AKTIF'),
    swap:     c(CYAN, 'SWAP'),
    auth:     c(YELLOW, 'LOGIN'),
    fee:      c(YELLOW, 'TUNDA BIAYA'),
    error:    c(RED, 'KENDALA'),
    cooldown: c(YELLOW, 'BATAS HARIAN'),
    paused:   c(RED, 'CC RENDAH')
  };
  const phaseMap = {
    sell: c(RED, 'JUAL'),
    hold: c(CYAN, 'PANTAU'),
    buy:  c(GREEN, 'BELI BALIK'),
    done: c(GREEN, 'SELESAI'),
    '-':  '-'
  };

  const tTotal = accounts.reduce((a, x) => a + x.totalTrades,    0);
  const tOk    = accounts.reduce((a, x) => a + x.okTrades,       0);
  const tFail  = accounts.reduce((a, x) => a + x.failTrades,     0);
  const tNet   = accounts.reduce((a, x) => a + x.totalNetGainCC, 0);
  const tNetStr = (tNet >= 0 ? '+' : '') + tNet.toFixed(4);
  const netColor = tNet >= 0 ? GREEN : RED;

  // Lebar dashboard dibuat lebih besar dan adaptif terhadap ukuran terminal.
  const W = Math.max(118, Math.min((process.stdout.columns || 132) - 2, 150));
  const wide = '═'.repeat(W);
  const thin = '─'.repeat(W);

  const row = (content = '') => '║' + fit('  ' + content, W) + '║';
  const sep = () => '╠' + thin + '╣';

  const lines = [];
  lines.push('╔' + wide + '╗');
  lines.push(row(c(BOLD + CYAN, '◆ NEXORA CANTEX ◆') + c(DIM, `  │  ${wibStr} WIB  │  ${accounts.length} akun aktif`)));
  lines.push(row(c(DIM, 'Auto Swap Monitor • CC ⇄ USDCx/CBTC • TP/SL/Timeout Watcher')));
  lines.push('╠' + wide + '╣');

  const stat1 = `${c(BOLD, 'Siklus')}: ${tTotal}   ${c(GREEN, 'Sukses')}: ${tOk}   ${c(RED, 'Gagal')}: ${tFail}`;
  const stat2 = `${c(BOLD, 'Laba/Rugi')}: ${c(netColor, tNetStr + ' CC')}   ${c(BOLD, 'Pelindung CC')}: ≥ ${MIN_CC_GUARD}   ${c(BOLD, 'Jatah')}: ${DAILY_LIMIT_UTC}/hari UTC`;
  lines.push(row(stat1 + '   │   ' + stat2));
  lines.push(sep());

  lines.push(row(c(BOLD, 'RINGKASAN AKUN')));
  lines.push(row(
    fit(c(BOLD, 'Akun'), 14) + '  ' +
    fit(c(BOLD, 'Kondisi'), 14) + '  ' +
    fit(c(BOLD, 'CC'), 10) + '  ' +
    fit(c(BOLD, 'CBTC'), 10) + '  ' +
    fit(c(BOLD, 'USDCx'), 10) + '  ' +
    fit(c(BOLD, 'Harian'), 9) + '  ' +
    fit(c(BOLD, 'Mode'), 9) + '  ' +
    fit(c(BOLD, 'Tahap'), 11) + '  ' +
    fit(c(BOLD, 'Net CC'), 12)
  ));
  lines.push(row('─'.repeat(Math.min(W - 4, 116))));

  for (const a of accounts) {
    const mode    = getMode(a.dailyTrades);
    const modeStr = mode === 'SAFE' ? c(GREEN, 'AMAN') : mode === 'NORMAL' ? c(YELLOW, 'STABIL') : c(RED, 'CEPAT');
    const netStr  = (a.totalNetGainCC >= 0 ? c(GREEN, '+' + a.totalNetGainCC.toFixed(3)) : c(RED, a.totalNetGainCC.toFixed(3)));
    const stStr   = stMap[a.status] || a.status;
    const phStr   = phaseMap[a.phase] || a.phase;
    const cdStr   = a.status === 'cooldown' ? ' ' + fmtCountdown(secsUntilUtcMidnight() * 1000) : '';

    lines.push(row(
      fit(a.name, 14) + '  ' +
      fit(stStr + cdStr, 14) + '  ' +
      fit(a.cc.toFixed(2), 10) + '  ' +
      fit((a.cbtc || 0).toFixed(6), 10) + '  ' +
      fit((a.usdcx || 0).toFixed(4), 10) + '  ' +
      fit(a.dailyTrades + '/' + DAILY_LIMIT_UTC, 9) + '  ' +
      fit(modeStr, 9) + '  ' +
      fit(phStr, 11) + '  ' +
      fit(netStr, 12)
    ));

    if (a.positionToken) {
      const pct = ((a.positionPct || 0) * 100).toFixed(3) + '%';
      const pctColor = (a.positionPct || 0) >= 0 ? GREEN : RED;
      lines.push(row(c(DIM, `   ↳ Posisi berjalan: ${a.positionToken} | Modal ${a.positionRef.toFixed(4)} CC | P/L `) + c(pctColor, pct)));
    }
  }

  lines.push(sep());
  lines.push(row(c(BOLD, 'AKTIVITAS TERBARU')));
  const maxLogLines = Math.min(recentLines.length, 12);
  for (let i = recentLines.length - maxLogLines; i < recentLines.length; i++) {
    lines.push(row(cleanLog(recentLines[i])));
  }
  for (let i = maxLogLines; i < 12; i++) lines.push(row(''));

  lines.push('╠' + wide + '╣');
  lines.push(row(c(DIM, 'Target Profit +0.3%  │  Stop Loss -2%  │  Maksimal Hold 8 menit  │  Tekan Ctrl+C untuk berhenti aman')));
  lines.push('╚' + wide + '╝');

  process.stdout.write('\x1b[2J\x1b[H'); // clear screen
  process.stdout.write(lines.join('\n') + '\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  logFile('INFO', '=== Cantonverse Bot v1.4 START ===');

  const gProxy = gs.proxy || null;
  const acList = accountsData || [];
  if (!acList.length) { console.log('❌ No accounts in accounts.json'); process.exit(1); }

  const accounts = [];
  for (let i = 0; i < acList.length; i++) {
    const ac = acList[i];
    const nm = ac.name || 'Acc' + (i + 1);
    const px = ac.proxy || gProxy;
    if (!ac.operatorKey      || ac.operatorKey.startsWith('PASTE'))      { console.log(`❌ [${nm}] no operatorKey`);    continue; }
    if (!ac.intentTradingKey || ac.intentTradingKey.startsWith('PASTE')) { console.log(`❌ [${nm}] no intentTradingKey`); continue; }
    try {
      const merged = Object.assign({}, gs, ac.settings || {});
      accounts.push(new Account(nm, { operatorKey: ac.operatorKey, intentTradingKey: ac.intentTradingKey }, merged, px));
      console.log(`✅ [${nm}] loaded${px ? ' [proxy]' : ''}`);
    } catch (e) { console.log(`❌ [${nm}] ${e.message}`); }
  }
  if (!accounts.length) { console.log('\n❌ No valid accounts\n'); process.exit(1); }

  // Stagger start sudah dilakukan di dalam Promise.all di bawah (baris ~848)
  // FIX #5: blok sleep sequential ini dihapus — tidak ada manfaatnya

  // Dashboard refresh every 5 seconds
  setInterval(() => { render(accounts); writeState(accounts); }, 5000);
  render(accounts);
  writeState(accounts);

  // Summary every 60 seconds
  setInterval(logSummary, SUMMARY_INTERVAL_MS);

  // Run all accounts in parallel
  await Promise.all(accounts.map((a, i) => (async () => {
    if (i > 0) await sleep(i * rng(3000, 8000));
    await runAcc(a);
  })()));

  render(accounts);
  logFile('INFO', '=== Cantonverse Bot STOPPED (graceful) ===');
  process.exit(0);
}

main().catch(e => {
  logFile('ERROR', 'Fatal: ' + e.message);
  console.error('\n❌ Fatal:', e.message);
  process.exit(1);
});

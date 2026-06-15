#!/usr/bin/env node
// Fullsite Print Bridge — Node.js version (no TypeScript, no Bun)
// Usage: node bridge.js [path/to/printers.json]

const http = require('http');
const net = require('net');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ── Config types & validation ───────────────────────────────────────────

const DEFAULT_BRIDGE_PORT = 7717;
const DEFAULT_RAW_PORT = 9100;
const DRAWER_KICK = Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]);

function validatePrinter(name, p) {
  if (typeof p !== 'object' || p === null) {
    throw new Error(`stations.${name}: debe ser un objeto`);
  }
  if (p.type === 'tcp') {
    if (typeof p.host !== 'string' || p.host.length === 0) {
      throw new Error(`stations.${name}: impresora tcp requiere "host"`);
    }
    if (p.port !== undefined && (typeof p.port !== 'number' || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535)) {
      throw new Error(`stations.${name}: "port" invalido`);
    }
    const r = { type: 'tcp', host: p.host };
    if (p.port !== undefined) r.port = p.port;
    return r;
  }
  if (p.type === 'windows') {
    if (typeof p.printer !== 'string' || p.printer.length === 0) {
      throw new Error(`stations.${name}: impresora windows requiere "printer"`);
    }
    return { type: 'windows', printer: p.printer };
  }
  throw new Error(`stations.${name}: "type" debe ser "tcp" o "windows"`);
}

function validateStation(name, p) {
  if (Array.isArray(p)) {
    if (p.length === 0) throw new Error(`stations.${name}: arreglo vacio`);
    return p.map((item, i) => validatePrinter(`${name}[${i}]`, item));
  }
  return [validatePrinter(name, p)];
}

function parseConfig(raw) {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('printers.json debe ser un objeto JSON');
  }
  const port = raw.port === undefined ? DEFAULT_BRIDGE_PORT : raw.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('"port" invalido (1-65535)');
  }
  if (typeof raw.stations !== 'object' || raw.stations === null || Array.isArray(raw.stations)) {
    throw new Error('"stations" debe ser un objeto { nombre: impresora }');
  }
  const stations = {};
  for (const [name, p] of Object.entries(raw.stations)) {
    stations[name] = validateStation(name, p);
  }
  if (Object.keys(stations).length === 0) {
    throw new Error('"stations" no puede estar vacio');
  }
  let def;
  if (raw.default !== undefined) {
    if (typeof raw.default !== 'string' || !(raw.default in stations)) {
      throw new Error(`"default" debe ser una estacion existente (${Object.keys(stations).join(', ')})`);
    }
    def = raw.default;
  }
  return { port, stations, default: def };
}

function resolvePrinter(config, station) {
  const direct = station ? config.stations[station] : undefined;
  if (station && direct) return { station, printers: direct };
  const fallback = config.default ? config.stations[config.default] : undefined;
  if (config.default && fallback) return { station: config.default, printers: fallback };
  const names = Object.keys(config.stations);
  if (names.length === 1) return { station: names[0], printers: config.stations[names[0]] };
  return null;
}

// ── Load config ─────────────────────────────────────────────────────────

const here = __dirname;
const candidates = [
  process.argv[2],
  path.join(here, 'printers.json'),
  path.join(process.cwd(), 'printers.json'),
].filter(Boolean);
const configPath = candidates.find(p => fs.existsSync(p)) || candidates[candidates.length - 1];

function sibling(name) {
  return path.join(here, name);
}

let config;
try {
  config = parseConfig(JSON.parse(fs.readFileSync(configPath, 'utf8')));
} catch (e) {
  console.error(`No pude leer ${configPath}: ${e.message}`);
  console.error('Copia printers.json junto a bridge.js y ajustalo.');
  process.exit(2);
}

// ── Transports ──────────────────────────────────────────────────────────

function printTcp(printer, bytes) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: printer.host, port: printer.port || DEFAULT_RAW_PORT });
    const fail = (err) => { socket.destroy(); reject(err); };
    socket.setTimeout(5000, () => fail(new Error('timeout conectando a ' + printer.host)));
    socket.on('error', fail);
    socket.on('connect', () => {
      socket.end(bytes, () => resolve());
    });
  });
}

function printWindows(printerName, bytes) {
  return new Promise((resolve, reject) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsprint-'));
    const file = path.join(dir, 'job.bin');
    fs.writeFileSync(file, bytes);
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sibling('raw-print.ps1'), '-PrinterName', printerName, '-FilePath', file],
      { timeout: 15000 },
      (err, _stdout, stderr) => {
        // Clean up temp file
        try { fs.unlinkSync(file); fs.rmdirSync(dir); } catch (_) {}
        if (err) reject(new Error('raw-print.ps1 fallo: ' + (stderr || err.message)));
        else resolve();
      },
    );
  });
}

function dispatchOne(printer, bytes) {
  return printer.type === 'tcp' ? printTcp(printer, bytes) : printWindows(printer.printer, bytes);
}

async function dispatch(printers, bytes) {
  const results = await Promise.allSettled(printers.map(p => dispatchOne(p, bytes)));
  const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
  const printed = results.length - errors.length;
  if (printed === 0) throw new Error(errors.join(' | ') || 'ninguna impresora respondio');
  return { printed, errors };
}

// ── Security ────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  'https://app.fullsite.mx',
  'https://fullsite.mx',
  'http://localhost:3000',
  'http://localhost:3001',
];

function setCors(req, res) {
  const origin = req.headers.origin || '';
  const allowed = !origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o));
  if (allowed) res.setHeader('Access-Control-Allow-Origin', origin || ALLOWED_ORIGINS[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Token');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return allowed;
}

const rateWindow = [];
const RATE_WINDOW_MS = 60000;
const RATE_MAX = 120;
const burstWindow = [];
const BURST_WINDOW_MS = 2000;
const BURST_MAX = 10;

function checkRateLimit() {
  const now = Date.now();
  while (rateWindow.length > 0 && rateWindow[0] < now - RATE_WINDOW_MS) rateWindow.shift();
  while (burstWindow.length > 0 && burstWindow[0] < now - BURST_WINDOW_MS) burstWindow.shift();
  if (rateWindow.length >= RATE_MAX || burstWindow.length >= BURST_MAX) return false;
  rateWindow.push(now);
  burstWindow.push(now);
  return true;
}

function isValidBase64(data) {
  if (data.length > 500000) return false;
  return /^[A-Za-z0-9+/=\s]+$/.test(data);
}

function auditLog(method, url, status, detail) {
  console.log(`[${new Date().toISOString()}] ${method} ${url} -> ${status} ${detail}`);
}

// ── HTTP Server ─────────────────────────────────────────────────────────

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 1048576) { reject(new Error('payload demasiado grande')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const method = req.method || 'UNKNOWN';
  const url = req.url || '/';

  req.setTimeout(10000, () => req.destroy());
  res.setTimeout(10000, () => res.destroy());

  const originAllowed = setCors(req, res);
  if (!originAllowed && req.headers.origin) {
    auditLog(method, url, 403, 'BLOCKED origin: ' + req.headers.origin);
    json(res, 403, { ok: false, error: 'Origin no autorizado' });
    return;
  }

  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const validRoutes = { 'GET /health': 1, 'POST /print': 1, 'POST /drawer': 1 };
  if (!validRoutes[method + ' ' + url] && method !== 'OPTIONS') {
    auditLog(method, url, 405, 'BLOCKED');
    json(res, 405, { ok: false, error: 'Ruta no permitida' });
    return;
  }

  if (!checkRateLimit()) {
    auditLog(method, url, 429, 'BLOCKED rate limit');
    json(res, 429, { ok: false, error: 'Demasiados requests' });
    return;
  }

  try {
    if (method === 'GET' && url === '/health') {
      auditLog(method, url, 200, 'health check');
      json(res, 200, {
        ok: true,
        service: 'fullsite-print-bridge',
        version: '1.1.0-node',
        stations: Object.keys(config.stations),
        default: config.default || null,
        uptime: Math.floor(process.uptime()),
      });
      return;
    }

    if (method === 'POST' && (url === '/print' || url === '/drawer')) {
      const body = (await readBody(req)) || '{}';
      let parsed;
      try { parsed = JSON.parse(body); } catch (_) {
        auditLog(method, url, 400, 'invalid JSON');
        json(res, 400, { ok: false, error: 'body no es JSON' });
        return;
      }

      const resolved = resolvePrinter(config, parsed.station || null);
      if (!resolved) {
        auditLog(method, url, 404, 'unknown station: ' + parsed.station);
        json(res, 404, { ok: false, error: 'estacion desconocida: ' + (parsed.station || '(ninguna)') });
        return;
      }

      let bytes;
      if (url === '/drawer') {
        bytes = DRAWER_KICK;
      } else {
        if (!parsed.data) {
          auditLog(method, url, 400, 'missing data');
          json(res, 400, { ok: false, error: 'falta "data" (ESC/POS en base64)' });
          return;
        }
        if (!isValidBase64(parsed.data)) {
          auditLog(method, url, 400, 'BLOCKED invalid base64');
          json(res, 400, { ok: false, error: 'data invalida o demasiado grande' });
          return;
        }
        bytes = Buffer.from(parsed.data, 'base64');
        if (bytes.length === 0) {
          auditLog(method, url, 400, 'empty base64');
          json(res, 400, { ok: false, error: 'data vacio' });
          return;
        }
      }

      const { printed, errors } = await dispatch(resolved.printers, bytes);
      auditLog(method, url, 200, `${resolved.station} (${bytes.length}B, ${printed}/${resolved.printers.length} ok)${errors.length ? ' PARTIAL: ' + errors.join(' | ') : ''}`);
      const result = { ok: true, station: resolved.station, bytes: bytes.length, printed };
      if (errors.length) result.errors = errors;
      json(res, 200, result);
      return;
    }

    json(res, 404, { ok: false, error: 'ruta desconocida' });
  } catch (e) {
    auditLog(method, url, 502, 'ERROR: ' + e.message);
    json(res, 502, { ok: false, error: 'Error interno del bridge' });
  }
});

process.on('SIGINT', () => { console.log('\n[bridge] Shutting down...'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });

server.listen(config.port, '127.0.0.1', () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║   Fullsite Print Bridge v1.1.0-node      ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  URL:        http://127.0.0.1:' + config.port);
  console.log('  Config:     ' + configPath);
  console.log('  Estaciones: ' + Object.keys(config.stations).join(', ') + (config.default ? ' (default: ' + config.default + ')' : ''));
  console.log('');
  console.log('  Listo para imprimir. No cierres esta ventana.');
  console.log('');
});

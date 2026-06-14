// Print bridge — servidor HTTP local (módulo device).
//
//   node tools/print-bridge/server.ts [ruta/printers.json]
//
// Corre en la terminal Windows de AMALAY. El POS (browser) le pega a
// http://127.0.0.1:7717 — localhost está exento de mixed-content en Chrome.
//
// Endpoints:
//   GET  /health           → { ok, stations, default }
//   POST /print            → { station?, data } (data = ESC/POS en base64)
//   POST /drawer           → { station? } (kick de cajón vía impresora)
//   OPTIONS *              → preflight CORS + Private Network Access
//
// Transportes:
//   tcp     → socket crudo a host:9100 (impresoras de red)
//   windows → PowerShell raw-print.ps1 (winspool, impresoras USB por nombre)
//
// Compilar a .exe para la terminal:
//   bun build tools/print-bridge/server.ts --compile --target=bun-windows-x64 --outfile fullsite-print-bridge.exe

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseConfig,
  resolvePrinter,
  decodeBase64,
  DRAWER_KICK,
  DEFAULT_RAW_PORT,
  ConfigError,
  type BridgeConfig,
  type PrinterConfig,
} from './lib.ts';

// Compilado a .exe, import.meta.url apunta al bundle virtual de bun — el
// printers.json real vive junto al ejecutable. Buscamos en orden:
// argv[2] → junto al .exe → junto al script → cwd.
const here = dirname(fileURLToPath(import.meta.url));
const candidates = [
  process.argv[2],
  join(dirname(process.execPath), 'printers.json'),
  join(here, 'printers.json'),
  join(process.cwd(), 'printers.json'),
].filter((p): p is string => Boolean(p));
const configPath = candidates.find((p) => existsSync(p)) ?? candidates[candidates.length - 1];

/** Resuelve un archivo hermano (ej. raw-print.ps1): junto al .exe → junto al script. */
function sibling(name: string): string {
  const next = join(dirname(process.execPath), name);
  return existsSync(next) ? next : join(here, name);
}

let config: BridgeConfig;
try {
  config = parseConfig(JSON.parse(readFileSync(configPath, 'utf8')));
} catch (e) {
  if (e instanceof ConfigError) {
    console.error(`Config inválida (${configPath}): ${e.message}`);
  } else {
    console.error(`No pude leer ${configPath}: ${(e as Error).message}`);
    console.error('Copia printers.example.json a printers.json y ajústalo.');
  }
  process.exit(2);
}

// ── Transportes ──────────────────────────────────────────────────────────

function printTcp(printer: { host: string; port?: number }, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: printer.host, port: printer.port ?? DEFAULT_RAW_PORT });
    const fail = (err: Error) => {
      socket.destroy();
      reject(err);
    };
    socket.setTimeout(5000, () => fail(new Error(`timeout conectando a ${printer.host}`)));
    socket.on('error', fail);
    socket.on('connect', () => {
      socket.end(Buffer.from(bytes), () => resolve());
    });
  });
}

function printWindows(printerName: string, bytes: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    // Los bytes van por archivo temporal (binario intacto; nada de stdin/encoding).
    const dir = mkdtempSync(join(tmpdir(), 'fsprint-'));
    const file = join(dir, 'job.bin');
    writeFileSync(file, Buffer.from(bytes));
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', sibling('raw-print.ps1'), '-PrinterName', printerName, '-FilePath', file],
      { timeout: 15000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`raw-print.ps1 falló: ${stderr || err.message}`));
        else resolve();
      },
    );
  });
}

function dispatchOne(printer: PrinterConfig, bytes: Uint8Array): Promise<void> {
  return printer.type === 'tcp' ? printTcp(printer, bytes) : printWindows(printer.printer, bytes);
}

/**
 * Imprime a TODAS las impresoras de la estación (ej. cocina con 2).
 * Éxito si al menos una imprimió; las que fallen se reportan en `errors`.
 */
async function dispatch(printers: PrinterConfig[], bytes: Uint8Array): Promise<{ printed: number; errors: string[] }> {
  const results = await Promise.allSettled(printers.map((p) => dispatchOne(p, bytes)));
  const errors = results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason as Error).message);
  const printed = results.length - errors.length;
  if (printed === 0) {
    throw new Error(errors.join(' | ') || 'ninguna impresora respondió');
  }
  return { printed, errors };
}

// ── HTTP ─────────────────────────────────────────────────────────────────

// ══════════════════════════════════════════════════════════════════════════
// ██  SEGURIDAD — TANQUE DE GUERRA                                      ██
// ══════════════════════════════════════════════════════════════════════════

// 1. CORS estricto — solo orígenes Fullsite, NUNCA wildcard
const ALLOWED_ORIGINS = [
  'https://app.fullsite.mx',
  'https://fullsite.mx',
  'http://localhost:3000',
  'http://localhost:3001',
];

function setCors(req: IncomingMessage, res: ServerResponse): boolean {
  const origin = req.headers.origin || '';
  const allowed = !origin || ALLOWED_ORIGINS.some(o => origin.startsWith(o));

  if (allowed) {
    res.setHeader('Access-Control-Allow-Origin', origin || ALLOWED_ORIGINS[0]);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Token');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  // Security headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');

  return allowed;
}

// 2. Rate limiting — 120 requests/min normal, 10/min en ráfaga (burst protection)
const rateWindow: number[] = [];
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const burstWindow: number[] = [];
const BURST_WINDOW_MS = 2_000;
const BURST_MAX = 10;

function checkRateLimit(): boolean {
  const now = Date.now();
  // Clean old entries
  while (rateWindow.length > 0 && rateWindow[0] < now - RATE_WINDOW_MS) rateWindow.shift();
  while (burstWindow.length > 0 && burstWindow[0] < now - BURST_WINDOW_MS) burstWindow.shift();
  // Check
  if (rateWindow.length >= RATE_MAX || burstWindow.length >= BURST_MAX) return false;
  rateWindow.push(now);
  burstWindow.push(now);
  return true;
}

// 3. Request validation — only allow known routes, known methods
const VALID_ROUTES = new Set(['/health', '/print', '/drawer']);
const VALID_METHODS = new Set(['GET', 'POST', 'OPTIONS']);

function isValidRequest(method: string, url: string): boolean {
  if (!VALID_METHODS.has(method)) return false;
  if (method === 'OPTIONS') return true;
  if (method === 'GET' && url === '/health') return true;
  if (method === 'POST' && (url === '/print' || url === '/drawer')) return true;
  return false;
}

// 4. Input sanitization — validate base64 data doesn't contain injection
function isValidBase64(data: string): boolean {
  if (data.length > 500_000) return false; // 500KB max for a ticket
  return /^[A-Za-z0-9+/=\s]+$/.test(data);
}

// 5. Audit log — every request gets logged
function auditLog(method: string, url: string, status: number, detail: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${method} ${url} → ${status} ${detail}`);
}

// 6. Connection timeout — kill slow/hanging connections
const CONNECTION_TIMEOUT_MS = 10_000;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1 * 1024 * 1024) { // 1MB max — tickets son pequeños
        reject(new Error('payload demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const method = req.method ?? 'UNKNOWN';
  const url = req.url ?? '/';

  // Connection timeout
  req.setTimeout(CONNECTION_TIMEOUT_MS, () => { req.destroy(); });
  res.setTimeout(CONNECTION_TIMEOUT_MS, () => { res.destroy(); });

  // Layer 1: CORS check — reject unknown origins
  const originAllowed = setCors(req, res);
  if (!originAllowed && req.headers.origin) {
    auditLog(method, url, 403, `BLOCKED origin: ${req.headers.origin}`);
    json(res, 403, { ok: false, error: 'Origin no autorizado' });
    return;
  }

  // Layer 2: Preflight
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Layer 3: Method + Route validation
  if (!isValidRequest(method, url)) {
    auditLog(method, url, 405, 'BLOCKED invalid route/method');
    json(res, 405, { ok: false, error: 'Metodo o ruta no permitida' });
    return;
  }

  // Layer 4: Rate limit
  if (!checkRateLimit()) {
    auditLog(method, url, 429, 'BLOCKED rate limit');
    json(res, 429, { ok: false, error: 'Demasiados requests' });
    return;
  }

  try {
    // Layer 5: Health (read-only, no side effects)
    if (method === 'GET' && url === '/health') {
      auditLog(method, url, 200, 'health check');
      json(res, 200, {
        ok: true,
        service: 'fullsite-print-bridge',
        version: '1.1.0',
        stations: Object.keys(config.stations),
        default: config.default ?? null,
        uptime: Math.floor(process.uptime()),
      });
      return;
    }

    // Layer 6: Parse + validate body
    if (method === 'POST' && (url === '/print' || url === '/drawer')) {
      const body = (await readBody(req)) || '{}';
      let parsed: { station?: string; data?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        auditLog(method, url, 400, 'invalid JSON');
        json(res, 400, { ok: false, error: 'body no es JSON' });
        return;
      }

      // Layer 7: Station validation
      const resolved = resolvePrinter(config, parsed.station ?? null);
      if (!resolved) {
        auditLog(method, url, 404, `unknown station: ${parsed.station}`);
        json(res, 404, { ok: false, error: `estación desconocida: ${parsed.station ?? '(ninguna)'}` });
        return;
      }

      let bytes: Uint8Array;
      if (url === '/drawer') {
        bytes = DRAWER_KICK;
      } else {
        if (!parsed.data) {
          auditLog(method, url, 400, 'missing data');
          json(res, 400, { ok: false, error: 'falta "data" (ESC/POS en base64)' });
          return;
        }
        // Layer 8: Input validation — base64 format check
        if (!isValidBase64(parsed.data)) {
          auditLog(method, url, 400, 'BLOCKED invalid base64 / too large');
          json(res, 400, { ok: false, error: 'data inválida o demasiado grande' });
          return;
        }
        try {
          bytes = decodeBase64(parsed.data);
        } catch (e) {
          auditLog(method, url, 400, `decode error: ${(e as Error).message}`);
          json(res, 400, { ok: false, error: (e as Error).message });
          return;
        }
      }

      // Layer 9: Dispatch to printer
      const { printed, errors } = await dispatch(resolved.printers, bytes);
      auditLog(method, url, 200, `${resolved.station} (${bytes.length}B, ${printed}/${resolved.printers.length} ok)${errors.length ? ' PARTIAL: ' + errors.join(' | ') : ''}`);
      json(res, 200, { ok: true, station: resolved.station, bytes: bytes.length, printed, ...(errors.length ? { errors } : {}) });
      return;
    }

    auditLog(method, url, 404, 'BLOCKED unknown route');
    json(res, 404, { ok: false, error: 'ruta desconocida' });
  } catch (e) {
    const msg = (e as Error).message;
    auditLog(method, url, 502, `ERROR: ${msg}`);
    // Never leak internal error details to client
    json(res, 502, { ok: false, error: 'Error interno del bridge' });
  }
});

// Graceful shutdown
process.on('SIGINT', () => { console.log('\n[bridge] Shutting down...'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Fullsite print bridge en http://127.0.0.1:${config.port}`);
  console.log(`  estaciones: ${Object.keys(config.stations).join(', ')}${config.default ? ` (default: ${config.default})` : ''}`);
});

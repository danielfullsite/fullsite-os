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

// ── Seguridad ────────────────────────────────────────────────────────────

// Solo aceptar requests de orígenes Fullsite (POS)
const ALLOWED_ORIGINS = [
  'https://app.fullsite.mx',
  'https://fullsite.mx',
  'http://localhost:3000',
  'http://localhost:3001',
];

function setCors(req: IncomingMessage, res: ServerResponse): void {
  const origin = req.headers.origin || '';
  // Solo permitir orígenes Fullsite — no wildcard
  if (ALLOWED_ORIGINS.some(o => origin.startsWith(o)) || !origin) {
    res.setHeader('Access-Control-Allow-Origin', origin || ALLOWED_ORIGINS[0]);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Bridge-Token');
  // Private Network Access: Chrome lo exige para https://pos → http://127.0.0.1.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

// Rate limiting: max 60 requests per minute
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
function checkRateLimit(): boolean {
  const now = Date.now();
  const key = 'local';
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= 60) return false;
  entry.count++;
  return true;
}

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
  setCors(req, res);
  const url = req.url ?? '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // Rate limit
  if (!checkRateLimit()) {
    json(res, 429, { ok: false, error: 'Demasiados requests — espera un momento' });
    return;
  }

  try {
    if (req.method === 'GET' && url === '/health') {
      json(res, 200, {
        ok: true,
        service: 'fullsite-print-bridge',
        stations: Object.keys(config.stations),
        default: config.default ?? null,
      });
      return;
    }

    if (req.method === 'POST' && (url === '/print' || url === '/drawer')) {
      const body = (await readBody(req)) || '{}';
      let parsed: { station?: string; data?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        json(res, 400, { ok: false, error: 'body no es JSON' });
        return;
      }

      const resolved = resolvePrinter(config, parsed.station ?? null);
      if (!resolved) {
        json(res, 404, { ok: false, error: `estación desconocida: ${parsed.station ?? '(ninguna)'} y no hay default` });
        return;
      }

      let bytes: Uint8Array;
      if (url === '/drawer') {
        bytes = DRAWER_KICK;
      } else {
        if (!parsed.data) {
          json(res, 400, { ok: false, error: 'falta "data" (ESC/POS en base64)' });
          return;
        }
        try {
          bytes = decodeBase64(parsed.data);
        } catch (e) {
          json(res, 400, { ok: false, error: (e as Error).message });
          return;
        }
      }

      const { printed, errors } = await dispatch(resolved.printers, bytes);
      console.log(
        `[${new Date().toISOString()}] ${url} → ${resolved.station} (${bytes.length} bytes, ${printed}/${resolved.printers.length} impresoras) OK` +
        (errors.length ? ` — fallas: ${errors.join(' | ')}` : ''),
      );
      json(res, 200, { ok: true, station: resolved.station, bytes: bytes.length, printed, ...(errors.length ? { errors } : {}) });
      return;
    }

    json(res, 404, { ok: false, error: 'ruta desconocida' });
  } catch (e) {
    const msg = (e as Error).message;
    console.error(`[${new Date().toISOString()}] ${url} ERROR: ${msg}`);
    json(res, 502, { ok: false, error: msg });
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`Fullsite print bridge en http://127.0.0.1:${config.port}`);
  console.log(`  estaciones: ${Object.keys(config.stations).join(', ')}${config.default ? ` (default: ${config.default})` : ''}`);
});

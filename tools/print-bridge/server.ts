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
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
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

const here = dirname(fileURLToPath(import.meta.url));
const configPath = process.argv[2] ?? join(here, 'printers.json');

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
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(here, 'raw-print.ps1'), '-PrinterName', printerName, '-FilePath', file],
      { timeout: 15000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`raw-print.ps1 falló: ${stderr || err.message}`));
        else resolve();
      },
    );
  });
}

function dispatch(printer: PrinterConfig, bytes: Uint8Array): Promise<void> {
  return printer.type === 'tcp' ? printTcp(printer, bytes) : printWindows(printer.printer, bytes);
}

// ── HTTP ─────────────────────────────────────────────────────────────────

function setCors(res: ServerResponse): void {
  // El bridge solo escucha en 127.0.0.1; CORS abierto es seguro aquí.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Private Network Access: Chrome lo exige para https://pos → http://127.0.0.1.
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
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
      if (size > 5 * 1024 * 1024) {
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
  setCors(res);
  const url = req.url ?? '/';

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
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

      await dispatch(resolved.printer, bytes);
      console.log(`[${new Date().toISOString()}] ${url} → ${resolved.station} (${bytes.length} bytes) OK`);
      json(res, 200, { ok: true, station: resolved.station, bytes: bytes.length });
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

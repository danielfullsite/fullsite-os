// Tests del print bridge: lógica pura (lib) + E2E con impresora TCP falsa.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseConfig,
  resolvePrinter,
  decodeBase64,
  DRAWER_KICK,
  ConfigError,
} from '../tools/print-bridge/lib.js';

describe('print bridge — config', () => {
  it('parsea config válida con tcp y windows', () => {
    const c = parseConfig({
      port: 7717,
      stations: {
        cocina: { type: 'tcp', host: '192.168.1.50', port: 9100 },
        caja: { type: 'windows', printer: 'POS-80' },
      },
      default: 'caja',
    });
    expect(c.port).toBe(7717);
    expect(c.default).toBe('caja');
    expect(Object.keys(c.stations)).toEqual(['cocina', 'caja']);
  });

  it('default al puerto 7717 si no se especifica', () => {
    const c = parseConfig({ stations: { caja: { type: 'windows', printer: 'X' } } });
    expect(c.port).toBe(7717);
  });

  it('rechaza tcp sin host', () => {
    expect(() => parseConfig({ stations: { cocina: { type: 'tcp' } } })).toThrow(ConfigError);
  });

  it('rechaza windows sin nombre de impresora', () => {
    expect(() => parseConfig({ stations: { caja: { type: 'windows' } } })).toThrow(ConfigError);
  });

  it('rechaza default que no es estación', () => {
    expect(() =>
      parseConfig({ stations: { caja: { type: 'windows', printer: 'X' } }, default: 'cocina' }),
    ).toThrow(ConfigError);
  });

  it('rechaza stations vacío', () => {
    expect(() => parseConfig({ stations: {} })).toThrow(ConfigError);
  });

  it('normaliza estación con una impresora a arreglo', () => {
    const c = parseConfig({ stations: { caja: { type: 'windows', printer: 'X' } } });
    expect(c.stations.caja).toHaveLength(1);
  });

  it('acepta estación con varias impresoras (cocina x2)', () => {
    const c = parseConfig({
      stations: {
        cocina: [
          { type: 'tcp', host: '192.168.1.50' },
          { type: 'tcp', host: '192.168.1.51' },
        ],
      },
    });
    expect(c.stations.cocina).toHaveLength(2);
  });

  it('rechaza estación con arreglo vacío', () => {
    expect(() => parseConfig({ stations: { cocina: [] } })).toThrow(ConfigError);
  });

  it('rechaza impresora inválida dentro del arreglo', () => {
    expect(() =>
      parseConfig({ stations: { cocina: [{ type: 'tcp', host: '1.1.1.1' }, { type: 'tcp' }] } }),
    ).toThrow(ConfigError);
  });
});

describe('print bridge — resolución de estación', () => {
  const config = parseConfig({
    stations: {
      cocina: { type: 'tcp', host: '10.0.0.1' },
      caja: { type: 'windows', printer: 'POS-80' },
    },
    default: 'caja',
  });

  it('estación conocida → su impresora', () => {
    const r = resolvePrinter(config, 'cocina');
    expect(r?.station).toBe('cocina');
    expect(r?.printers).toHaveLength(1);
  });

  it('estación desconocida → default', () => {
    expect(resolvePrinter(config, 'barra')?.station).toBe('caja');
  });

  it('sin estación → default', () => {
    expect(resolvePrinter(config, null)?.station).toBe('caja');
  });

  it('sin default y varias estaciones → null', () => {
    const c = parseConfig({
      stations: {
        a: { type: 'tcp', host: '1.1.1.1' },
        b: { type: 'tcp', host: '2.2.2.2' },
      },
    });
    expect(resolvePrinter(c, 'zzz')).toBeNull();
  });

  it('sin default pero única estación → esa', () => {
    const c = parseConfig({ stations: { caja: { type: 'windows', printer: 'X' } } });
    expect(resolvePrinter(c, null)?.station).toBe('caja');
  });
});

describe('print bridge — base64', () => {
  it('decodifica bytes ESC/POS', () => {
    const original = new Uint8Array([0x1b, 0x40, 0x48, 0x6f, 0x6c, 0x61, 0x0a]);
    const decoded = decodeBase64(Buffer.from(original).toString('base64'));
    expect([...decoded]).toEqual([...original]);
  });

  it('rechaza vacío', () => {
    expect(() => decodeBase64('')).toThrow();
  });
});

// ── E2E: bridge real + impresora TCP falsa ───────────────────────────────

describe('print bridge — E2E con impresora TCP falsa', () => {
  const BRIDGE_PORT = 17717;
  const PRINTER_PORT = 19100;
  const PRINTER2_PORT = 19101;
  let fakePrinter: NetServer;
  let fakePrinter2: NetServer;
  let bridge: ChildProcess;
  const received: Buffer[] = [];
  const received2: Buffer[] = [];

  beforeAll(async () => {
    // Impresoras falsas: capturan todo lo que llega por TCP.
    fakePrinter = createNetServer((socket) => {
      socket.on('data', (chunk: Buffer) => received.push(chunk));
    });
    await new Promise<void>((r) => fakePrinter.listen(PRINTER_PORT, '127.0.0.1', r));
    fakePrinter2 = createNetServer((socket) => {
      socket.on('data', (chunk: Buffer) => received2.push(chunk));
    });
    await new Promise<void>((r) => fakePrinter2.listen(PRINTER2_PORT, '127.0.0.1', r));

    // Config temporal: cocina con DOS impresoras (fan-out), default cocina.
    const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
    const configPath = join(dir, 'printers.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        port: BRIDGE_PORT,
        stations: {
          cocina: [
            { type: 'tcp', host: '127.0.0.1', port: PRINTER_PORT },
            { type: 'tcp', host: '127.0.0.1', port: PRINTER2_PORT },
          ],
        },
        default: 'cocina',
      }),
    );

    bridge = spawn(process.execPath, ['tools/print-bridge/server.ts', configPath], {
      cwd: join(import.meta.dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Esperar a que escuche.
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('bridge no arrancó')), 10000);
      bridge.stdout!.on('data', (d: Buffer) => {
        if (d.toString().includes('print bridge en')) {
          clearTimeout(t);
          resolve();
        }
      });
      bridge.stderr!.on('data', (d: Buffer) => console.error('bridge stderr:', d.toString()));
      bridge.on('exit', (code) => reject(new Error(`bridge salió con ${code}`)));
    });
  }, 15000);

  afterAll(async () => {
    bridge?.kill();
    await new Promise<void>((r) => fakePrinter.close(() => r()));
    await new Promise<void>((r) => fakePrinter2.close(() => r()));
  });

  it('GET /health reporta estaciones', async () => {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.stations).toEqual(['cocina']);
    expect(body.default).toBe('cocina');
    // Headers CORS + PNA presentes.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('OPTIONS preflight responde 204 con PNA', async () => {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/print`, { method: 'OPTIONS' });
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-private-network')).toBe('true');
  });

  it('POST /print entrega los bytes exactos a LAS DOS impresoras de cocina', async () => {
    received.length = 0;
    received2.length = 0;
    const escpos = new Uint8Array([0x1b, 0x40, 0x54, 0x49, 0x43, 0x4b, 0x45, 0x54, 0x0a, 0x1d, 0x56, 0x42, 0x00]);
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ station: 'cocina', data: Buffer.from(escpos).toString('base64') }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.bytes).toBe(escpos.length);
    expect(body.printed).toBe(2);
    // Dar tiempo a que los sockets entreguen.
    await new Promise((r) => setTimeout(r, 200));
    expect([...Buffer.concat(received)]).toEqual([...escpos]);
    expect([...Buffer.concat(received2)]).toEqual([...escpos]);
  });

  it('POST /drawer manda el kick ESC/POS', async () => {
    received.length = 0;
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/drawer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 200));
    expect([...Buffer.concat(received)]).toEqual([...DRAWER_KICK]);
  });

  it('POST /print sin data → 400', async () => {
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ station: 'cocina' }),
    });
    expect(res.status).toBe(400);
  });

  it('una impresora de la estación caída → 200 parcial con errores', async () => {
    // Apagar solo la primera impresora de cocina.
    await new Promise<void>((r) => fakePrinter.close(() => r()));
    received2.length = 0;
    const payload = new Uint8Array([0x0a]);
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: Buffer.from(payload).toString('base64') }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.printed).toBe(1);
    expect(body.errors).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 200));
    expect([...Buffer.concat(received2)]).toEqual([...payload]);
  });

  it('TODAS las impresoras caídas → 502 con error', async () => {
    await new Promise<void>((r) => fakePrinter2.close(() => r()));
    const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/print`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data: Buffer.from([0x0a]).toString('base64') }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.ok).toBe(false);
    // Revivirlas para afterAll.
    fakePrinter = createNetServer((socket) => socket.on('data', (c: Buffer) => received.push(c)));
    await new Promise<void>((r) => fakePrinter.listen(PRINTER_PORT, '127.0.0.1', r));
    fakePrinter2 = createNetServer((socket) => socket.on('data', (c: Buffer) => received2.push(c)));
    await new Promise<void>((r) => fakePrinter2.listen(PRINTER2_PORT, '127.0.0.1', r));
  });
});

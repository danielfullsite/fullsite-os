// Print bridge — lógica pura (sin red, sin filesystem) para poder testearla.
//
// El bridge es un servicio local en la terminal Windows de AMALAY (la misma
// donde corría Wansoft). El POS en el browser le manda bytes ESC/POS por
// HTTP localhost y el bridge los entrega a la impresora (TCP :9100 o cola
// de Windows vía PowerShell). Módulo `device` del OS.

export type PrinterType = 'tcp' | 'windows';

export interface TcpPrinter {
  type: 'tcp';
  host: string; // IP de la impresora de red
  port?: number; // default 9100 (RAW)
}

export interface WindowsPrinter {
  type: 'windows';
  printer: string; // nombre exacto de la impresora en Windows
}

export type PrinterConfig = TcpPrinter | WindowsPrinter;

export interface BridgeConfig {
  port: number; // puerto HTTP del bridge (default 7717)
  // Cada estación puede tener 1+ impresoras (ej. cocina con 2: el ticket
  // sale en todas). En printers.json se acepta objeto o arreglo; aquí ya
  // viene normalizado a arreglo.
  stations: Record<string, PrinterConfig[]>;
  default?: string; // estación a usar cuando no se especifica o no existe
}

export const DEFAULT_BRIDGE_PORT = 7717;
export const DEFAULT_RAW_PORT = 9100;

// Kick de cajón ESC/POS: ESC p m t1 t2 (pin 2, 50ms/250ms).
// Mismos bytes que usa el POS por Bluetooth (openCashDrawer).
export const DRAWER_KICK = new Uint8Array([0x1b, 0x70, 0x00, 0x19, 0xfa]);

export class ConfigError extends Error {}

function validatePrinter(name: string, p: unknown): PrinterConfig {
  if (typeof p !== 'object' || p === null) {
    throw new ConfigError(`stations.${name}: debe ser un objeto`);
  }
  const o = p as Record<string, unknown>;
  if (o.type === 'tcp') {
    if (typeof o.host !== 'string' || o.host.length === 0) {
      throw new ConfigError(`stations.${name}: impresora tcp requiere "host"`);
    }
    if (o.port !== undefined && (typeof o.port !== 'number' || !Number.isInteger(o.port) || o.port < 1 || o.port > 65535)) {
      throw new ConfigError(`stations.${name}: "port" inválido`);
    }
    return { type: 'tcp', host: o.host, ...(o.port !== undefined ? { port: o.port as number } : {}) };
  }
  if (o.type === 'windows') {
    if (typeof o.printer !== 'string' || o.printer.length === 0) {
      throw new ConfigError(`stations.${name}: impresora windows requiere "printer" (nombre en Windows)`);
    }
    return { type: 'windows', printer: o.printer };
  }
  throw new ConfigError(`stations.${name}: "type" debe ser "tcp" o "windows"`);
}

function validateStation(name: string, p: unknown): PrinterConfig[] {
  if (Array.isArray(p)) {
    if (p.length === 0) {
      throw new ConfigError(`stations.${name}: el arreglo de impresoras no puede estar vacío`);
    }
    return p.map((item, i) => validatePrinter(`${name}[${i}]`, item));
  }
  return [validatePrinter(name, p)];
}

/** Valida y normaliza printers.json. Lanza ConfigError con mensaje accionable. */
export function parseConfig(raw: unknown): BridgeConfig {
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError('printers.json debe ser un objeto JSON');
  }
  const o = raw as Record<string, unknown>;
  const port = o.port === undefined ? DEFAULT_BRIDGE_PORT : o.port;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError('"port" inválido (1-65535)');
  }
  if (typeof o.stations !== 'object' || o.stations === null || Array.isArray(o.stations)) {
    throw new ConfigError('"stations" debe ser un objeto { nombre: impresora }');
  }
  const stations: Record<string, PrinterConfig[]> = {};
  for (const [name, p] of Object.entries(o.stations as Record<string, unknown>)) {
    stations[name] = validateStation(name, p);
  }
  if (Object.keys(stations).length === 0) {
    throw new ConfigError('"stations" no puede estar vacío');
  }
  let def: string | undefined;
  if (o.default !== undefined) {
    if (typeof o.default !== 'string' || !(o.default in stations)) {
      throw new ConfigError(`"default" debe ser una estación existente (${Object.keys(stations).join(', ')})`);
    }
    def = o.default;
  }
  return { port, stations, ...(def ? { default: def } : {}) };
}

/**
 * Resuelve estación → impresora(s). Si la estación no existe (o no se manda),
 * cae al default. Devuelve null si no hay forma de imprimir.
 */
export function resolvePrinter(
  config: BridgeConfig,
  station?: string | null,
): { station: string; printers: PrinterConfig[] } | null {
  const direct = station ? config.stations[station] : undefined;
  if (station && direct) {
    return { station, printers: direct };
  }
  const fallback = config.default ? config.stations[config.default] : undefined;
  if (config.default && fallback) {
    return { station: config.default, printers: fallback };
  }
  // Sin default explícito: si solo hay una estación, úsala.
  const names = Object.keys(config.stations);
  const only = names.length === 1 ? names[0] : undefined;
  const onlyPrinters = only ? config.stations[only] : undefined;
  if (only && onlyPrinters) {
    return { station: only, printers: onlyPrinters };
  }
  return null;
}

/** Decodifica el payload base64 de /print. Lanza si no es base64 válido. */
export function decodeBase64(data: string): Uint8Array {
  if (typeof data !== 'string' || data.length === 0) {
    throw new Error('data vacío');
  }
  // Buffer es permisivo; validamos round-trip para rechazar basura.
  const buf = Buffer.from(data, 'base64');
  if (buf.length === 0) throw new Error('data no es base64 válido');
  return new Uint8Array(buf);
}

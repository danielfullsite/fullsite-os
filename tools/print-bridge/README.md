# Fullsite Print Bridge (módulo `device`)

Servicio local que corre en la terminal Windows del restaurante y conecta el
POS (browser) con las impresoras térmicas y el cajón de dinero.

```
POS (https://...vercel.app)  ──HTTP──►  http://127.0.0.1:7717  ──►  impresora
```

- Localhost está **exento de mixed-content** en Chrome/Edge: la página HTTPS
  puede llamar a `http://127.0.0.1` sin problema.
- El bridge solo escucha en `127.0.0.1` — nada entra desde la red.
- Soporta **Private Network Access** (header `Access-Control-Allow-Private-Network`).

## Endpoints

| Método | Ruta | Body | Hace |
|---|---|---|---|
| GET | `/health` | — | `{ ok, stations, default }` (el POS lo usa para detectar el bridge) |
| POST | `/print` | `{ "station": "cocina", "data": "<base64>" }` | Manda los bytes ESC/POS a la impresora de esa estación |
| POST | `/drawer` | `{ "station": "caja" }` | Kick de cajón (`ESC p 0 25 250`) vía la impresora |

`station` es opcional: sin ella (o si no existe) cae al `default` del config.

## Configuración — `printers.json`

Copia `printers.example.json` a `printers.json` junto al ejecutable:

```json
{
  "port": 7717,
  "stations": {
    "cocina": { "type": "tcp", "host": "192.168.1.50", "port": 9100 },
    "caja":   { "type": "windows", "printer": "POS-80" }
  },
  "default": "caja"
}
```

- `tcp` — impresora de red (Ethernet/WiFi), protocolo RAW puerto 9100.
- `windows` — impresora USB instalada en Windows; `printer` es el **nombre
  exacto de la cola** (`Get-Printer | Select Name` en PowerShell). Usa el
  driver del fabricante o "Generic / Text Only".

## Correr en desarrollo (Mac/Linux)

```bash
cp tools/print-bridge/printers.example.json tools/print-bridge/printers.json
npm run bridge            # node tools/print-bridge/server.ts
curl http://127.0.0.1:7717/health
```

## Instalar en la terminal de AMALAY (Windows)

1. Compilar el ejecutable (desde Mac, cross-compile):
   ```bash
   bun build tools/print-bridge/server.ts --compile --target=bun-windows-x64 --outfile fullsite-print-bridge.exe
   ```
2. Crear carpeta `C:\fullsite\` y copiar:
   - `fullsite-print-bridge.exe`
   - `printers.json` (ajustado a las impresoras reales)
   - `raw-print.ps1` (solo si hay impresoras `windows`/USB)
3. Probar a mano: doble click al .exe → abrir `http://127.0.0.1:7717/health`
   en el browser de la terminal.
4. Autoarranque: crear acceso directo al .exe en
   `shell:startup` (Win+R → `shell:startup`). Para algo más robusto, usar
   [NSSM](https://nssm.cc) y registrarlo como servicio de Windows:
   ```
   nssm install FullsitePrintBridge C:\fullsite\fullsite-print-bridge.exe
   ```

## Notas

- Los bytes que viajan en `data` los genera el POS (`src/lib/printer.ts` del
  dashboard) — el bridge no sabe de tickets, solo entrega bytes. Frontera de
  módulo: `device` transporta, `orders/kitchen` deciden qué se imprime.
- El kick de cajón usa los mismos bytes que la ruta Bluetooth del POS.
- Timeouts: 5s para TCP, 15s para PowerShell. El POS hace fallback a
  Bluetooth/CSS si el bridge no responde.

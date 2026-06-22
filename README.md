# Dotrino Tunnel — túnel reverso (ngrok autohospedado)

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Tu URL, en tu servidor, bajo tus reglas — sin anuncios, sin cookies, sin rastreo.

Expón un puerto/servicio local en una **URL pública** (`https://r.dotrino.com/<llave>/…`)
sin abrir puertos ni configurar tu router. Un **relay** público recibe las requests y
las reenvía por WebSocket a tu **agente** (tu máquina o el navegador); la respuesta
vuelve al cliente. Tipo ngrok, pero autohospedado y parte del ecosistema.

La **llave** (secreto de alta entropía) va en la URL: identifica el túnel y autoriza al
agente. *Quien tenga la URL puede usar el túnel* → es un tool de dev/testing. Payload
limitado a **1 MB** por request/response; timeout 30 s.

## Dos sabores

### 1) Librería de Node + CLI — [`@dotrino/tunnel`](./lib)
Expón un puerto/handler local desde código o terminal.

```sh
npx @dotrino/tunnel 3000                 # expone http://localhost:3000
npx @dotrino/tunnel http://localhost:8080/api --key MiLlave16aMasAlfanum
```
```js
import { createTunnel } from '@dotrino/tunnel'
const t = await createTunnel({ target: 3000 })   // o target: 'http://…' o (req)=>({status,headers,body})
console.log(t.url)                                // https://r.dotrino.com/<llave>
// t.close()
```

### 2) Web de testing — `https://r.dotrino.com`
El **navegador es el endpoint**: obtienes una URL pública, ves en vivo las requests que
entran (método, ruta, cabeceras, cuerpo) y configuras qué responder (respuesta fija o
modo *eco*). Ideal para probar webhooks sin levantar nada local.

## Estructura del repo
- **`server/`** — el relay (Node + `ws`). Sirve además la web de testing en `/`.
- **`lib/`** — el paquete npm `@dotrino/tunnel` (lib + CLI).
- **`web/`** — la web de testing (Vite + Vue), se construye y la sirve el relay.

## Arquitectura
```
 cliente HTTP ──▶ r.dotrino.com/<llave>/ruta ──▶ [relay] ──WS──▶ [agente] ──▶ localhost:3000
                                              ◀── respuesta ◀──────────────◀──
```
El agente (lib/CLI o navegador) conecta a `wss://r.dotrino.com/_agent?key=<llave>` y
queda registrado. Heartbeat cada 30 s (sobrevive a cortes de WS ocioso).

Sin anuncios, sin cuentas, sin rastreo. MIT.

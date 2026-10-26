# Dotrino Tunnel — túnel reverso autohospedado

> **Parte del ecosistema [Dotrino](https://dotrino.com).** Tu URL, en tu servidor, bajo tus reglas — sin anuncios, sin cookies, sin rastreo.

Expón un puerto/servicio local en una **URL pública** (`https://r.dotrino.com/<llave>/…`)
sin abrir puertos ni configurar tu router. Un **relay** público recibe las requests y
las reenvía por WebSocket a tu **agente** (tu máquina o el navegador); la respuesta
vuelve al cliente. Autohospedado y parte del ecosistema.

**Cada túnel es un aparato de tu cuenta.** Se enrola una vez en tu bóveda (como cualquier
otro aparato) y la dirección pública sale de **su propia llave**: nadie la elige. Para
atenderla, el agente firma un reto del relay con esa llave y trae la cadena del acta que
dice que el aparato es de tu cuenta y puede firmar. Así no hay dos túneles con la misma
dirección ni nadie puede atender la de otro. **Más túneles = más aparatos** en la bóveda
(`--name`). Quien tenga la URL puede *mandarle* peticiones: sigue siendo un tool de
dev/testing. Payload limitado a **1 MB** por request/response; timeout 30 s.

## Dos sabores

### 1) Librería de Node + CLI — [`@dotrino/tunnel`](./lib)
Expón un puerto/handler local desde código o terminal.

```sh
npx @dotrino/tunnel 3000                          # la primera vez lo enrola en tu bóveda
npx @dotrino/tunnel http://localhost:8080/api --name api   # otro túnel = otro aparato
npx @dotrino/tunnel info                          # su ID, el de «dotrino-vault members»
```
```js
import { createTunnel } from '@dotrino/tunnel'
const t = await createTunnel({ target: 3000 })   // o target: 'http://…' o (req)=>({status,headers,body})
console.log(t.url)                                // https://r.dotrino.com/<llave del aparato>
// t.close()
```

### 2) Web de testing — `https://r.dotrino.com`
El **navegador es el endpoint** (y el aparato: su URL sale de la llave de tu perfil en
ese navegador): obtienes una URL pública, ves en vivo las requests que
entran (método, ruta, cabeceras, cuerpo) y configuras qué responder (respuesta fija o
modo *eco*). Ideal para probar webhooks sin levantar nada local.

## Estructura del repo
- **`server/`** — el relay (Node + `ws`). Sirve además la web de testing en `/`.

## Despliegue del relay (VPS de proxy, `74.208.192.49`)

Corre con **PM2**, igual que `cc-proxy` y el signer. Hasta el 2026-07-27 se arrancaba a
mano: se cayó y `r.dotrino.com` estuvo devolviendo **502** sin que nada lo levantara.

```sh
cd ~/dotrino-tunnel && git pull            # traer cambios
cd web && npm ci && npm run build          # la web de testing la sirve el relay
cd ../server && npm ci                     # el relay verifica con @dotrino/identity
STATIC_DIR=$HOME/dotrino-tunnel/web/dist PORT=7700 \
  pm2 start index.js --name dotrino-tunnel --time
pm2 save                                   # sin esto no vuelve tras un reinicio
```

Dos cosas que hay que saber:

- **`STATIC_DIR` es obligatorio.** Por defecto el relay sirve `server/public`, que **no
  existe** en el repo: la web vive en `web/dist`. Sin esa variable, `/` no sirve nada.
- **nginx manda `r.dotrino.com` a `127.0.0.1:7700`** (`/etc/nginx/sites-enabled/r.dotrino.com`).
  Si cambias `PORT`, cambia también ahí.

Actualizar: `git pull`, `npm ci && npm run build` en `web/`, `npm ci` en `server/` y `pm2 restart dotrino-tunnel`.
- **`lib/`** — el paquete npm `@dotrino/tunnel` (lib + CLI).
- **`web/`** — la web de testing (Vite + Vue), se construye y la sirve el relay.

## Arquitectura
```
 cliente HTTP ──▶ r.dotrino.com/<llave>/ruta ──▶ [relay] ──WS──▶ [agente] ──▶ localhost:3000
                                              ◀── respuesta ◀──────────────◀──
```
El agente (lib/CLI o navegador) conecta a `wss://r.dotrino.com/_agent`. El relay le manda
un reto (`challenge`), el agente contesta con `signedFor` de `@dotrino/identity/assertion`
(`op: 'tunnel-agent'`, `aud` = el origen del relay) y el relay lo comprueba con
`verifySignedFor`: firma del aparato, cadena del acta, permiso `sign`. La llave del túnel es
`tunnelKey(publickey)` (SHA-256 de la pública, 32 base62, en `lib/shared.js`). Un rechazo
cierra con 4003 y el motivo; el mismo aparato en dos procesos, con 4001. El relay recuerda
el `seq` más alto visto por cuenta y no acepta cadenas más viejas. Heartbeat cada 30 s
(sobrevive a cortes de WS ocioso).

Sin anuncios, sin cuentas, sin rastreo. MIT.

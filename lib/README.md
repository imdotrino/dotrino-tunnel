# @dotrino/tunnel

Túnel reverso (ngrok autohospedado) del ecosistema [Dotrino](https://dotrino.com).
Expón un puerto o servicio local en una URL pública — como código o como CLI.

## CLI

```sh
npx @dotrino/tunnel 3000                       # expone http://localhost:3000
npx @dotrino/tunnel http://localhost:8080/api  # expone esa URL local
npx @dotrino/tunnel 3000 --key <llave 16-48 alfanum>
npx @dotrino/tunnel 3000 --server https://r.dotrino.com
```
Imprime tu URL pública (`https://r.dotrino.com/<llave>`) y registra cada request.

## Librería

```js
import { createTunnel } from '@dotrino/tunnel'

// 1) exponer un puerto local
const t = await createTunnel({ target: 3000 })
console.log(t.url)            // https://r.dotrino.com/<llave>

// 2) exponer una URL local con base
createTunnel({ target: 'http://localhost:8080/api' })

// 3) responder con un handler (sin servidor local)
createTunnel({ target: (req) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, path: req.path }) }) })

t.close()
```

### Opciones
| opción | descripción |
|---|---|
| `target` | número (puerto), URL string, o función `(req) => { status, headers, body }`. Por defecto `3000`. |
| `key` | llave del túnel (va en la URL). Por defecto se genera (32 alfanum). |
| `server` | relay a usar. Por defecto `https://r.dotrino.com`. |
| `onReady(url)` / `onRequest(req)` | callbacks opcionales. |
| `quiet` | silencia logs. |

`req` = `{ method, path, headers, body }` (body es `Buffer|null`).

## Notas
- La **llave va en la URL pública** e identifica el túnel: quien tenga la URL puede
  usarlo. Es un tool de dev/testing.
- Payload **limitado a 1 MB** por request/response; timeout 30 s.
- Reconecta solo si el WebSocket se cae.

MIT · parte de Dotrino.

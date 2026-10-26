# @dotrino/tunnel

Túnel reverso autohospedado del ecosistema [Dotrino](https://dotrino.com).
Expón un puerto o servicio local en una URL pública — como código o como CLI.

**Cada túnel es un aparato de tu cuenta.** Se enrola una vez en tu bóveda y su dirección
sale de su propia llave: nadie puede elegir la dirección de otro ni atenderla. Para un
segundo túnel, otro aparato (`--name`).

## CLI

```sh
npx @dotrino/tunnel 3000                       # expone http://localhost:3000 (la 1.ª vez lo enrola)
npx @dotrino/tunnel http://localhost:8080/api  # expone esa URL local
npx @dotrino/tunnel 3000 --name api            # otro túnel = otro aparato de tu cuenta
npx @dotrino/tunnel enroll [--name api]        # enrola (o re-enrola) sin abrirlo
npx @dotrino/tunnel info [--name api] [--json] # qué aparato es: su ID
npx @dotrino/tunnel list                       # los túneles enrolados en esta máquina
```

Enrolar pide la invitación de tu bóveda (`dotrino-vault pair`, o el código de
`profile.dotrino.com/myvault`) y un código que escribes en ella para aprobarlo. El aparato
necesita el permiso `firma` (`sign`), que es el que trae por defecto. El enlace vive en
`~/.dotrino/agent/tunnel/<name>/` (o `--dir`).

## Se actualiza solo

Instalado con `npm i -g @dotrino/tunnel` (en un prefijo de tu usuario), el túnel mira una
vez al día si hay versión nueva, la verifica contra el `npm-integrity.json` de su release de
GitHub, la instala y se reinicia si hay quien lo levante (pm2, systemd). Con `npx` lo dice y
no instala nada. Por defecto no pide permiso y avisa a tu bóveda; cada túnel lo cambia:

```sh
dotrino-tunnel update [--name api] --approval on   # pide permiso a tus aparatos «aprueba»
dotrino-tunnel update [--name api] --notify off    # no avisa de que se actualizó
```

## Librería

```js
import { createTunnel, enrollTunnel } from '@dotrino/tunnel'

// 1) exponer un puerto local (el aparato «default», ya enrolado)
const t = await createTunnel({ target: 3000 })
console.log(t.url)            // https://r.dotrino.com/<llave del aparato>

// 2) otro aparato, con una URL local con base
await createTunnel({ name: 'api', target: 'http://localhost:8080/api' })

// 3) responder con un handler (sin servidor local)
await createTunnel({ target: (req) => ({ status: 200, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ok: true, path: req.path }) }) })

t.close()
```

### Opciones
| opción | descripción |
|---|---|
| `target` | número (puerto), URL string, o función `(req) => { status, headers, body }`. Por defecto `3000`. |
| `name` / `dir` | qué aparato (`~/.dotrino/agent/tunnel/<name>`, o una carpeta). |
| `identity` | en vez del enlace del disco: cualquier objeto con `me.publickey` y un `signData` que devuelva la cadena del acta. |
| `server` | relay a usar. Por defecto `https://r.dotrino.com`. |
| `cors` | añade CORS a las respuestas (`'*'` o un origen). |
| `onReady(url)` / `onRequest(req)` | callbacks opcionales. |
| `onRejected(reason, message)` | el relay no aceptó la prueba; el túnel se para. |
| `onReplaced(key)` | otro proceso abrió el mismo aparato; este se para. |
| `quiet` | silencia logs. |

`req` = `{ method, path, headers, body }` (body es `Buffer|null`).

Errores con `code`: `TUNNEL_NOT_ENROLLED`, `TUNNEL_NO_CHAIN` (la bóveda no contestó y no
hay cadena guardada), `TUNNEL_KEY_IN_USE` (ese aparato ya está abierto en esta máquina).

## Cómo se prueba que el túnel es tuyo

1. La dirección es `tunnelKey(publickey)`: SHA-256 de la pública del aparato, 32 base62.
2. Al conectar, el relay manda un reto. El agente lo firma con `signedFor`
   (`@dotrino/identity/assertion`) para el origen del relay, con la cadena del acta.
3. El relay comprueba con `verifySignedFor` que la firma es de esa llave, que la cadena es
   de una cuenta y que el aparato tiene `sign` en ella. Si no, cierra con 4003 y el motivo.

## Notas
- Quien tenga la URL puede mandarle peticiones: es un tool de dev/testing.
- Payload **limitado a 1 MB** por request/response; timeout 30 s.
- Reconecta solo si el WebSocket se cae, y trae la cadena fresca antes de cada intento.

MIT · parte de Dotrino.

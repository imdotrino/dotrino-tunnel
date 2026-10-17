/**
 * Lo que comparten el agente (Node) y la web de pruebas (navegador): sin APIs de Node,
 * para que la web lo importe tal cual. Antes estaba escrito dos veces.
 */

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Bytes aleatorios → llave base62 (un carácter por byte). */
export function keyFromBytes (bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += B62[bytes[i] % 62]
  return s
}

/** La URL por la que el agente se registra en el relay. */
export function agentWsUrl (server, key) {
  const u = new URL(server)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/_agent'
  u.search = '?key=' + key
  return u.toString()
}

/** Cabeceras CORS para un origen permitido; `null` si no hay origen. */
export function corsHeadersFor (origin) {
  const o = String(origin ?? '').trim()
  if (!o) return null
  return {
    'access-control-allow-origin': o,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  }
}

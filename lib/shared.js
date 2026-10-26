/**
 * Lo que comparten el agente (Node), el relay y la web de pruebas (navegador): sin APIs de
 * Node, para que la web lo importe tal cual.
 *
 * UN TÚNEL ES UN APARATO DE TU CUENTA. La dirección pública no la elige nadie: sale de la
 * llave pública del aparato (`tunnelKey`), y para atenderla hay que firmar el reto del relay
 * con esa llave y con la cadena del acta que dice que el aparato es de la cuenta y puede
 * firmar. Así no hay dos túneles con la misma dirección (colisión) ni nadie puede atender
 * la de otro (suplantación). Más túneles = más aparatos en la bóveda.
 */

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

/** Lo que firma el agente: `op` fija para qué sirve la firma (no vale para otra cosa). */
export const AGENT_OP = 'tunnel-agent'
export const AGENT_V = 1
/** Vigencia de la firma del reto: solo tiene que llegar al relay. */
export const AGENT_PROOF_TTL_MS = 60 * 1000

/** Códigos de cierre del WebSocket del agente. */
export const CLOSE_REPLACED = 4001   // otro proceso con la MISMA llave de aparato
export const CLOSE_REJECTED = 4003   // la prueba no vale: el motivo va en la razón del cierre

/** Bytes → texto base62 (un carácter por byte). */
export function keyFromBytes (bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += B62[bytes[i] % 62]
  return s
}

/**
 * La dirección del túnel: SHA-256 de la llave pública del aparato (JWK tal cual la firma),
 * 32 caracteres base62. Es pública: decirla no da nada, atenderla exige la privada.
 */
export async function tunnelKey (publickey) {
  if (typeof publickey !== 'string' || !publickey) throw new Error('tunnelKey: publickey required')
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publickey)))
  return keyFromBytes(h.subarray(0, 32))
}

export const KEY_RE = /^[A-Za-z0-9]{32}$/

/** La URL por la que el agente se registra en el relay. */
export function agentWsUrl (server) {
  const u = new URL(server)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/_agent'
  u.search = ''
  return u.toString()
}

/** El destinatario de la prueba: el origen del relay, el mismo que comprueba él. */
export const relayAudience = (server) => new URL(server).origin

/**
 * Contesta al reto del relay con la identidad del aparato. `signedFor` es el de
 * `@dotrino/identity/assertion`: se pasa desde fuera para que este archivo no arrastre el
 * pilar a la web dos veces.
 */
export async function answerChallenge ({ signedFor, identity, server, challenge }) {
  const p = await signedFor(identity, {
    aud: relayAudience(server),
    ttlMs: AGENT_PROOF_TTL_MS,
    fields: { v: AGENT_V, op: AGENT_OP, challenge }
  })
  return { type: 'hello', ...p }
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

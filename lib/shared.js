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

/**
 * Bytes → texto base62 (un carácter por byte).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function keyFromBytes (bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += B62[bytes[i] % 62]
  return s
}

/**
 * La dirección del túnel: SHA-256 de la llave pública del aparato (JWK tal cual la firma),
 * 32 caracteres base62. Es pública: decirla no da nada, atenderla exige la privada.
 * @param {string} publickey
 * @returns {Promise<string>}
 */
export async function tunnelKey (publickey) {
  if (typeof publickey !== 'string' || !publickey) throw new Error('tunnelKey: publickey required')
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(publickey)))
  return keyFromBytes(h.subarray(0, 32))
}

export const KEY_RE = /^[A-Za-z0-9]{32}$/

/**
 * La URL por la que el agente se registra en el relay.
 * @param {string} server
 * @returns {string}
 */
export function agentWsUrl (server) {
  const u = new URL(server)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/_agent'
  u.search = ''
  return u.toString()
}

/**
 * El destinatario de la prueba: el origen del relay, el mismo que comprueba él.
 * @param {string} server
 * @returns {string}
 */
export const relayAudience = (server) => new URL(server).origin

/**
 * Contesta al reto del relay con la identidad del aparato. `signedFor` es el de
 * `@dotrino/identity/assertion`: se pasa desde fuera para que este archivo no arrastre el
 * pilar a la web dos veces.
 *
 * @param {object} args
 * @param {(identity: any, opts: { aud: string, ttlMs: number, fields: Record<string, unknown> }) => Promise<object>} args.signedFor
 *   `signedFor` de `@dotrino/identity/assertion`; `identity` es la que él acepte (por eso any)
 * @param {unknown} args.identity
 * @param {string} args.server
 * @param {string} args.challenge
 * @param {boolean} [args.stream]
 * @returns {Promise<{ type: 'hello' } & Record<string, unknown>>}
 */
export async function answerChallenge ({ signedFor, identity, server, challenge, stream = false }) {
  const p = await signedFor(identity, {
    aud: relayAudience(server),
    ttlMs: AGENT_PROOF_TTL_MS,
    // `stream`: este agente sabe recibir y mandar los cuerpos en tramas binarias (STREAM_V).
    // Va firmado con lo demás; un relay viejo lo ignora y sigue con el formato JSON.
    fields: { v: AGENT_V, op: AGENT_OP, challenge, ...(stream ? { stream: STREAM_V } : {}) }
  })
  return { type: 'hello', ...p }
}

/*
 * CUERPOS EN BINARIO, POR PARTES (STREAM_V = 1, tunnel 0.5.0).
 *
 * Antes cada petición y cada respuesta viajaban ENTERAS dentro de un JSON, en base64: un 33 %
 * más de bytes, y un archivo grande ocupaba el único WebSocket del túnel hasta terminar, con
 * todo lo demás esperando detrás. Ahora:
 *
 *   control (JSON)   req-head {id, method, path, headers} · req-end {id}
 *                    res-head {id, status, headers} · res-end {id} · res-abort {id, error}
 *                    cancel {id} · pause {id} · resume {id}
 *   cuerpo (binario) [1 byte: FRAME_REQ | FRAME_RES][36 bytes: id][hasta CHUNK bytes]
 *
 * Las tramas de varios pedidos se intercalan, así que uno grande no frena a los pequeños.
 * `pause`/`resume` los manda el relay cuando el cliente HTTP lee más despacio de lo que llega:
 * así lo que no cabe se queda en la máquina del agente y no en la memoria del VPS.
 */
export const STREAM_V = 1
export const FRAME_REQ = 1
export const FRAME_RES = 2
export const ID_LEN = 36            // randomUUID()
export const CHUNK = 64 * 1024

/**
 * Una trama binaria de cuerpo. `id` es el del pedido (36 caracteres ASCII).
 * @param {number} kind  FRAME_REQ | FRAME_RES
 * @param {string} id
 * @param {Uint8Array} payload
 * @returns {Uint8Array}
 */
export function bodyFrame (kind, id, payload) {
  const enc = new TextEncoder().encode(id)
  if (enc.length !== ID_LEN) throw new Error('bodyFrame: id must be 36 ASCII characters')
  const out = new Uint8Array(1 + ID_LEN + payload.length)
  out[0] = kind
  out.set(enc, 1)
  out.set(payload, 1 + ID_LEN)
  return out
}

/**
 * Lee una trama binaria: `{ kind, id, payload }`, o `null` si no tiene forma de trama.
 * @param {Uint8Array | ArrayBuffer} buf
 * @returns {{ kind: number, id: string, payload: Uint8Array } | null}
 */
export function parseBodyFrame (buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  if (u.length < 1 + ID_LEN) return null
  const kind = u[0]
  if (kind !== FRAME_REQ && kind !== FRAME_RES) return null
  return { kind, id: new TextDecoder().decode(u.subarray(1, 1 + ID_LEN)), payload: u.subarray(1 + ID_LEN) }
}

/**
 * Cabeceras CORS para un origen permitido; `null` si no hay origen.
 * @param {unknown} origin
 * @returns {Record<string, string> | null}
 */
export function corsHeadersFor (origin) {
  const o = String(origin ?? '').trim()
  if (!o) return null
  return {
    'access-control-allow-origin': o,
    'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'access-control-allow-headers': '*',
  }
}

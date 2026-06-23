/**
 * Cripto del túnel — ECDSA P-256 (misma curva que la identidad Dotrino), vía
 * WebCrypto (sirve igual en Node 18+ y en el navegador). Identidad del túnel =
 * par de llaves; la URL pública = fingerprint de la llave pública (SHA-256[:16]
 * en base62, 22 chars). El agente prueba la privada firmando un challenge.
 */
import { webcrypto } from 'node:crypto'
const subtle = webcrypto.subtle

const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const enc = new TextEncoder()

export const b64uFromBytes = (buf) => Buffer.from(buf).toString('base64url')
export const bytesFromB64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'))

// 16 bytes (128 bits) → 22 chars base62 fijos (big-endian, padding a la izquierda).
export function bytesToBase62 (bytes, len = 22) {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let s = ''
  while (n > 0n) { s = B62[Number(n % 62n)] + s; n /= 62n }
  return s.padStart(len, 'A')
}

export async function fingerprint (pubRawBytes) {
  const hash = new Uint8Array(await subtle.digest('SHA-256', pubRawBytes))
  return bytesToBase62(hash.slice(0, 16))
}

const DOMAIN = 'dotrino-tunnel:v1:'
const msgBytes = (nonce) => enc.encode(DOMAIN + nonce)

/** Genera un par de llaves. Devuelve { privateKey (pkcs8 b64url), publicKey (raw b64url), fingerprint }. */
export async function generateKeypair () {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  const priv = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey))
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey))
  return { privateKey: b64uFromBytes(priv), publicKey: b64uFromBytes(pub), fingerprint: await fingerprint(pub) }
}

/** Deriva la pubkey (raw b64url) + fingerprint a partir de la privada (pkcs8 b64url). */
export async function publicFromPrivate (privB64u) {
  const key = await importPrivate(privB64u)
  const jwk = await subtle.exportKey('jwk', key) // pkcs8 no reexporta raw directo; vía jwk→raw
  const pubKey = await subtle.importKey('jwk', { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify'])
  const pub = new Uint8Array(await subtle.exportKey('raw', pubKey))
  return { publicKey: b64uFromBytes(pub), fingerprint: await fingerprint(pub) }
}

async function importPrivate (privB64u) {
  return subtle.importKey('pkcs8', bytesFromB64u(privB64u), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign'])
}
async function importPublicRaw (pubB64u) {
  return subtle.importKey('raw', bytesFromB64u(pubB64u), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
}

/** Firma el challenge con la privada → sig b64url. */
export async function signChallenge (privB64u, nonce) {
  const key = await importPrivate(privB64u)
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, msgBytes(nonce)))
  return b64uFromBytes(sig)
}

/** Verifica la firma del challenge contra la pubkey. */
export async function verifyChallenge (pubB64u, nonce, sigB64u) {
  try {
    const key = await importPublicRaw(pubB64u)
    return await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, bytesFromB64u(sigB64u), msgBytes(nonce))
  } catch { return false }
}

export const randomNonce = () => b64uFromBytes(webcrypto.getRandomValues(new Uint8Array(32)))

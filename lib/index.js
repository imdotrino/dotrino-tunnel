/**
 * @dotrino/tunnel — agente del túnel reverso de Dotrino (como código).
 *
 *   import { createTunnel } from '@dotrino/tunnel'
 *   const t = await createTunnel({ target: 3000 })   // expone http://localhost:3000
 *   console.log(t.url)                                // https://r.dotrino.com/<llave>
 *   // t.close()
 *
 * `target` puede ser:
 *   - un número  → http://localhost:<puerto>
 *   - una URL    → 'http://localhost:3000' / 'http://127.0.0.1:8080/base'
 *   - una función (req) => { status, headers, body }  (req.body es Buffer|null)
 *
 * UN TÚNEL ES UN APARATO DE TU CUENTA. Antes de abrirlo hay que enrolarlo en tu bóveda
 * (`dotrino-tunnel enroll`, o `enrollTunnel()`), y cada `name` es un aparato distinto. La
 * dirección sale de la llave del aparato y el relay pide que firme un reto: nadie elige la
 * dirección de otro ni puede atenderla. Reconecta solo si el WebSocket se cae.
 */
import WebSocket from 'ws'
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { signedFor } from '@dotrino/identity/assertion'
import { enroll, loadLink, identityFromLink, refreshChain } from '@dotrino/remote-agent/link'
import { resolveInstance, listInstances } from '@dotrino/remote-agent/instances'
import { tunnelKey, agentWsUrl, answerChallenge, corsHeadersFor, CLOSE_REPLACED, CLOSE_REJECTED } from './shared.js'

const DEFAULT_SERVER = 'https://r.dotrino.com'
/** El tipo de agente: la carpeta `~/.dotrino/agent/tunnel/<name>` y el label del enlace. */
export const TUNNEL_KIND = 'tunnel'

/** La carpeta del aparato de un túnel (`name` opcional, ver `resolveInstance`). */
export function tunnelInstance (name) { return resolveInstance(TUNNEL_KIND, name) }
/** Los túneles enrolados en esta máquina. */
export function listTunnels () { return listInstances(TUNNEL_KIND) }

/**
 * Enrola un túnel como aparato de tu cuenta. `qr` es la invitación de tu bóveda
 * (`parseQr` de `@dotrino/remote-agent/link`); `onChallenge({ deviceId, code })` enseña el
 * código que se escribe en la bóveda para aprobarlo.
 *
 * @param {{ qr?: any, name?: string, dir?: string, onChallenge?: (c: { deviceId: string, code: string }) => void }} [args]
 */
export function enrollTunnel ({ qr, name, dir, onChallenge } = {}) {
  return enroll({ qr, label: TUNNEL_KIND, dir: dir || tunnelInstance(name).dir, onChallenge })
}

/** Lo que dice cada rechazo del relay, para quien lo lee en la terminal. */
const REJECTED_HINT = {
  'signature:unauthorized-signer': 'this device is not allowed to sign for your account: give it the sign permission (dotrino-vault caps <ID> +sign) or enroll it again',
  'stale-chain': 'the relay has seen a newer membership list of your account than this device carries: if it was removed, enroll it again',
}
const rejectedMessage = (reason) => REJECTED_HINT[reason] || (String(reason).startsWith('signature:chain:')
  ? 'this device cannot prove it belongs to your account (' + reason + '): check that your vault is reachable, or enroll it again'
  : 'the relay rejected this device: ' + reason)

function targetToForwarder (target) {
  if (typeof target === 'function') {
    return async (req) => {
      const r = await target(req)
      return { status: r.status || 200, headers: r.headers || {}, body: toBuf(r.body) }
    }
  }
  const base = typeof target === 'number' ? `http://localhost:${target}` : String(target)
  const baseUrl = new URL(base)
  return (req) => new Promise((resolve) => {
    const lib = baseUrl.protocol === 'https:' ? https : http
    const path = (baseUrl.pathname.replace(/\/$/, '') + req.path) || '/'
    const headers = { ...req.headers, host: baseUrl.host }
    const r = lib.request({ protocol: baseUrl.protocol, hostname: baseUrl.hostname, port: baseUrl.port, method: req.method, path, headers }, (resp) => {
      const chunks = []
      resp.on('data', (c) => chunks.push(c))
      resp.on('end', () => resolve({ status: resp.statusCode, headers: resp.headers, body: Buffer.concat(chunks) }))
    })
    r.on('error', (e) => resolve({ status: 502, headers: { 'content-type': 'text/plain' }, body: Buffer.from('tunnel agent: ' + e.message) }))
    if (req.body) r.write(req.body)
    r.end()
  })
}

const toBuf = (b) => b == null ? null : Buffer.isBuffer(b) ? b : Buffer.from(typeof b === 'string' ? b : JSON.stringify(b))

/**
 * UNA sola instancia por APARATO en esta máquina.
 *
 * La llave del túnel sale de la del aparato, así que dos procesos con el mismo aparato se
 * echan mutuamente en el relay. Dos aparatos distintos (dos `--name`) conviven sin problema
 * — por eso el candado va por llave y no por directorio (la `identity` puede no venir de
 * una carpeta). Un candado de un proceso muerto no estorba (se comprueba el pid).
 */
function lockPath (key) {
  const h = createHash('sha256').update(String(key)).digest('hex').slice(0, 16)
  return path.join(os.tmpdir(), `dotrino-tunnel-${h}.lock`)
}

/** Llaves tomadas por ESTE proceso: el pid del archivo coincidiría y no bastaría. */
const keysInUse = new Set()

function takeLock (key) {
  const file = lockPath(key)
  if (keysInUse.has(key)) {
    throw Object.assign(new Error(
      `this tunnel (…${String(key).slice(-6)}) is already open in this same process. ` +
      'Two agents for the same device keep kicking each other out; enroll another device (--name) for a second tunnel.'
    ), { code: 'TUNNEL_KEY_IN_USE', pid: process.pid })
  }
  try {
    const prev = Number(fs.readFileSync(file, 'utf8').trim())
    if (prev && prev !== process.pid) {
      try {
        process.kill(prev, 0) // vivo: no arrancamos un segundo
        throw Object.assign(new Error(
          `this tunnel (…${String(key).slice(-6)}) is already open on this machine, in process ${prev}. ` +
          'Two agents for the same device keep kicking each other out. ' +
          'Stop that process, or enroll another device (--name) for a second tunnel.'
        ), { code: 'TUNNEL_KEY_IN_USE', pid: prev })
      } catch (err) {
        if (err.code === 'TUNNEL_KEY_IN_USE') throw err
        // ESRCH: el candado es de un proceso que ya no existe → se puede tomar
      }
    }
  } catch (err) {
    if (err.code === 'TUNNEL_KEY_IN_USE') throw err
    // no existía el archivo: se crea abajo
  }
  try { fs.writeFileSync(file, String(process.pid), { mode: 0o600 }) } catch (_) {}
  keysInUse.add(key)
  return () => {
    keysInUse.delete(key)
    try { if (Number(fs.readFileSync(file, 'utf8').trim()) === process.pid) fs.unlinkSync(file) } catch (_) {}
  }
}

/**
 * Abre el túnel de un aparato enrolado. Devuelve `{ url, key, close }` en cuanto sabe su
 * dirección (antes de conectar: sale de la llave del aparato).
 *
 * `identity` sustituye al enlace del disco: cualquier objeto con `me.publickey` y un
 * `signData` que devuelva la cadena del acta (`identityFromLink`, o el pilar del navegador).
 */
export async function createTunnel (opts = {}) {
  const server = opts.server || DEFAULT_SERVER
  const forward = targetToForwarder(opts.target ?? 3000)
  const log = opts.quiet ? () => {} : (...a) => console.log('[tunnel]', ...a)

  let identity = opts.identity || null
  let link = null, dir = null
  if (!identity) {
    dir = opts.dir || tunnelInstance(opts.name).dir
    link = loadLink(dir)
    if (!link) {
      throw Object.assign(new Error(`this tunnel is not enrolled in your vault yet (${dir}): run \`dotrino-tunnel enroll\``), { code: 'TUNNEL_NOT_ENROLLED' })
    }
    identity = identityFromLink(link, { dir })
  }
  const publickey = identity.me?.publickey
  if (!publickey) throw Object.assign(new Error('the identity has no public key'), { code: 'TUNNEL_NO_IDENTITY' })
  const key = await tunnelKey(publickey)
  const url = `${server.replace(/\/$/, '')}/${key}`

  // La cadena del acta es lo que prueba que el aparato es de la cuenta: se trae fresca antes
  // de conectar. Si la bóveda no contesta se sigue con la guardada, y si no hay ninguna se
  // para aquí, porque el relay la va a rechazar.
  const freshen = async () => {
    if (!link) return
    const r = await refreshChain(link, { dir })
    if (!r.ok) {
      if (!link.sealerChain?.length) {
        throw Object.assign(new Error('this device has no proof that it belongs to your account, and the vault did not answer: ' + r.reason), { code: 'TUNNEL_NO_CHAIN' })
      }
      log('could not refresh the account chain (using the stored one):', r.reason)
    }
  }
  await freshen()

  // Antes de abrir nada: si otro proceso de esta máquina ya tiene este aparato, se falla
  // aquí con un mensaje claro en vez de irse a forcejear contra él.
  const releaseLock = opts.lock === false ? () => {} : takeLock(key)
  let ws = null, closed = false, backoff = 500, retryTimer = null

  const stop = () => { closed = true; releaseLock(); clearTimeout(retryTimer) }

  function connect () {
    if (closed) return
    ws = new WebSocket(agentWsUrl(server))
    ws.on('open', () => { backoff = 500 })
    ws.on('message', async (data) => {
      let m
      try { m = JSON.parse(data) } catch { return }
      if (m.type === 'challenge') {
        try { safeSend(await answerChallenge({ signedFor, identity, server, challenge: m.challenge })) } catch (e) {
          log('could not sign the challenge:', e.message)
          try { ws.close() } catch {}
        }
      } else if (m.type === 'ready') { log('ready →', m.url); opts.onReady?.(m.url) }
      else if (m.type === 'req') await onRequest(m)
    })
    ws.on('close', async (code, reasonBuf) => {
      if (closed) return
      // El relay solo admite UN agente por aparato: si llega otro, cierra al anterior con
      // 4001 «replaced». Reconectar ante eso monta un forcejeo infinito — cada copia echa a
      // la otra una vez por segundo, sin backoff (la conexión SÍ tiene éxito, así que se
      // reinicia), y sin que nadie se entere. Pasó 11 días con dos copias del bot de
      // Telegram arrancadas desde la misma carpeta. Así que quien es desplazado se rinde y
      // lo DICE, que es lo que convierte un bucle silencioso en un mensaje.
      if (code === CLOSE_REPLACED) {
        stop()
        log(`another copy took this tunnel (…${key.slice(-6)}). This one stops: check whether you started it twice.`)
        opts.onReplaced?.(key)
        return
      }
      // Rechazado: reintentar no cambia nada (la firma o la cadena no valen). Se para y se dice.
      if (code === CLOSE_REJECTED) {
        stop()
        const reason = String(reasonBuf || '') || 'unknown'
        log(rejectedMessage(reason))
        opts.onRejected?.(reason, rejectedMessage(reason))
        return
      }
      log('reconnecting…')
      retryTimer = setTimeout(async () => {
        try { await freshen() } catch (e) { log(e.message) }
        connect()
      }, backoff)
      retryTimer.unref?.()  // un túnel cerrado no debe mantener vivo el proceso
      backoff = Math.min(backoff * 2, 15000)
    })
    ws.on('error', () => {}) // el close maneja la reconexión
  }

  const corsHeaders = opts.cors ? corsHeadersFor(opts.cors) : null

  async function onRequest (m) {
    // CORS preflight: responde sin tocar el servicio local.
    if (corsHeaders && m.method === 'OPTIONS') {
      return safeSend({ type: 'res', id: m.id, status: 204, headers: corsHeaders, body: null })
    }
    const reqBody = m.body ? Buffer.from(m.body, 'base64') : null
    const req = { method: m.method, path: m.path || '/', headers: m.headers || {}, body: reqBody }
    opts.onRequest?.({ method: req.method, path: req.path, headers: req.headers })
    let out
    try { out = await forward(req) } catch (e) { out = { status: 502, headers: {}, body: Buffer.from('tunnel agent error: ' + e.message) } }
    const headers = corsHeaders ? { ...out.headers, ...corsHeaders } : out.headers
    const body = out.body ? Buffer.from(out.body) : null
    safeSend({ type: 'res', id: m.id, status: out.status, headers, body: body ? body.toString('base64') : null })
  }

  function safeSend (obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)) }

  connect()
  return {
    url, key,
    close () { stop(); try { ws?.close() } catch {} },
  }
}

export default { createTunnel, enrollTunnel, tunnelInstance, listTunnels, TUNNEL_KIND }

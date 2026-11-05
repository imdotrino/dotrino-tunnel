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
 * UN TÚNEL ES UN APARATO, Y NO NECESITA BÓVEDA. La primera vez que se abre sin enlace se
 * genera su propia identidad (llaves + acta de génesis autofirmada, `selfLink`): es una
 * cuenta de un solo aparato. Emparejarlo después con tu bóveda (`dotrino-tunnel enroll`, o
 * `enrollTunnel()`) le da una llave NUEVA, y con ella otra dirección: una llave vive en una
 * sola cuenta (dueño, 2026-11-04). Cada
 * `name` es un aparato distinto. La dirección sale de la llave del aparato y el relay pide
 * que firme un reto: nadie elige la dirección de otro ni puede atenderla. Reconecta solo si
 * el WebSocket se cae.
 */
import WebSocket from 'ws'
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { signedFor } from '@dotrino/identity/assertion'
import { enroll, selfLink, isSelfLink, loadLink, identityFromLink, refreshChain } from '@dotrino/remote-agent/link'
import { resolveInstance, listInstances } from '@dotrino/remote-agent/instances'
import { tunnelKey, agentWsUrl, answerChallenge, corsHeadersFor, CLOSE_REPLACED, CLOSE_REJECTED, STREAM_V, FRAME_REQ, FRAME_RES, CHUNK, bodyFrame, parseBodyFrame } from './shared.js'

/**
 * Una petición que llega por el túnel.
 * @typedef {object} TunnelRequest
 * @property {string} method
 * @property {string} path
 * @property {Record<string, string | string[] | undefined>} headers
 * @property {Buffer | null} body
 */

/**
 * Lo que contesta un destino que es una función.
 * @typedef {object} TunnelResponse
 * @property {number} [status]
 * @property {Record<string, string | string[] | undefined>} [headers]
 * @property {string | Buffer | object | null} [body]   un objeto se manda como JSON
 */

/** @typedef {number | string | ((req: TunnelRequest) => TunnelResponse | Promise<TunnelResponse>)} TunnelTarget */

/**
 * Por dónde sale la respuesta de un pedido por partes.
 * @typedef {object} Sink
 * @property {(status: number, headers: Record<string, string | string[] | undefined>) => void} head
 * @property {(chunk: Buffer | Uint8Array) => void} data
 * @property {() => void} end
 * @property {(e: unknown) => void} abort
 */

/** @typedef {{ pause: () => void, resume: () => void, cancel: () => void }} StreamControl */

/**
 * @typedef {object} TunnelOptions
 * @property {TunnelTarget} [target]   por defecto 3000
 * @property {string} [server]         relay (por defecto https://r.dotrino.com)
 * @property {import('@dotrino/remote-agent/link').LinkIdentity} [identity]  en vez del enlace del disco
 * @property {string} [dir]            carpeta del aparato
 * @property {string} [name]           qué túnel (cada nombre es otro aparato)
 * @property {string} [cors]           origen para las cabeceras CORS
 * @property {boolean} [quiet]
 * @property {boolean} [lock]          false: el candado ya lo tiene quien llama
 * @property {(url: string) => void | Promise<void>} [onReady]
 * @property {(key: string) => void} [onReplaced]
 * @property {(reason: string, message: string) => void} [onRejected]
 * @property {(r: { method: string, path: string, headers: TunnelRequest['headers'] }) => void} [onRequest]
 */

const DEFAULT_SERVER = 'https://r.dotrino.com'
/** El tipo de agente: la carpeta `~/.dotrino/agent/tunnel/<name>` y el label del enlace. */
export const TUNNEL_KIND = 'tunnel'

/**
 * La carpeta del aparato de un túnel (`name` opcional, ver `resolveInstance`).
 * @param {string | null} [name]
 * @returns {{ name: string, dir: string }}
 */
export function tunnelInstance (name) { return resolveInstance(TUNNEL_KIND, name) }
/**
 * Los túneles enrolados en esta máquina.
 * @returns {string[]}
 */
export function listTunnels () { return listInstances(TUNNEL_KIND) }

/**
 * Enrola un túnel como aparato de tu cuenta. `qr` es la invitación de tu bóveda
 * (`parseQr` de `@dotrino/remote-agent/link`); `onChallenge({ deviceId, code })` enseña el
 * código que se escribe en la bóveda para aprobarlo.
 *
 * Siempre con una llave NUEVA, que sustituye a la anterior (la propia o la de otra cuenta):
 * la dirección cambia.
 *
 * @param {{ qr?: object | string, name?: string, dir?: string, onChallenge?: (c: { deviceId: string, code: string }) => void }} [args]
 */
export function enrollTunnel ({ qr, name, dir, onChallenge } = {}) {
  return enroll({ qr, label: TUNNEL_KIND, dir: dir || tunnelInstance(name).dir, onChallenge })
}

/** Lo que dice cada rechazo del relay, para quien lo lee en la terminal. */
/** @type {Record<string, string>} */
const REJECTED_HINT = {
  'signature:unauthorized-signer': 'this device is not allowed to sign for your account: give it the sign permission (dotrino-vault caps <ID> +sign) or enroll it again',
  'stale-chain': 'the relay has seen a newer membership list of your account than this device carries: if it was removed, enroll it again',
}
/** @param {string} reason */
const rejectedMessage = (reason) => REJECTED_HINT[reason] || (String(reason).startsWith('signature:chain:')
  ? 'this device cannot prove it belongs to your account (' + reason + '): check that your vault is reachable, or enroll it again'
  : 'the relay rejected this device: ' + reason)

/**
 * @param {TunnelTarget} target
 * @returns {(req: TunnelRequest) => Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: Buffer | null }>}
 */
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
      /** @type {Buffer[]} */
      const chunks = []
      resp.on('data', (c) => chunks.push(c))
      resp.on('end', () => resolve({ status: resp.statusCode || 502, headers: resp.headers, body: Buffer.concat(chunks) }))
    })
    r.on('error', (e) => resolve({ status: 502, headers: { 'content-type': 'text/plain' }, body: Buffer.from('tunnel agent: ' + e.message) }))
    if (req.body) r.write(req.body)
    r.end()
  })
}

/**
 * El mismo destino, pero devolviendo la respuesta POR PARTES: `start(req, sink)` llama a
 * `sink.head(status, headers)`, después a `sink.data(chunk)` las veces que haga falta y por
 * último a `sink.end()` (o `sink.abort(err)`). Devuelve `{ pause, resume, cancel }`, que es
 * lo que usa el agente para el control de flujo y para soltar lo que el cliente ya no quiere.
 *
 * @param {TunnelTarget} target
 * @returns {(req: TunnelRequest, sink: Sink) => StreamControl}
 */
function targetToStreamer (target) {
  if (typeof target === 'function') {
    return (req, sink) => {
      let cancelled = false
      Promise.resolve().then(() => target(req)).then((r) => {
        if (cancelled) return
        sink.head(r.status || 200, r.headers || {})
        const b = toBuf(r.body)
        if (b) sink.data(b)
        sink.end()
      }, (e) => { if (!cancelled) sink.abort(e) })
      return { pause () {}, resume () {}, cancel () { cancelled = true } }
    }
  }
  const base = typeof target === 'number' ? `http://localhost:${target}` : String(target)
  const baseUrl = new URL(base)
  const lib = baseUrl.protocol === 'https:' ? https : http
  // Conexiones reutilizadas al servicio local: un panel pide decenas de archivos de golpe.
  const agent = new lib.Agent({ keepAlive: true, maxSockets: 32 })
  return (req, sink) => {
    const path = (baseUrl.pathname.replace(/\/$/, '') + req.path) || '/'
    const headers = { ...req.headers, host: baseUrl.host }
    /** @type {http.IncomingMessage | null} */
    let resp = null
    const r = lib.request({ protocol: baseUrl.protocol, hostname: baseUrl.hostname, port: baseUrl.port, method: req.method, path, headers, agent }, (res) => {
      resp = res
      sink.head(res.statusCode || 502, res.headers)
      res.on('data', (c) => sink.data(c))
      res.on('end', () => sink.end())
      res.on('error', (e) => sink.abort(e))
    })
    r.on('error', (e) => { if (!resp) { sink.head(502, { 'content-type': 'text/plain' }); sink.data(Buffer.from('tunnel agent: ' + e.message)); sink.end() } else sink.abort(e) })
    if (req.body) r.write(req.body)
    r.end()
    return {
      pause () { resp?.pause() },
      resume () { resp?.resume() },
      cancel () { r.destroy(); resp?.destroy() }
    }
  }
}

/**
 * @param {string | Buffer | object | null | undefined} b
 * @returns {Buffer | null}
 */
const toBuf = (b) => b == null ? null : Buffer.isBuffer(b) ? b : Buffer.from(typeof b === 'string' ? b : JSON.stringify(b))

/**
 * UNA sola instancia por APARATO en esta máquina.
 *
 * La llave del túnel sale de la del aparato, así que dos procesos con el mismo aparato se
 * echan mutuamente en el relay. Dos aparatos distintos (dos `--name`) conviven sin problema
 * — por eso el candado va por llave y no por directorio (la `identity` puede no venir de
 * una carpeta). Un candado de un proceso muerto no estorba (se comprueba el pid).
 */
/** @param {string} key */
function lockPath (key) {
  const h = createHash('sha256').update(String(key)).digest('hex').slice(0, 16)
  return path.join(os.tmpdir(), `dotrino-tunnel-${h}.lock`)
}

/** Llaves tomadas por ESTE proceso: el pid del archivo coincidiría y no bastaría. */
/** @type {Set<string>} */
const keysInUse = new Set()

/**
 * @param {string} key
 * @returns {() => void}  suelta el candado
 */
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
        if (/** @type {{ code?: string }} */ (err).code === 'TUNNEL_KEY_IN_USE') throw err
        // ESRCH: el candado es de un proceso que ya no existe → se puede tomar
      }
    }
  } catch (err) {
    if (/** @type {{ code?: string }} */ (err).code === 'TUNNEL_KEY_IN_USE') throw err
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
 *
 * @param {TunnelOptions} [opts]
 * @returns {Promise<{ url: string, key: string, close: () => void }>}
 */
export async function createTunnel (opts = {}) {
  const server = opts.server || DEFAULT_SERVER
  const forward = targetToForwarder(opts.target ?? 3000)
  const stream = targetToStreamer(opts.target ?? 3000)
  // Lo que el WebSocket puede acumular antes de dejar de leer el servicio local. Poco a
  // propósito: el pong y el control van en la misma cola, detrás de los datos.
  const WS_HIGH = 512 * 1024
  const log = opts.quiet ? () => {} : (/** @type {unknown[]} */ ...a) => console.log('[tunnel]', ...a)

  let identity = opts.identity || null
  /** @type {import('@dotrino/remote-agent/link').Link | null} */
  let link = null
  /** @type {string | null} */
  let dir = null
  if (!identity) {
    dir = opts.dir || tunnelInstance(opts.name).dir
    // Sin enlace se genera la identidad propia: un túnel no exige tener bóveda.
    link = loadLink(dir) || await selfLink({ label: TUNNEL_KIND, dir })
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
    if (!link || isSelfLink(link)) return
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
  /** @type {WebSocket | null} */
  let ws = null
  let closed = false, backoff = 500
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let retryTimer
  // ¿El relay de esta conexión habla STREAM_V? Lo dice en `ready`; hasta entonces, no.
  let streaming = false
  /**
   * Un mensaje de control del relay (JSON). Llega de fuera: se mira `type` antes de nada.
   * @typedef {{ type?: string, id: string, challenge?: string, stream?: number, url?: string,
   *   method: string, path?: string, headers?: Record<string, string | string[] | undefined>, body?: string | null }} RelayMessage
   */
  /**
   * Un pedido por partes en curso.
   * @typedef {{ head: RelayMessage, chunks: Buffer[], ctl: StreamControl | null, relayPaused: boolean, wsPaused: boolean }} Inflight
   */
  /** @type {Map<string, Inflight>} id → pedido */
  const inflight = new Map()

  const stop = () => { closed = true; releaseLock(); clearTimeout(retryTimer) }

  function connect () {
    if (closed) return
    const sock = new WebSocket(agentWsUrl(server))
    ws = sock
    streaming = false
    sock.on('open', () => { backoff = 500 })
    sock.on('message', async (data, isBinary) => {
      // ws entrega Buffer salvo que se pida otra cosa (binaryType por defecto: 'nodebuffer').
      const buf = /** @type {Buffer} */ (data)
      if (isBinary) return onBodyFrame(buf)
      /** @type {RelayMessage} */
      let m
      try { m = JSON.parse(buf.toString()) } catch { return }
      // `challenge` y `ready` siempre traen su campo (server/index.js los arma así).
      if (m.type === 'challenge') {
        try { safeSend(await answerChallenge({ signedFor, identity, server, challenge: /** @type {string} */ (m.challenge), stream: true })) } catch (e) {
          log('could not sign the challenge:', /** @type {Error} */ (e).message)
          try { sock.close() } catch {}
        }
      } else if (m.type === 'ready') { streaming = m.stream === STREAM_V; log('ready →', m.url); opts.onReady?.(/** @type {string} */ (m.url)) }
      else if (m.type === 'req') await onRequest(m)
      else if (m.type === 'req-head') onReqHead(m)
      else if (m.type === 'req-end') onReqEnd(m.id)
      else if (m.type === 'cancel') { inflight.get(m.id)?.ctl?.cancel(); inflight.delete(m.id) }
      else if (m.type === 'pause') { const f = inflight.get(m.id); if (f) { f.relayPaused = true; f.ctl?.pause() } }
      else if (m.type === 'resume') { const f = inflight.get(m.id); if (f) { f.relayPaused = false; if (!f.wsPaused) f.ctl?.resume() } }
    })
    sock.on('close', async (code, reasonBuf) => {
      // Lo que estaba en curso por esta conexión ya no tiene a quién contestar.
      for (const f of inflight.values()) f.ctl?.cancel()
      inflight.clear()
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
        try { await freshen() } catch (e) { log(/** @type {Error} */ (e).message) }
        connect()
      }, backoff)
      // SIN `unref`: mientras se espera para reconectar, este temporizador es lo único que
      // mantiene vivo el proceso. Con `unref` Node salía con código 0 en cuanto el relay se
      // reiniciaba, sin decir nada (Glassnote, tres veces). Un túnel cerrado ya no lo
      // retiene: `stop()` lo cancela.
      backoff = Math.min(backoff * 2, 15000)
    })
    sock.on('error', () => {}) // el close maneja la reconexión
  }

  const corsHeaders = opts.cors ? corsHeadersFor(opts.cors) : null

  /** @param {RelayMessage} m */
  async function onRequest (m) {
    // CORS preflight: responde sin tocar el servicio local.
    if (corsHeaders && m.method === 'OPTIONS') {
      return safeSend({ type: 'res', id: m.id, status: 204, headers: corsHeaders, body: null })
    }
    const reqBody = m.body ? Buffer.from(m.body, 'base64') : null
    const req = { method: m.method, path: m.path || '/', headers: m.headers || {}, body: reqBody }
    opts.onRequest?.({ method: req.method, path: req.path, headers: req.headers })
    let out
    try { out = await forward(req) } catch (e) { out = { status: 502, headers: {}, body: Buffer.from('tunnel agent error: ' + /** @type {Error} */ (e).message) } }
    const headers = corsHeaders ? { ...out.headers, ...corsHeaders } : out.headers
    const body = out.body ? Buffer.from(out.body) : null
    safeSend({ type: 'res', id: m.id, status: out.status, headers, body: body ? body.toString('base64') : null })
  }

  // ---- pedidos por partes (STREAM_V) ----
  /** @param {RelayMessage} m */
  function onReqHead (m) {
    inflight.set(m.id, { head: m, chunks: [], ctl: null, relayPaused: false, wsPaused: false })
  }
  /** @param {Buffer} data */
  function onBodyFrame (data) {
    const f = parseBodyFrame(data)
    if (!f || f.kind !== FRAME_REQ) return
    const st = inflight.get(f.id)
    if (st && !st.ctl) st.chunks.push(Buffer.from(f.payload))
  }
  /** @param {string} id */
  function onReqEnd (id) {
    const st = inflight.get(id)
    if (!st || st.ctl) return
    const m = st.head
    const req = { method: m.method, path: m.path || '/', headers: m.headers || {}, body: st.chunks.length ? Buffer.concat(st.chunks) : null }
    st.chunks = []
    opts.onRequest?.({ method: req.method, path: req.path, headers: req.headers })
    const sock = ws
    if (!sock) return
    /** @param {string | Uint8Array} obj */
    const sendTo = (obj) => { if (sock.readyState === WebSocket.OPEN) sock.send(obj) }
    // CORS preflight: responde sin tocar el servicio local.
    if (corsHeaders && req.method === 'OPTIONS') {
      inflight.delete(id)
      sendTo(JSON.stringify({ type: 'res-head', id, status: 204, headers: corsHeaders }))
      sendTo(JSON.stringify({ type: 'res-end', id }))
      return
    }
    const live = () => inflight.get(id) === st
    st.ctl = stream(req, {
      head (status, headers) {
        if (!live()) return
        sendTo(JSON.stringify({ type: 'res-head', id, status, headers: corsHeaders ? { ...headers, ...corsHeaders } : headers }))
      },
      data (chunk) {
        if (!live()) return
        const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        for (let i = 0; i < b.length; i += CHUNK) sendTo(bodyFrame(FRAME_RES, id, b.subarray(i, i + CHUNK)))
        // El WebSocket va lleno: se deja de leer el servicio local hasta que baje.
        if (sock.bufferedAmount > WS_HIGH && !st.wsPaused) {
          st.wsPaused = true
          st.ctl?.pause()
          const t = setInterval(() => {
            if (!live() || sock.readyState !== WebSocket.OPEN || sock.bufferedAmount < WS_HIGH / 2) {
              clearInterval(t); st.wsPaused = false
              if (live() && !st.relayPaused) st.ctl?.resume()
            }
          }, 20)
          t.unref?.()
        }
      },
      end () { if (!live()) return; inflight.delete(id); sendTo(JSON.stringify({ type: 'res-end', id })) },
      abort (e) { if (!live()) return; inflight.delete(id); sendTo(JSON.stringify({ type: 'res-abort', id, error: /** @type {Error} */ (e)?.message || String(e) })) }
    })
  }

  /** @param {object} obj */
  function safeSend (obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)) }

  connect()
  return {
    url, key,
    close () { stop(); try { ws?.close() } catch {} },
  }
}

export default { createTunnel, enrollTunnel, tunnelInstance, listTunnels, TUNNEL_KIND }

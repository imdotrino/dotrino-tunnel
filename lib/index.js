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
 * La llave (secreto) va en la URL pública e identifica el túnel. Si no pasás una,
 * se genera. Reconecta solo si el WebSocket se cae.
 */
import WebSocket from 'ws'
import http from 'node:http'
import https from 'node:https'
import { randomBytes, createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { keyFromBytes, agentWsUrl, corsHeadersFor } from './shared.js'

const DEFAULT_SERVER = 'https://r.dotrino.com'

export function generateKey (len = 32) {
  return keyFromBytes(randomBytes(len))
}

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
 * UNA sola instancia por LLAVE en esta máquina.
 *
 * La llave es lo que identifica el túnel, así que es lo que colisiona: dos agentes con la
 * misma llave se echan mutuamente en el relay, para siempre. Dos con llaves distintas
 * conviven sin problema, aunque salgan de la misma carpeta — por eso el candado va por
 * llave y no por directorio.
 *
 * El archivo lleva el HASH de la llave, nunca la llave: es un secreto y `/tmp` lo lee
 * cualquiera. Un candado de un proceso muerto no estorba (se comprueba el pid).
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
    const e = new Error(
      `there is already a tunnel with this key (…${String(key).slice(-6)}) in this same process. ` +
      'Two agents with the same key keep kicking each other out; give each one its own key.'
    )
    e.code = 'TUNNEL_KEY_IN_USE'
    e.pid = process.pid
    throw e
  }
  try {
    const prev = Number(fs.readFileSync(file, 'utf8').trim())
    if (prev && prev !== process.pid) {
      try {
        process.kill(prev, 0) // vivo: no arrancamos un segundo
        const e = new Error(
          `there is already a tunnel with this key (…${String(key).slice(-6)}) on this machine, in process ${prev}. ` +
          'Two agents with the same key keep kicking each other out. ' +
          'Stop that process, or give this one its own key (TUNNEL_KEY / option `key`).'
        )
        e.code = 'TUNNEL_KEY_IN_USE'
        e.pid = prev
        throw e
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

export function createTunnel (opts = {}) {
  const server = opts.server || DEFAULT_SERVER
  const key = opts.key || generateKey()
  const forward = targetToForwarder(opts.target ?? 3000)
  const url = `${server.replace(/\/$/, '')}/${key}`
  // Antes de abrir nada: si otro proceso de esta máquina ya tiene esta llave, se falla
  // aquí con un mensaje claro en vez de irse a forcejear contra él.
  const releaseLock = opts.lock === false ? () => {} : takeLock(key)
  let ws = null, closed = false, backoff = 500, retryTimer = null
  const log = opts.quiet ? () => {} : (...a) => console.log('[tunnel]', ...a)

  function connect () {
    if (closed) return
    ws = new WebSocket(agentWsUrl(server, key))
    ws.on('open', () => { backoff = 500 })
    ws.on('message', async (data) => {
      let m
      try { m = JSON.parse(data) } catch { return }
      if (m.type === 'ready') { log('ready →', m.url); opts.onReady?.(m.url) }
      else if (m.type === 'req') await onRequest(m)
    })
    // El relay solo admite UN agente por llave: si llega otro, cierra al anterior con
    // 4001 «replaced». Reconectar ante eso monta un forcejeo infinito — cada copia echa a
    // la otra una vez por segundo, sin backoff (la conexión SÍ tiene éxito, así que se
    // reinicia), y sin que nadie se entere. Pasó 11 días con dos copias del bot de
    // Telegram arrancadas desde la misma carpeta. Así que quien es desplazado se rinde y
    // lo DICE, que es lo que convierte un bucle silencioso en un mensaje.
    ws.on('close', (code) => {
      if (closed) return
      if (code === 4001) {
        closed = true
        releaseLock()
        clearTimeout(retryTimer)
        log(`another copy took this tunnel with the same key (…${key.slice(-6)}). This one stops: check whether you started it twice.`)
        opts.onReplaced?.(key)
        return
      }
      log('reconnecting…')
      retryTimer = setTimeout(connect, backoff)
      retryTimer.unref?.()  // un túnel cerrado no debe mantener vivo el proceso
      backoff = Math.min(backoff * 2, 15000)
    })
    ws.on('error', () => {}) // el close maneja la reconexión
    // heartbeat: responder ping del relay (ws lo hace solo con pong)
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
    close () { closed = true; releaseLock(); clearTimeout(retryTimer); try { ws?.close() } catch {} },
  }
}

export default { createTunnel, generateKey }

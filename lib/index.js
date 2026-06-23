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
import { randomBytes } from 'node:crypto'

const DEFAULT_SERVER = 'https://r.dotrino.com'
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'

export function generateKey (len = 32) {
  const b = randomBytes(len)
  let s = ''
  for (let i = 0; i < len; i++) s += B62[b[i] % 62]
  return s
}

function wsUrl (server, key) {
  const u = new URL(server)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/_agent'
  u.search = '?key=' + key
  return u.toString()
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

export function createTunnel (opts = {}) {
  const server = opts.server || DEFAULT_SERVER
  const key = opts.key || generateKey()
  const forward = targetToForwarder(opts.target ?? 3000)
  const url = `${server.replace(/\/$/, '')}/${key}`
  let ws = null, closed = false, backoff = 500
  const log = opts.quiet ? () => {} : (...a) => console.log('[tunnel]', ...a)

  function connect () {
    if (closed) return
    ws = new WebSocket(wsUrl(server, key))
    ws.on('open', () => { backoff = 500 })
    ws.on('message', async (data) => {
      let m
      try { m = JSON.parse(data) } catch { return }
      if (m.type === 'ready') { log('listo →', m.url); opts.onReady?.(m.url) }
      else if (m.type === 'req') await onRequest(m)
    })
    ws.on('close', () => { if (!closed) { log('reconectando…'); setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000) } })
    ws.on('error', () => {}) // el close maneja la reconexión
    // heartbeat: responder ping del relay (ws lo hace solo con pong)
  }

  const corsHeaders = opts.cors
    ? { 'access-control-allow-origin': String(opts.cors), 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': '*' }
    : null

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
    close () { closed = true; try { ws?.close() } catch {} },
  }
}

export default { createTunnel, generateKey }

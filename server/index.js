#!/usr/bin/env node
/**
 * dotrino-tunnel — relay (servidor) del túnel reverso del ecosistema Dotrino.
 *
 * Túnel reverso autohospedado: un agente (lib/CLI o la web de testing) se conecta
 * por WebSocket a `/_agent`, contesta al reto firmándolo con la llave de su APARATO y
 * queda registrado. Las requests públicas a
 *   https://r.dotrino.com/<LLAVE>/<ruta>
 * se reenvían al agente por el WS y la respuesta vuelve al cliente HTTP.
 *
 * La LLAVE de la URL no la elige el agente: es el hash de la llave pública del aparato
 * (`tunnelKey`). Para atenderla hay que firmar el reto con esa llave y traer la cadena del
 * acta que dice que el aparato es de una cuenta y puede firmar (`verifySignedFor`). Antes la
 * llave era un secreto que cualquiera podía elegir, y quien la supiera echaba al agente
 * legítimo y se quedaba con sus peticiones.
 *
 * Sirve además la web de testing en `/`.
 */
import http from 'node:http'
import { WebSocketServer } from 'ws'
import { randomUUID } from 'node:crypto'
import { verifySignedFor } from '@dotrino/identity/assertion'
import { readFile, stat } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { watchCheckout } from '@dotrino/update/checkout'
import { tunnelKey, KEY_RE, AGENT_OP, AGENT_V, CLOSE_REPLACED, CLOSE_REJECTED } from '../lib/shared.js'

const PORT = Number(process.env.PORT || 7700)
const HOST = process.env.HOST || '127.0.0.1'
const MAX_BODY = Number(process.env.MAX_BODY || 1024 * 1024) // 1 MB por request/response
const REQ_TIMEOUT = Number(process.env.REQ_TIMEOUT || 30000) // 30 s
const PUBLIC_HOST = process.env.PUBLIC_HOST || 'r.dotrino.com'
const STATIC_DIR = process.env.STATIC_DIR || join(fileURLToPath(new URL('.', import.meta.url)), 'public')
// A quién va dirigida la firma del agente: el origen público del relay.
const AUDIENCE = process.env.AUDIENCE || `https://${PUBLIC_HOST}`
const HELLO_TIMEOUT = 15000 // para contestar al reto

// registry: key -> { ws, since, profileId } ; pending: reqId -> { res, timer }
const tunnels = new Map()
const pending = new Map()
// FRESCURA: el `seq` más alto visto por cuenta. Una cadena vieja sigue verificando (es la
// limitación declarada de `verifySignedBy`), así que un aparato que ya quitaste podría
// seguir entrando con la que guardó. Una vez visto un acta más nueva de esa cuenta, lo
// anterior no entra. En memoria: tras reiniciar el relay se aprende otra vez.
const freshest = new Map()

const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj))
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': b.length, 'access-control-allow-origin': '*' })
  res.end(b)
}

// Cabeceras hop-by-hop que no se reenvían.
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host'])
const cleanHeaders = (h) => {
  const out = {}
  for (const [k, v] of Object.entries(h || {})) if (!HOP.has(k.toLowerCase())) out[k] = v
  return out
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${PUBLIC_HOST}`)
  const segs = url.pathname.split('/').filter(Boolean)
  const first = segs[0]

  if (url.pathname === '/_health') {
    return json(res, 200, { ok: true, tunnels: tunnels.size, ts: Date.now() })
  }

  // ¿Es una request de túnel? primer segmento = llave registrada.
  if (first && KEY_RE.test(first) && tunnels.has(first)) {
    return handleTunnelRequest(req, res, first, '/' + segs.slice(1).join('/') + (url.search || ''))
  }
  // Llave con formato válido pero sin agente conectado → 502 claro.
  if (first && KEY_RE.test(first) && segs.length >= 1 && !tunnels.has(first)) {
    return json(res, 502, { error: 'tunnel not connected', key: first })
  }

  // Si no, servir la web de testing (estático).
  return serveStatic(req, res, url.pathname)
})

async function handleTunnelRequest (req, res, key, path) {
  const tun = tunnels.get(key)
  const chunks = []
  let size = 0
  let aborted = false
  req.on('data', (c) => {
    size += c.length
    if (size > MAX_BODY) { aborted = true; json(res, 413, { error: 'payload too large', limit: MAX_BODY }); req.destroy() }
    else chunks.push(c)
  })
  req.on('end', () => {
    if (aborted) return
    const id = randomUUID()
    const body = chunks.length ? Buffer.concat(chunks).toString('base64') : null
    const msg = { type: 'req', id, method: req.method, path, headers: cleanHeaders(req.headers), body }
    let sent
    try { sent = safeSend(tun.ws, msg) } catch { sent = false }
    if (!sent) return json(res, 502, { error: 'tunnel not connected', key })
    const timer = setTimeout(() => {
      pending.delete(id)
      if (!res.headersSent) json(res, 504, { error: 'tunnel timeout' })
    }, REQ_TIMEOUT)
    pending.set(id, { res, timer })
  })
}

function deliverResponse (m) {
  const p = pending.get(m.id)
  if (!p) return
  clearTimeout(p.timer); pending.delete(m.id)
  const { res } = p
  // CORS lo decide el agente/host (configurable); el relay solo pasa lo que venga.
  const headers = cleanHeaders(m.headers)
  const buf = m.body ? Buffer.from(m.body, 'base64') : Buffer.alloc(0)
  if (buf.length > MAX_BODY) return json(res, 502, { error: 'response too large', limit: MAX_BODY })
  delete headers['content-length']
  try {
    res.writeHead(m.status || 200, headers)
    res.end(buf)
  } catch { /* cliente ya cerró */ }
}

/* ---------------- estático (web de testing) ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon', '.woff2': 'font/woff2' }
async function serveStatic (req, res, pathname) {
  let rel = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, '')
  if (rel === '/' || rel === '\\') rel = '/index.html'
  let file = join(STATIC_DIR, rel)
  try {
    const s = await stat(file)
    if (s.isDirectory()) file = join(file, 'index.html')
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' })
    return res.end(data)
  } catch {
    // SPA fallback
    try {
      const data = await readFile(join(STATIC_DIR, 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' })
      return res.end(data)
    } catch {
      return json(res, 404, { error: 'not found' })
    }
  }
}

/* ---------------- WebSocket de agentes ---------------- */
const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${PUBLIC_HOST}`)
  if (url.pathname !== '/_agent') { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (ws) => challengeAgent(ws))
})

function safeSend (ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return false
  ws.send(JSON.stringify(obj))
  return true
}

/** Manda el reto y espera la prueba. Nada se registra antes de verificarla. */
function challengeAgent (ws) {
  const challenge = randomUUID()
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })
  ws.on('error', () => {})
  const timer = setTimeout(() => reject(ws, 'no-hello'), HELLO_TIMEOUT)
  ws.once('message', async (data) => {
    clearTimeout(timer)
    let m
    try { m = JSON.parse(data) } catch { return reject(ws, 'shape') }
    if (m?.type !== 'hello') return reject(ws, 'shape')
    const reason = await checkHello(m, challenge)
    if (typeof reason === 'string') return reject(ws, reason)
    registerAgent(ws, reason)
  })
  safeSend(ws, { type: 'challenge', challenge })
}

/** El motivo del rechazo, o `{ key, profileId }` si la prueba vale. */
async function checkHello (m, challenge) {
  const { body, signature, publickey, chain } = m
  if (!body || body.op !== AGENT_OP || body.v !== AGENT_V) return 'shape'
  if (body.challenge !== challenge) return 'other-challenge'
  const v = await verifySignedFor({ data: body, signature, publickey, chain, audience: AUDIENCE })
  if (!v.ok) return v.reason
  if (v.seq < (freshest.get(v.profileId) ?? -1)) return 'stale-chain'
  freshest.set(v.profileId, v.seq)
  return { key: await tunnelKey(publickey), profileId: v.profileId }
}

function reject (ws, reason) {
  console.log(`[agent] rejected: ${reason}`)
  try { ws.close(CLOSE_REJECTED, String(reason).slice(0, 120)) } catch {}
}

function registerAgent (ws, { key, profileId }) {
  // un agente por llave: es el MISMO aparato en dos procesos; gana el último.
  const prev = tunnels.get(key)
  if (prev && prev.ws !== ws) { try { prev.ws.close(CLOSE_REPLACED, 'replaced') } catch {} }
  tunnels.set(key, { ws, since: Date.now(), profileId })
  safeSend(ws, { type: 'ready', key, url: `https://${PUBLIC_HOST}/${key}` })
  console.log(`[agent] connected key=${key} (${tunnels.size} tunnels)`)

  ws.on('message', (data) => {
    let m
    try { m = JSON.parse(data) } catch { return }
    if (m.type === 'res') deliverResponse(m)
    else if (m.type === 'pong') ws.isAlive = true
  })
  ws.on('close', () => {
    if (tunnels.get(key)?.ws === ws) { tunnels.delete(key); console.log(`[agent] disconnected key=${key}`) }
  })
}

// Heartbeat: descarta agentes muertos (Cloudflare corta WS ociosos ~100s).
const hb = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate() } catch {}; continue }
    ws.isAlive = false
    try { ws.ping() } catch {}
  }
}, 30000)
hb.unref?.()

server.listen(PORT, HOST, () => {
  console.log(`dotrino-tunnel relay on http://${HOST}:${PORT}  (public: https://${PUBLIC_HOST})`)
  console.log(`payload limit: ${(MAX_BODY / 1024).toFixed(0)} KB · timeout: ${REQ_TIMEOUT / 1000}s`)
  // §15: el relay se despliega desde git; lo que se le queda atrás es el checkout.
  watchCheckout({ dir: fileURLToPath(new URL('.', import.meta.url)), repo: 'imdotrino/dotrino-tunnel', name: 'tunnel-relay' })
})

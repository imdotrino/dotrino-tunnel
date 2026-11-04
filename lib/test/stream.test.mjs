/**
 * CUERPOS EN BINARIO, POR PARTES (STREAM_V). Lo que motivó el cambio, medido en Glassnote: un
 * panel con ~65 archivos y un vídeo de 1,6 MB atascaba el túnel. Se prueba que un archivo
 * grande pasa entero, que no frena a uno pequeño que va detrás, que una subida llega intacta,
 * que un agente viejo (JSON) sigue funcionando y que si el agente se va, el pedido falla ya.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { Identity } from '@dotrino/identity/node'
import { signedFor } from '@dotrino/identity/assertion'
import { createTunnel } from '../index.js'
import { answerChallenge } from '../shared.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RELAY = path.join(HERE, '..', '..', 'server', 'index.js')
const PORT = 7797
const SERVER = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-stream-'))
const newIdentity = (n) => Identity.connect({ dir: path.join(tmp, n) })
const sha = (b) => createHash('sha256').update(b).digest('hex')

const BIG = randomBytes(5 * 1024 * 1024)   // más de 1 MB: antes no pasaba
let relay, local, localPort
test.before(async () => {
  relay = spawn(process.execPath, [RELAY], { env: { ...process.env, PORT: String(PORT), PUBLIC_HOST: `127.0.0.1:${PORT}`, AUDIENCE: SERVER }, stdio: 'ignore' })
  // El servicio local: /big lo manda poco a poco (como un disco o una red lentos).
  local = http.createServer((req, res) => {
    if (req.url === '/big') {
      res.writeHead(200, { 'content-type': 'video/webm', 'content-length': BIG.length })
      let i = 0
      const step = () => { if (i >= BIG.length) return res.end(); res.write(BIG.subarray(i, i + 256 * 1024)); i += 256 * 1024; setTimeout(step, 30) }
      return step()
    }
    if (req.url === '/echo') {
      const parts = []
      req.on('data', (c) => parts.push(c))
      req.on('end', () => { const b = Buffer.concat(parts); res.end(JSON.stringify({ n: b.length, sha: sha(b) })) })
      return
    }
    res.end('small ' + req.url)
  })
  await new Promise((r) => local.listen(0, '127.0.0.1', r))
  localPort = local.address().port
  await sleep(900)
})
test.after(() => { relay?.kill(); local?.close(); fs.rmSync(tmp, { recursive: true, force: true }) })

test('un archivo de 5 MB pasa entero, con sus cabeceras', async () => {
  const t = await createTunnel({ server: SERVER, identity: await newIdentity('big'), quiet: true, target: localPort })
  await sleep(400)
  const r = await fetch(`${SERVER}/${t.key}/big`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'video/webm')
  const b = Buffer.from(await r.arrayBuffer())
  assert.equal(b.length, BIG.length)
  assert.equal(sha(b), sha(BIG))
  t.close()
})

test('uno pequeño no espera a que termine uno grande', async () => {
  const t = await createTunnel({ server: SERVER, identity: await newIdentity('hol'), quiet: true, target: localPort })
  await sleep(400)
  const t0 = Date.now()
  const big = fetch(`${SERVER}/${t.key}/big`).then(async (r) => { await r.arrayBuffer(); return Date.now() - t0 })
  await sleep(50)
  const small = fetch(`${SERVER}/${t.key}/a.css`).then(async (r) => { assert.equal(await r.text(), 'small /a.css'); return Date.now() - t0 })
  const [tb, ts] = await Promise.all([big, small])
  assert.ok(ts < tb / 2, `el pequeño tardó ${ts} ms y el grande ${tb} ms`)
  t.close()
})

test('muchos a la vez: todos llegan', async () => {
  const t = await createTunnel({ server: SERVER, identity: await newIdentity('many'), quiet: true, target: localPort })
  await sleep(400)
  const outs = await Promise.all(Array.from({ length: 65 }, (_, i) => fetch(`${SERVER}/${t.key}/f${i}.js`).then((r) => r.text())))
  outs.forEach((o, i) => assert.equal(o, `small /f${i}.js`))
  t.close()
})

test('una subida de 3 MB llega intacta (sin base64)', async () => {
  const t = await createTunnel({ server: SERVER, identity: await newIdentity('up'), quiet: true, target: localPort })
  await sleep(400)
  const up = randomBytes(3 * 1024 * 1024)
  const r = await fetch(`${SERVER}/${t.key}/echo`, { method: 'POST', body: up })
  assert.deepEqual(await r.json(), { n: up.length, sha: sha(up) })
  t.close()
})

test('un agente viejo, en JSON, sigue funcionando', async () => {
  const id = await newIdentity('legacy')
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/_agent`)
  const ready = new Promise((resolve) => ws.on('message', async (d) => {
    const m = JSON.parse(d)
    if (m.type === 'challenge') ws.send(JSON.stringify(await answerChallenge({ signedFor, identity: id, server: SERVER, challenge: m.challenge })))
    if (m.type === 'ready') { assert.equal(m.stream, undefined, 'a un agente viejo no se le ofrecen tramas'); resolve(m.key) }
    if (m.type === 'req') ws.send(JSON.stringify({ type: 'res', id: m.id, status: 200, headers: {}, body: Buffer.from('viejo ' + m.path).toString('base64') }))
  }))
  const key = await ready
  assert.equal(await (await fetch(`${SERVER}/${key}/x`)).text(), 'viejo /x')
  ws.close()
})

test('si el agente se va a mitad de pedido, falla en el acto (no a los 30 s)', async () => {
  const t = await createTunnel({ server: SERVER, identity: await newIdentity('gone'), quiet: true, target: () => new Promise(() => {}) })
  await sleep(400)
  const t0 = Date.now()
  const p = fetch(`${SERVER}/${t.key}/cuelga`)
  await sleep(200)
  t.close()
  const r = await p
  assert.equal(r.status, 502)
  assert.ok(Date.now() - t0 < 5000)
})

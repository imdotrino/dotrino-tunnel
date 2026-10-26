/**
 * El túnel es un aparato de la cuenta: la dirección sale de su llave y el relay pide que
 * firme un reto. Estas pruebas levantan el relay de verdad y cubren lo que eso cierra
 * (suplantar y colisionar) y lo que ya cubría antes (el desplazado se rinde, el candado).
 *
 * Cada identidad de prueba es una cuenta propia (`Identity` de Node con su carpeta trae su
 * génesis), así que su `signData` ya devuelve la cadena que verifica el relay.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { Identity } from '@dotrino/identity/node'
import { signedFor } from '@dotrino/identity/assertion'
import { createTunnel } from '../index.js'
import { tunnelKey, answerChallenge, CLOSE_REJECTED, CLOSE_REPLACED } from '../shared.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RELAY = path.join(HERE, '..', '..', 'server', 'index.js')
const PORT = 7799
const SERVER = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-test-'))
const newIdentity = (n) => Identity.connect({ dir: path.join(tmp, n) })

let relay, connections = 0
test.before(async () => {
  relay = spawn(process.execPath, [RELAY], {
    env: { ...process.env, PORT: String(PORT), PUBLIC_HOST: `127.0.0.1:${PORT}`, AUDIENCE: SERVER },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  relay.stdout.on('data', (d) => { connections += (String(d).match(/\[agent\] connected/g) || []).length })
  await sleep(900)
})
test.after(() => { relay?.kill(); fs.rmSync(tmp, { recursive: true, force: true }) })

/** Un agente a mano: contesta al reto con lo que le pasen y devuelve cómo acabó. */
function rawAgent (hello) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/_agent`)
    ws.on('message', async (d) => {
      const m = JSON.parse(d)
      if (m.type === 'challenge') ws.send(JSON.stringify(await hello(m.challenge)))
      if (m.type === 'ready') { resolve({ ready: m }); ws.close() }
    })
    ws.on('close', (code, reason) => resolve({ code, reason: String(reason) }))
  })
}

test('la dirección sale de la llave del aparato y el túnel atiende', async () => {
  const id = await newIdentity('a')
  const t = await createTunnel({ server: SERVER, identity: id, quiet: true, target: (req) => ({ status: 200, body: 'hola ' + req.path }) })
  assert.equal(t.key, await tunnelKey(id.me.publickey))
  await sleep(500)
  const r = await fetch(`${SERVER}/${t.key}/ruta`)
  assert.equal(await r.text(), 'hola /ruta')
  t.close()
})

test('suplantar: la llave pública de otro con mi firma no entra', async () => {
  const victim = await newIdentity('victim')
  const attacker = await newIdentity('attacker')
  const out = await rawAgent(async (challenge) => {
    const p = await answerChallenge({ signedFor, identity: attacker, server: SERVER, challenge })
    return { ...p, publickey: victim.me.publickey }
  })
  assert.equal(out.code, CLOSE_REJECTED)
  assert.ok(!out.ready)
})

test('repetir una prueba vieja no sirve: el reto es otro', async () => {
  const id = await newIdentity('replay')
  const old = await answerChallenge({ signedFor, identity: id, server: SERVER, challenge: 'reto-de-otra-conexion' })
  const out = await rawAgent(async () => old)
  assert.equal(out.code, CLOSE_REJECTED)
  assert.equal(out.reason, 'other-challenge')
})

test('una prueba para otro relay no vale aquí', async () => {
  const id = await newIdentity('aud')
  const out = await rawAgent((challenge) => answerChallenge({ signedFor, identity: id, server: 'https://otro.example', challenge }))
  assert.equal(out.code, CLOSE_REJECTED)
  assert.match(out.reason, /audience/)
})

test('sin prueba no hay túnel, aunque se pida una dirección', async () => {
  const id = await newIdentity('nokey')
  const key = await tunnelKey(id.me.publickey)
  const out = await rawAgent(async () => ({ type: 'hello', key }))
  assert.equal(out.code, CLOSE_REJECTED)
  const r = await fetch(`${SERVER}/${key}/x`)
  assert.equal(r.status, 502)
})

test('dos aparatos, dos direcciones: no colisionan', async () => {
  const a = await createTunnel({ server: SERVER, identity: await newIdentity('c1'), quiet: true, target: () => ({ status: 200, body: 'uno' }) })
  const b = await createTunnel({ server: SERVER, identity: await newIdentity('c2'), quiet: true, target: () => ({ status: 200, body: 'dos' }) })
  assert.notEqual(a.key, b.key)
  await sleep(500)
  assert.equal(await (await fetch(`${SERVER}/${a.key}/`)).text(), 'uno')
  assert.equal(await (await fetch(`${SERVER}/${b.key}/`)).text(), 'dos')
  a.close(); b.close()
})

// El relay solo admite un agente por aparato y cierra al anterior con 4001. Antes el
// desplazado reconectaba y, como la conexión sí tenía éxito, las dos copias se echaban una
// vez por segundo, para siempre y en silencio (11 días con el bot de Telegram).
test('el MISMO aparato desde otra máquina: el desplazado se rinde', async () => {
  const id = await newIdentity('dup')
  const before = connections
  let replaced = false
  const a = await createTunnel({ server: SERVER, identity: id, quiet: true, target: 9999, onReplaced: () => { replaced = true } })
  await sleep(400)
  // `lock: false`: se simula la otra máquina, que el candado local no puede ver.
  const b = await createTunnel({ server: SERVER, identity: id, quiet: true, target: 9999, lock: false })
  await sleep(4000)
  a.close(); b.close()
  assert.equal(replaced, true)
  assert.ok(connections - before <= 3, `forcejeo: ${connections - before} conexiones`)
  assert.equal(CLOSE_REPLACED, 4001)
})

test('el mismo aparato dos veces en esta máquina: el segundo no arranca', async () => {
  const id = await newIdentity('lock')
  const opts = { server: 'http://127.0.0.1:7788', identity: id, quiet: true, target: 9999 }
  const a = await createTunnel(opts)
  await assert.rejects(createTunnel(opts), (e) => e.code === 'TUNNEL_KEY_IN_USE' && e.pid === process.pid)
  a.close()
  const b = await createTunnel(opts)
  b.close()
})

test('un túnel sin enrolar lo dice y no se conecta', async () => {
  await assert.rejects(createTunnel({ server: SERVER, dir: path.join(tmp, 'vacio'), quiet: true }), (e) => e.code === 'TUNNEL_NOT_ENROLLED')
})

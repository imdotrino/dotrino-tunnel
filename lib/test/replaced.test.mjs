/**
 * Dos agentes con la MISMA llave: el relay solo admite uno, así que cierra al anterior
 * con 4001 «replaced». El desplazado tiene que RENDIRSE.
 *
 * Antes reconectaba, y como la conexión sí tenía éxito el backoff se reiniciaba: las dos
 * copias se echaban una vez por segundo, para siempre y en silencio. Estuvo pasando 11
 * días con dos copias del bot de Telegram arrancadas desde la misma carpeta, y solo se
 * notó al leer los logs del relay por otra cosa.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createTunnel } from '../index.js'

const AQUI = path.dirname(fileURLToPath(import.meta.url))
const RELAY = path.join(AQUI, '..', '..', 'server', 'index.js')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

test('el agente desplazado se rinde en vez de forcejear', async () => {
  const PORT = 7799
  const relay = spawn(process.execPath, [RELAY], {
    env: { ...process.env, PORT: String(PORT), PUBLIC_HOST: `localhost:${PORT}` },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let conexiones = 0
  relay.stdout.on('data', (d) => { if (/conectado/.test(String(d))) conexiones++ })
  await sleep(900)

  const opts = { server: `http://127.0.0.1:${PORT}`, key: 'llaveCompartidaDePrueba12345', target: 9999, quiet: true }
  let desplazado = false
  const a = createTunnel({ ...opts, onReplaced: () => { desplazado = true } })
  await sleep(400)
  const b = createTunnel(opts)          // el segundo desplaza al primero

  await sleep(6000)
  try { a.close?.(); b.close?.() } catch (_) {}
  relay.kill()

  assert.equal(desplazado, true, 'al desplazado se le avisa')
  // Una por agente. Sin el arreglo, en 6 s se registraban ~13.
  assert.ok(conexiones <= 3, `forcejeo: ${conexiones} conexiones en 6 s`)
})

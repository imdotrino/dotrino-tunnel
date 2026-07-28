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
  // `lock: false` porque aquí se simula un agente de OTRA máquina: el candado local
  // (que sí impide dos en la misma) no puede saber nada de él. Este test cubre justo lo
  // que el candado NO alcanza.
  const b = createTunnel({ ...opts, lock: false })

  await sleep(6000)
  try { a.close?.(); b.close?.() } catch (_) {}
  relay.kill()

  assert.equal(desplazado, true, 'al desplazado se le avisa')
  // Una por agente. Sin el arreglo, en 6 s se registraban ~13.
  assert.ok(conexiones <= 3, `forcejeo: ${conexiones} conexiones en 6 s`)
})

test('dos agentes con la MISMA llave en esta máquina: el segundo no arranca', async () => {
  const opts = { server: 'http://127.0.0.1:7788', key: 'llaveParaElCandado1234567', target: 9999, quiet: true }
  const a = createTunnel(opts)
  assert.throws(() => createTunnel(opts), /ya hay un túnel con esta llave/i,
    'el segundo falla con un mensaje que dice qué hacer')
  try { createTunnel(opts) } catch (e) {
    assert.equal(e.code, 'TUNNEL_KEY_EN_USO')
    assert.equal(e.pid, process.pid, 'y dice QUÉ proceso la tiene')
  }
  a.close()
  // Soltado el candado, otro agente sí puede tomar esa llave.
  const b = createTunnel(opts)
  b.close()
})

test('llaves DISTINTAS conviven, aunque sean del mismo directorio', async () => {
  const base = { server: 'http://127.0.0.1:7788', target: 9999, quiet: true }
  const a = createTunnel({ ...base, key: 'llaveDelBotUno1234567890' })
  const b = createTunnel({ ...base, key: 'llaveDelBotDos1234567890' })
  a.close(); b.close()
})

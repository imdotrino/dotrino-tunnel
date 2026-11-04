/**
 * EL RELAY SE REINICIA Y EL AGENTE SIGUE (tunnel 0.5.1). El temporizador de reconexión iba con
 * `unref()`: al cerrarse el WebSocket no quedaba nada que retuviera el proceso, y Node salía
 * con código 0, sin una línea. Le pasó tres veces a Glassnote. Aquí el agente corre en su
 * propio proceso, como en la vida real, y se reinicia el relay debajo.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const RELAY = path.join(HERE, '..', '..', 'server', 'index.js')
const PORT = 7793
const SERVER = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-restart-'))
const startRelay = () => spawn(process.execPath, [RELAY], { env: { ...process.env, PORT: String(PORT), PUBLIC_HOST: `127.0.0.1:${PORT}`, AUDIENCE: SERVER }, stdio: 'ignore' })

test('reiniciar el relay no mata al agente: se reconecta y vuelve a atender', async () => {
  let relay = startRelay()
  await sleep(900)
  const script = `
    import { createTunnel } from ${JSON.stringify(path.join(HERE, '..', 'index.js'))}
    const t = await createTunnel({ server: ${JSON.stringify(SERVER)}, dir: ${JSON.stringify(path.join(tmp, 'dev'))}, quiet: true, target: () => ({ status: 200, body: 'vivo' }) })
    console.log(t.key)
  `
  const agent = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
  let exited = null
  agent.on('exit', (code) => { exited = code })
  const key = await new Promise((resolve) => agent.stdout.once('data', (d) => resolve(String(d).trim())))
  await sleep(600)
  assert.equal(await (await fetch(`${SERVER}/${key}/`)).text(), 'vivo')

  relay.kill(); await new Promise((r) => relay.once('exit', r))
  await sleep(1500)
  assert.equal(exited, null, `el agente salió con código ${exited} al caerse el relay`)
  relay = startRelay()
  await sleep(4000)   // backoff del agente (≤ 2 s tras dos intentos) + arranque del relay
  try {
    assert.equal(exited, null, `el agente salió con código ${exited}`)
    assert.equal(await (await fetch(`${SERVER}/${key}/`)).text(), 'vivo', 'volvió a atender la misma dirección')
  } finally {
    agent.kill(); relay.kill(); fs.rmSync(tmp, { recursive: true, force: true })
  }
})

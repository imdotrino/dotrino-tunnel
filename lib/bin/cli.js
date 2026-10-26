#!/usr/bin/env node
/**
 * dotrino-tunnel — CLI del túnel reverso de Dotrino.
 *
 *   dotrino-tunnel 3000                 # expone http://localhost:3000 (enrola la primera vez)
 *   dotrino-tunnel http://localhost:8080/api
 *   dotrino-tunnel 3000 --name api      # otro túnel = otro aparato de tu cuenta
 *   dotrino-tunnel enroll [--name n]    # enrola (o re-enrola) este túnel en tu bóveda
 *   dotrino-tunnel info [--name n]      # qué aparato es: su ID, su bóveda, sus permisos
 *   dotrino-tunnel list                 # los túneles enrolados en esta máquina
 *   dotrino-tunnel update [--name n] [--approval on|off] [--notify on|off]
 */
import { readFileSync } from 'node:fs'
import readline from 'node:readline'
import { updatePrefsCommand, updateStatusText } from '@dotrino/update/npm'
import { parseQr, loadLink } from '@dotrino/remote-agent/link'
import { lockInstance } from '@dotrino/remote-agent/instances'
import { deviceInfo, formatDeviceInfo } from '@dotrino/vault/device-info'
import { createTunnel, enrollTunnel, tunnelInstance, listTunnels, TUNNEL_KIND } from '../index.js'
import { startSelfUpdate } from '../update.js'

const { version: VERSION } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const has = (name) => argv.includes('--' + name)
const VALUED = new Set(['--name', '--server', '--cors', '--dir'])
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUED.has(argv[i - 1]))
const cmd = positional[0]

if (has('help') || argv.length === 0) {
  console.log(`dotrino-tunnel — túnel reverso autohospedado de Dotrino

Cada túnel es un aparato de tu cuenta: se enrola una vez en tu bóveda y su
dirección pública sale de su propia llave. Nadie puede usar la dirección de otro.

Uso:
  dotrino-tunnel <puerto|url> [opciones]   abre el túnel (la primera vez, lo enrola)
  dotrino-tunnel enroll [--name <n>]       enrola (o re-enrola) este túnel
  dotrino-tunnel info [--name <n>] [--json] qué aparato es: su ID, para «dotrino-vault members»
  dotrino-tunnel list                      los túneles enrolados en esta máquina
  dotrino-tunnel update [--name <n>]       cómo se actualiza este túnel. Por defecto lo hace
                                           solo, sin preguntar, y avisa a tu bóveda.
                                           --approval on: pide permiso a tus aparatos «aprueba»
                                           --notify off: no avisa de que se actualizó
                                           (se actualiza solo si lo instalaste con npm i -g;
                                           con npx no)

Ejemplos:
  dotrino-tunnel 3000
  dotrino-tunnel http://localhost:8080/api --name api

Opciones:
  --name <n>     Qué túnel (cada nombre es otro aparato). Por defecto «default».
  --dir <d>      Carpeta del aparato, en vez de la del nombre.
  --server <u>   Relay a usar (def: https://r.dotrino.com)
  --cors <orig>  Añade CORS a las respuestas (p.ej. '*' o https://tu-sitio.com)
  --quiet        No imprime cada request
  --help         Esta ayuda
`)
  process.exit(0)
}

const instance = () => opt('dir') ? { name: null, dir: opt('dir') } : tunnelInstance(opt('name'))

if (cmd === 'list') {
  const names = listTunnels()
  console.log(names.length ? names.join('\n') : 'No hay túneles enrolados en esta máquina. Abre uno con: dotrino-tunnel <puerto>')
  process.exit(0)
}

// `update`: los dos ajustes de ESTE túnel (`@dotrino/update/npm`). Sin banderas, los enseña.
if (cmd === 'update') {
  const own = argv.filter((a, i) => a === '--approval' || a === '--notify' || ['--approval', '--notify'].includes(argv[i - 1]))
  const r = updatePrefsCommand(own, { dir: instance().dir, lang: 'es' })
  if (!r.handled) { console.error('uso: dotrino-tunnel update [--name <n>] [--approval on|off] [--notify on|off]'); process.exit(2) }
  ;(r.ok ? console.log : console.error)(r.text)
  process.exit(r.ok ? 0 : 1)
}

// §15.1: qué aparato es, sin red. Su ID es el de «dotrino-vault members».
if (cmd === 'info') {
  const inst = instance()
  const link = loadLink(inst.dir)
  if (!link) { console.error(`Este túnel no está enrolado (${inst.dir}). Enrólalo con: dotrino-tunnel enroll${inst.name ? ' --name ' + inst.name : ''}`); process.exit(1) }
  const info = await deviceInfo(link, { kind: TUNNEL_KIND, name: inst.name, version: VERSION, dir: inst.dir })
  const pending = updateStatusText({ dir: inst.dir, current: VERSION, lang: 'es' })
  if (has('json')) console.log(JSON.stringify(pending ? { ...info, update: pending } : info, null, 2))
  else console.log(formatDeviceInfo(info) + (pending ? '\n' + pending : ''))
  process.exit(0)
}

const ask = (q) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  rl.question(q, (a) => { rl.close(); resolve(a) })
})

async function doEnroll (dir) {
  console.log('Enrolar este túnel como un aparato de tu cuenta.')
  console.log('La invitación la generas en tu bóveda:')
  console.log('  · Sin bóveda en un PC → abre https://profile.dotrino.com/myvault y genera un código de emparejamiento.')
  console.log('  · Con bóveda en un PC → ahí corre `dotrino-vault pair` y copia el QR/JSON.\n')
  const qr = await parseQr(await ask('Pega la invitación y Enter:\n> '))
  console.log('\nConectando…')
  await enrollTunnel({
    qr, dir,
    onChallenge: ({ deviceId, code }) => {
      console.log('\n  Escribe ESTE código en tu bóveda para aprobar este túnel:')
      console.log(`    código: ${code}`)
      console.log(`    aparato: ${deviceId}`)
      console.log(`    (en el PC de la bóveda: dotrino-vault approve ${code})\n`)
      console.log('  Esperando aprobación…')
    }
  })
  console.log('\n  ✓ Túnel enrolado.\n')
}

try {
  const inst = instance()
  // Antes de nada, también de enrolar: re-enrolar debajo de un túnel abierto le cambia la
  // llave (y la dirección) a mitad de camino.
  process.on('exit', lockInstance(inst.dir))

  if (cmd === 'enroll' || !loadLink(inst.dir)) {
    if (!process.stdin.isTTY) {
      console.error('Este túnel no está enrolado y no hay terminal para hacerlo.')
      console.error(`Enrólalo antes en una terminal: dotrino-tunnel enroll${inst.name ? ' --name ' + inst.name : ''}`)
      process.exit(1)
    }
    if (cmd === 'enroll' && loadLink(inst.dir)) console.log('Re-enrolando: este túnel tendrá una llave y una dirección nuevas.\n')
    await doEnroll(inst.dir)
    if (cmd === 'enroll') process.exit(0)
  }

  const targetArg = positional[0]
  const target = /^\d+$/.test(targetArg) ? Number(targetArg) : targetArg
  const server = opt('server') || 'https://r.dotrino.com'
  const quiet = has('quiet')

  const tun = await createTunnel({
    target, server, dir: inst.dir, cors: opt('cors'), quiet: true,
    // el candado de la instancia ya lo tiene este proceso
    lock: false,
    onReady: (url) => {
      console.log('\n  ⟲ dotrino-tunnel')
      console.log('  ───────────────────────────────────────────')
      console.log('  target  → ' + (typeof target === 'number' ? 'http://localhost:' + target : target))
      console.log('  público → ' + url)
      if (inst.name) console.log('  túnel   → ' + inst.name)
      console.log('  ───────────────────────────────────────────')
      console.log('  (Ctrl+C para cerrar)\n')
    },
    onRejected: (_reason, message) => { console.error('\n  ✗ ' + message + '\n'); process.exit(1) },
    onReplaced: () => { console.error('\n  ✗ Otra copia abrió este mismo túnel. Esta se cierra.\n'); process.exit(1) },
    onRequest: quiet ? undefined : (r) => console.log(`  ${new Date().toLocaleTimeString()}  ${r.method.padEnd(6)} ${r.path}`),
  })

  // §15: un túnel puede quedarse abierto días. Mira al arrancar y una vez al día; se instala
  // solo si es una instalación global de este usuario, y se reinicia si hay quien lo levante.
  startSelfUpdate({ dir: inst.dir, version: VERSION, tunnel: tun, log: (m) => console.log('  ' + m) })

  process.on('SIGINT', () => { console.log('\ncerrando túnel…'); tun.close(); process.exit(0) })
} catch (e) {
  console.error('\n  ✗ ' + (e.message || e) + '\n')
  process.exit(1)
}

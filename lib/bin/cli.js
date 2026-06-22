#!/usr/bin/env node
/**
 * dotrino-tunnel — CLI del túnel reverso de Dotrino.
 *
 *   dotrino-tunnel 3000                 # expone http://localhost:3000
 *   dotrino-tunnel http://localhost:8080/api
 *   dotrino-tunnel 3000 --key MiLlaveSecreta1234XYZ
 *   dotrino-tunnel 3000 --server https://r.dotrino.com
 */
import { createTunnel, generateKey } from '../index.js'

const argv = process.argv.slice(2)
const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
const has = (name) => argv.includes('--' + name)

if (has('help') || argv.length === 0) {
  console.log(`dotrino-tunnel — túnel reverso (ngrok autohospedado) de Dotrino

Uso:
  dotrino-tunnel <puerto|url> [opciones]

Ejemplos:
  dotrino-tunnel 3000
  dotrino-tunnel http://localhost:8080/api
  dotrino-tunnel 3000 --key <llave 16-48 alfanum>
  dotrino-tunnel 3000 --server https://r.dotrino.com

Opciones:
  --key <k>      Llave del túnel (va en la URL pública). Por defecto se genera.
  --server <u>   Relay a usar (def: https://r.dotrino.com)
  --quiet        No imprime cada request
  --help         Esta ayuda
`)
  process.exit(0)
}

const targetArg = argv.find((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1]?.startsWith('--') !== true) || argv[0]
const target = /^\d+$/.test(targetArg) ? Number(targetArg) : targetArg
const key = opt('key') || generateKey()
const server = opt('server') || 'https://r.dotrino.com'
const quiet = has('quiet')

const tun = createTunnel({
  target, key, server, quiet: true,
  onReady: (url) => {
    console.log('\n  ⟲ dotrino-tunnel')
    console.log('  ───────────────────────────────────────────')
    console.log('  target  → ' + (typeof target === 'number' ? 'http://localhost:' + target : target))
    console.log('  público → ' + url)
    console.log('  llave   → ' + key)
    console.log('  ───────────────────────────────────────────')
    console.log('  (Ctrl+C para cerrar)\n')
  },
  onRequest: quiet ? undefined : (r) => console.log(`  ${new Date().toLocaleTimeString()}  ${r.method.padEnd(6)} ${r.path}`),
})

process.on('SIGINT', () => { console.log('\ncerrando túnel…'); tun.close(); process.exit(0) })

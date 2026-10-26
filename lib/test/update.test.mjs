/**
 * La autoactualización pregunta a la bóveda del ENLACE de este túnel. Sin enlace no hay a
 * quién preguntar: eso no es un «no», es un error que se reintenta (`not-linked`).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { vaultHooks, PKG, REPO } from '../update.js'

test('sin enlace, pedir permiso lanza not-linked (no cuenta como negativa)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tunnel-update-'))
  const h = vaultHooks({ dir, log: () => {} })
  await assert.rejects(h.mayUpdate({ version: '9.9.9' }), (e) => e.code === 'not-linked')
  await h.onUpdated({ version: '9.9.9' })   // sin bóveda a la que contárselo: no falla
  fs.rmSync(dir, { recursive: true, force: true })
})

test('mira el paquete y el repo de este túnel', () => {
  assert.equal(PKG, '@dotrino/tunnel')
  assert.equal(REPO, 'imdotrino/dotrino-tunnel')
})

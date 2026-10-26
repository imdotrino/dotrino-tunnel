/**
 * update.js — el túnel SE ACTUALIZA SOLO (CONVENCIONES §15, dueño 2026-10-08).
 *
 * Lo que mira, verifica e instala es `@dotrino/update/npm`; a quién se pregunta y a quién se
 * avisa es `@dotrino/vault/service`. Aquí solo se juntan las dos piezas con dónde vive el
 * enlace de este túnel (cada `--name` es un aparato, con sus propios ajustes).
 *
 * Los dos ajustes son de CADA túnel (`dotrino-tunnel update --approval|--notify`), no de la
 * bóveda: por defecto se actualiza sin preguntar y avisa de que lo hizo. Solo se instala si
 * el paquete es una instalación global de este usuario: con `npx` lo dice y no intenta nada.
 */
import { watchSelfUpdateNpm } from '@dotrino/update/npm'
import { vaultUpdateHooks } from '@dotrino/vault/service'
import { loadLink } from '@dotrino/remote-agent/link'

export const PKG = '@dotrino/tunnel'
export const REPO = 'imdotrino/dotrino-tunnel'

const fail = (code, message) => Object.assign(new Error(message), { code })

/**
 * Los tres ganchos de `vaultUpdateHooks`, armados EN CADA LLAMADA con el enlace leído del
 * disco: el papel se renueva mientras el túnel corre, y una conexión fijada al arrancar se
 * quedaría vieja.
 *
 * @param {{ dir: string, log?: (m: string) => void }} o
 */
export function vaultHooks ({ dir, log = console.log }) {
  const now = () => {
    const link = loadLink(dir)
    if (!link?.device || !link.cert || !link.iss) return null
    return vaultUpdateHooks({ product: PKG, log, proxyUrl: link.proxy || 'wss://proxy.dotrino.com', masterPubkey: link.iss, device: link.device, cert: link.cert })
  }
  return {
    // true = sí · false = no, o pasó el día sin respuesta · lanza = no se pudo preguntar.
    async mayUpdate (u) {
      const h = now()
      // Sin enlace no hay a quién preguntar. No es un «no»: se dice y se reintenta.
      if (!h) throw fail('not-linked', 'this tunnel is not linked to a vault, so there is nobody to ask')
      return h.mayUpdate(u)
    },
    async onUpdated (u) { await now()?.onUpdated(u) },
    async onNeedsRoot (u) { await now()?.onNeedsRoot(u) }
  }
}

/**
 * Enciende la autoactualización del túnel que ya corre. `dir` es la carpeta del aparato y
 * `version` la que está en marcha.
 *
 * @param {{ dir: string, version: string, tunnel: { close: () => void }, log?: (m: string) => void }} o
 * @returns {() => void} para dejar de mirar
 */
export function startSelfUpdate ({ dir, version, tunnel, log = console.log }) {
  const stop = watchSelfUpdateNpm({
    pkg: PKG,
    current: version,
    repo: REPO,
    dir,
    ...vaultHooks({ dir, log }),
    onInstalled: ({ version: v, restart }) => {
      // Sin quien lo levante no se va: irse sería apagarle el túnel al usuario.
      if (!restart) return
      log(`[tunnel] restarting to run ${v}`)
      tunnel.close()
      process.exit(0)
    },
    log
  })
  return () => stop?.()
}

export default { startSelfUpdate, vaultHooks, PKG, REPO }

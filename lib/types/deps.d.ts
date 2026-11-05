// Los pilares que usa el túnel y no publican tipos: aquí va lo que se usa de cada uno.

declare module '@dotrino/remote-agent/link' {
  /** El enlace de un aparato con su bóveda (o con su identidad propia), tal como se guarda en disco. */
  export interface Link {
    self?: boolean
    iss?: string
    proxy?: string
    device?: { publickey: string, privateJwk?: JsonWebKey }
    cert?: object
    acta?: object
    sealerChain?: Array<{ seq?: number, profileId?: string }>
  }
  /** Una identidad que firma como el aparato del enlace. */
  export interface LinkIdentity { me?: { publickey?: string } }
  export function loadLink (dir?: string): Link | null
  export function parseQr (text: string): Promise<object>
  export function enroll (args: {
    qr?: object | string
    label?: string
    dir?: string
    ns?: string | null
    onChallenge?: (c: { deviceId: string, code: string }) => void
    timeoutMs?: number
  }): Promise<Link>
  export function selfLink (args?: { label?: string, dir?: string }): Promise<Link>
  export function isSelfLink (link: Link | null | undefined): boolean
  export function identityFromLink (link: Link, opts?: { dir?: string }): LinkIdentity
  export function refreshChain (link: Link, opts?: { dir?: string | null }): Promise<{ ok: boolean, seq?: number, reason?: string }>
}

declare module '@dotrino/remote-agent/instances' {
  /** Dónde vive la instancia `name` de un tipo de agente. */
  export function resolveInstance (kind: string, name?: string | null): { name: string, dir: string }
  export function listInstances (kind: string): string[]
  /** Candado de la instancia; devuelve cómo soltarlo. Lanza `EALREADY` si ya corre otra. */
  export function lockInstance (dir: string): () => void
}

declare module '@dotrino/identity/assertion' {
  /** Firma `fields` para el destinatario `aud` con la identidad dada. */
  export function signedFor (identity: unknown, opts?: { aud?: string, fields?: Record<string, unknown>, ttlMs?: number, now?: number }): Promise<object>
}

declare module '@dotrino/vault/device-info' {
  export interface DeviceInfo {
    id: string
    vault: string | null
    scope: string[]
    record: number | null
    legacyExpires: number | null
    proxy: string | null
    publickey: string
    [extra: string]: unknown
  }
  export function deviceInfo (link: object, extra?: Record<string, unknown>): Promise<DeviceInfo>
  export function formatDeviceInfo (info: DeviceInfo): string
}

declare module '@dotrino/vault/service' {
  type UpdateEvent = { version: string, from?: string | null }
  /** Los ganchos de la autoactualización que preguntan y avisan a la bóveda. */
  export function vaultUpdateHooks (opts: {
    product: string
    log?: (m: string) => void
    dir?: string
    proxyUrl?: string
    masterPubkey?: string
    device?: object
    cert?: object
  }): {
    mayUpdate: (u: UpdateEvent) => Promise<boolean>
    onUpdated: (u: UpdateEvent) => Promise<void>
    onNeedsRoot: (u: UpdateEvent) => Promise<void>
  }
}

declare module '@dotrino/update/npm' {
  type UpdateEvent = { version: string, from?: string | null }
  /** Mira e instala versiones nuevas de `pkg` (al arrancar y una vez al día). Devuelve cómo pararlo. */
  export function watchSelfUpdateNpm (opts: {
    pkg: string
    current: string
    repo: string
    dir?: string
    log?: (m: string) => void
    mayUpdate?: (u: UpdateEvent) => Promise<boolean>
    onUpdated?: (u: UpdateEvent) => Promise<void>
    onNeedsRoot?: (u: UpdateEvent) => Promise<void>
    onInstalled?: (r: { version: string, restart: boolean }) => void
  }): (() => void) | undefined
  /** `--approval` / `--notify` de la CLI de cada agente: no imprime, devuelve qué imprimir. */
  export function updatePrefsCommand (args: string[], opts: { dir: string, lang?: string }): { handled: boolean, ok: boolean, text: string }
  /** Una línea con la actualización pendiente, o null. */
  export function updateStatusText (opts: { dir: string, current: string, lang?: string }): string | null
}

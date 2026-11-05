// @dotrino/identity/assertion no publica tipos: aquí va lo que la web usa de él.
declare module '@dotrino/identity/assertion' {
  /** Firma `fields` para el destinatario `aud` con la identidad dada. */
  export function signedFor (identity: unknown, opts?: { aud?: string, fields?: Record<string, unknown>, ttlMs?: number, now?: number }): Promise<object>
}

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, markRaw } from 'vue'
import { Identity } from '@dotrino/identity'
import { signedFor } from '@dotrino/identity/assertion'
import { tunnelKey, agentWsUrl, answerChallenge, corsHeadersFor, CLOSE_REJECTED, CLOSE_REPLACED } from '../../lib/shared.js'   // lo mismo que usa el agente

/* ---------------- i18n ---------------- */
const I18N = {
  es: {
    tagline: 'Expón este navegador en una URL pública e inspecciona lo que llega. Cada request que entre a tu URL aparece abajo, y tú decides qué responder.',
    yourUrl: 'Tu URL pública', copy: 'Copiar', copied: 'Copiado',
    status: 'Estado', connected: 'Conectado', connecting: 'Conectando…', disconnected: 'Desconectado', rejected: 'Rechazado',
    noIdentity: 'Para abrir tu URL hace falta un perfil de Dotrino en este navegador. Créalo o elígelo con el botón de perfil, arriba.',
    rejectedWhy: 'Este navegador no pudo demostrar que es de tu cuenta, así que tu URL no se abre. Motivo:',
    replaced: 'Este navegador abrió tu URL en otra pestaña. Esta se queda en pausa.',
    response: 'Respuesta automática', mode: 'Modo', fixed: 'Fija', echo: 'Eco (devuelve la request)',
    code: 'Código', ctype: 'Content-Type', body: 'Cuerpo',
    cors: 'CORS (Allow-Origin)', corsPh: '*  o  https://tu-sitio.com   (vacío = sin CORS)',
    inspector: 'Requests entrantes', none: 'Aún no llega ninguna request. Abre tu URL pública o mándale un webhook.',
    clear: 'Limpiar', headers: 'Cabeceras', reqbody: 'Cuerpo', empty: '(vacío)',
    hintCurl: 'Pruébalo:', privacy: 'Todo ocurre en tu navegador. Tu URL es de este navegador: sale de su llave y solo él puede atenderla. Quien tenga la URL puede mandarle peticiones.',
    cli: 'Para exponer un puerto local de verdad, usa la CLI:',
    cliNoNode: '¿No tienes Node? Un comando lo resuelve:',
  },
  en: {
    tagline: 'Expose this browser at a public URL and inspect what arrives. Every request to your URL shows up below, and you decide what to answer.',
    yourUrl: 'Your public URL', copy: 'Copy', copied: 'Copied',
    status: 'Status', connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected', rejected: 'Rejected',
    noIdentity: 'To open your URL you need a Dotrino profile in this browser. Create or pick one with the profile button above.',
    rejectedWhy: 'This browser could not prove it belongs to your account, so your URL does not open. Reason:',
    replaced: 'This browser opened your URL in another tab. This one stays paused.',
    response: 'Automatic response', mode: 'Mode', fixed: 'Fixed', echo: 'Echo (returns the request)',
    code: 'Code', ctype: 'Content-Type', body: 'Body',
    cors: 'CORS (Allow-Origin)', corsPh: '*  or  https://your-site.com   (empty = no CORS)',
    inspector: 'Incoming requests', none: 'No requests yet. Open your public URL or send it a webhook.',
    clear: 'Clear', headers: 'Headers', reqbody: 'Body', empty: '(empty)',
    hintCurl: 'Try it:', privacy: 'Everything happens in your browser. Your URL belongs to this browser: it comes from its key and only it can answer. Whoever has the URL can send it requests.',
    cli: 'To expose a real local port, use the CLI:',
    cliNoNode: 'No Node? One command solves it:',
  },
}
// El idioma lo lleva <dotrino-topbar>: persiste la preferencia, pone
// document.documentElement.lang y avisa por `dotrino-lang`. Aqui solo se escucha.
const lang = ref((navigator.language || 'es').slice(0, 2) === 'en' ? 'en' : 'es')
const t = computed(() => I18N[lang.value])
const onLang = (e) => { lang.value = e.detail.lang }

/* ---------------- identidad + relay ---------------- */
// Este navegador ES el aparato: su llave da la dirección y firma el reto del relay. Por eso
// ya no hay «nueva llave»: la dirección es la de este navegador y nadie más puede atenderla.
const RELAY = import.meta.env.VITE_RELAY || location.origin
const topbar = ref(null)
let identity = null           // nunca en un ref: el Proxy de Vue rompe el postMessage
const key = ref('')
const publicUrl = computed(() => key.value ? `${RELAY.replace(/\/$/, '')}/${key.value}` : '')
const rejectReason = ref('')

/* ---------------- respuesta configurable ---------------- */
const resMode = ref('fixed')         // fixed | echo
const resStatus = ref(200)
const resType = ref('application/json')
const resBody = ref('{\n  "ok": true,\n  "from": "dotrino-tunnel"\n}')
const cors = ref(localStorage.getItem('tunnel.cors') || '')
watch(cors, (v) => localStorage.setItem('tunnel.cors', v))
const corsHeaders = () => corsHeadersFor(cors.value) || {}

/* ---------------- estado WS ---------------- */
const status = ref('connecting')     // connecting | connected | disconnected | noIdentity | rejected | replaced
const requests = ref([])
let ws = null, closed = false, backoff = 500

function connect () {
  if (closed) return
  status.value = 'connecting'
  ws = new WebSocket(agentWsUrl(RELAY))
  ws.onopen = () => { backoff = 500 }
  ws.onmessage = async (ev) => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.type === 'challenge') {
      try { send(await answerChallenge({ signedFor, identity, server: RELAY, challenge: m.challenge })) } catch (e) {
        // `no-chain`: el navegador no tiene con qué probar que es de una cuenta.
        closed = true; rejectReason.value = e.code || e.message; status.value = 'rejected'; try { ws.close() } catch {}
      }
    } else if (m.type === 'ready') status.value = 'connected'
    else if (m.type === 'req') onReq(m)
  }
  ws.onclose = (ev) => {
    if (closed) return
    // Rechazado o desplazado: reintentar no cambia nada. Se para y se dice.
    if (ev.code === CLOSE_REJECTED) { closed = true; rejectReason.value = ev.reason || 'unknown'; status.value = 'rejected'; return }
    if (ev.code === CLOSE_REPLACED) { closed = true; status.value = 'replaced'; return }
    status.value = 'disconnected'; setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000)
  }
  ws.onerror = () => {}
}

async function start () {
  try { identity = markRaw(await Identity.connect()) } catch (_) { identity = null }
  if (topbar.value) topbar.value.identity = identity
  if (!identity?.me?.publickey) { status.value = 'noIdentity'; return }
  key.value = await tunnelKey(identity.me.publickey)
  connect()
}

const b64ToStr = (b) => { try { return decodeURIComponent(escape(atob(b))) } catch { return atob(b) } }
const strToB64 = (s) => { try { return btoa(unescape(encodeURIComponent(s))) } catch { return btoa(s) } }

function onReq (m) {
  const bodyStr = m.body ? b64ToStr(m.body) : ''
  requests.value.unshift({ id: m.id, method: m.method, path: m.path, headers: m.headers || {}, body: bodyStr, at: new Date().toLocaleTimeString(lang.value), open: false })
  if (requests.value.length > 100) requests.value.pop()
  // CORS preflight: responde 204 con las cabeceras y no toca la respuesta configurada.
  if (m.method === 'OPTIONS' && cors.value.trim()) {
    send({ type: 'res', id: m.id, status: 204, headers: corsHeaders(), body: null })
    return
  }
  // responder
  let status_ = resStatus.value, headers = { ...corsHeaders() }, outBody
  if (resMode.value === 'echo') {
    headers['content-type'] = 'application/json'
    outBody = JSON.stringify({ method: m.method, path: m.path, headers: m.headers, body: bodyStr || null }, null, 2)
    status_ = 200
  } else {
    headers['content-type'] = resType.value || 'text/plain'
    outBody = resBody.value
  }
  send({ type: 'res', id: m.id, status: Number(status_) || 200, headers, body: outBody ? strToB64(outBody) : null })
}
function send (obj) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj)) }

/* ---------------- copiar ---------------- */
const copiedFlag = ref(false)
function copyUrl () { navigator.clipboard?.writeText(publicUrl.value).then(() => { copiedFlag.value = true; setTimeout(() => (copiedFlag.value = false), 1400) }) }

const curlExample = computed(() => `curl ${publicUrl.value}/hola`)
const curlCopied = ref(false)
function copyCurl () { navigator.clipboard?.writeText(curlExample.value).then(() => { curlCopied.value = true; setTimeout(() => (curlCopied.value = false), 1400) }) }

onMounted(() => { start() })
onUnmounted(() => { closed = true; try { ws?.close() } catch {} })
</script>

<template>
  <div class="app">
    <dotrino-topbar
      ref="topbar"
      profile theme
      brand="Dotrino Tunnel"
      icon="/icon.svg"
      :lang="lang"
      support-repo="imdotrino/dotrino-tunnel"
      support-discord="https://discord.gg/D648uq7cth"
      @dotrino-lang="onLang">
      <dotrino-install :lang="lang"></dotrino-install>
    </dotrino-topbar>

    <main class="wrap">
      <h1 class="tagline">{{ t.tagline }}</h1>

      <div class="grid">
        <!-- izquierda: túnel + respuesta -->
        <div class="col">
          <div class="card">
            <div class="rowhead">
              <h2>{{ t.yourUrl }}</h2>
              <span class="dot" :class="status">{{ status === 'connected' ? t.connected : status === 'connecting' ? t.connecting : (status === 'rejected' || status === 'noIdentity') ? t.rejected : t.disconnected }}</span>
            </div>
            <p v-if="status === 'noIdentity'" class="warn" data-testid="no-identity">{{ t.noIdentity }}</p>
            <p v-else-if="status === 'rejected'" class="warn" data-testid="rejected">{{ t.rejectedWhy }} <code class="inline">{{ rejectReason }}</code></p>
            <p v-else-if="status === 'replaced'" class="warn" data-testid="replaced">{{ t.replaced }}</p>
            <div v-if="publicUrl" class="urlbox">
              <code data-testid="public-url">{{ publicUrl }}</code>
              <button class="btn btn-primary" data-testid="copy-url" @click="copyUrl">{{ copiedFlag ? t.copied : t.copy }}</button>
            </div>
            <p v-if="publicUrl" class="hint">{{ t.hintCurl }} <code class="inline">{{ curlExample }}</code> <button class="copycurl" @click="copyCurl">{{ curlCopied ? '✓ ' + t.copied : t.copy }}</button></p>
          </div>

          <div class="card">
            <h2>{{ t.response }}</h2>
            <div class="seg">
              <button :class="{ on: resMode === 'fixed' }" @click="resMode = 'fixed'">{{ t.fixed }}</button>
              <button :class="{ on: resMode === 'echo' }" @click="resMode = 'echo'">{{ t.echo }}</button>
            </div>
            <template v-if="resMode === 'fixed'">
              <div class="row2">
                <label class="field"><span>{{ t.code }}</span><input type="number" v-model="resStatus" min="100" max="599" /></label>
                <label class="field"><span>{{ t.ctype }}</span><input v-model="resType" /></label>
              </div>
              <label class="field"><span>{{ t.body }}</span><textarea v-model="resBody" rows="6" spellcheck="false"></textarea></label>
            </template>
            <p v-else class="hint">{{ t.echo }}: 200 · application/json con el método, ruta, cabeceras y cuerpo de cada request.</p>
            <label class="field cors-field"><span>{{ t.cors }}</span><input v-model="cors" :placeholder="t.corsPh" spellcheck="false" /></label>
          </div>
        </div>

        <!-- derecha: inspector -->
        <div class="col">
          <div class="card insp">
            <div class="rowhead">
              <h2>{{ t.inspector }} <span v-if="requests.length" class="count">{{ requests.length }}</span></h2>
              <button v-if="requests.length" class="btn btn-link" @click="requests = []">{{ t.clear }}</button>
            </div>
            <p v-if="!requests.length" class="empty">{{ t.none }}</p>
            <ul v-else class="reqs">
              <li v-for="r in requests" :key="r.id" :class="{ open: r.open }">
                <button class="reqline" @click="r.open = !r.open">
                  <span class="method" :class="r.method.toLowerCase()">{{ r.method }}</span>
                  <span class="path">{{ r.path }}</span>
                  <span class="time">{{ r.at }}</span>
                </button>
                <div v-if="r.open" class="reqdetail">
                  <h4>{{ t.headers }}</h4>
                  <pre>{{ Object.entries(r.headers).map(([k, v]) => k + ': ' + v).join('\n') }}</pre>
                  <h4>{{ t.reqbody }}</h4>
                  <pre>{{ r.body || t.empty }}</pre>
                </div>
              </li>
            </ul>
          </div>
        </div>
      </div>

      <p class="cli">{{ t.cli }} <code class="inline">npx @dotrino/tunnel 3000</code></p>
      <p class="cli">{{ t.cliNoNode }}
        <code class="inline">curl -fsSL https://install.dotrino.com/install.sh | sh -s -- @dotrino/tunnel 3000</code></p>
      <p class="privacy">{{ t.privacy }}</p>
    </main>
  </div>
</template>

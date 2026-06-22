<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'

/* ---------------- i18n ---------------- */
const I18N = {
  es: {
    tagline: 'Expón este navegador en una URL pública e inspecciona lo que llega. Cada request que entre a tu URL aparece abajo, y tú decides qué responder.',
    yourUrl: 'Tu URL pública', copy: 'Copiar', copied: 'Copiado', regen: 'Nueva llave',
    status: 'Estado', connected: 'Conectado', connecting: 'Conectando…', disconnected: 'Desconectado',
    response: 'Respuesta automática', mode: 'Modo', fixed: 'Fija', echo: 'Eco (devuelve la request)',
    code: 'Código', ctype: 'Content-Type', body: 'Cuerpo',
    inspector: 'Requests entrantes', none: 'Aún no llega ninguna request. Abre tu URL pública o mándale un webhook.',
    clear: 'Limpiar', headers: 'Cabeceras', reqbody: 'Cuerpo', empty: '(vacío)',
    hintCurl: 'Pruébalo:', privacy: 'Todo ocurre en tu navegador. La llave va en la URL e identifica tu túnel; quien tenga la URL puede usarlo.',
    cli: 'Para exponer un puerto local de verdad, usa la CLI:',
  },
  en: {
    tagline: 'Expose this browser at a public URL and inspect what arrives. Every request to your URL shows up below, and you decide what to answer.',
    yourUrl: 'Your public URL', copy: 'Copy', copied: 'Copied', regen: 'New key',
    status: 'Status', connected: 'Connected', connecting: 'Connecting…', disconnected: 'Disconnected',
    response: 'Automatic response', mode: 'Mode', fixed: 'Fixed', echo: 'Echo (returns the request)',
    code: 'Code', ctype: 'Content-Type', body: 'Body',
    inspector: 'Incoming requests', none: 'No requests yet. Open your public URL or send it a webhook.',
    clear: 'Clear', headers: 'Headers', reqbody: 'Body', empty: '(empty)',
    hintCurl: 'Try it:', privacy: 'Everything happens in your browser. The key goes in the URL and identifies your tunnel; whoever has the URL can use it.',
    cli: 'To expose a real local port, use the CLI:',
  },
}
const LANG_KEY = 'tunnel.lang'
const lang = ref((localStorage.getItem(LANG_KEY) || (navigator.language || 'es').slice(0, 2)) === 'en' ? 'en' : 'es')
const t = computed(() => I18N[lang.value])
const setLang = (l) => { lang.value = l; localStorage.setItem(LANG_KEY, l); document.documentElement.lang = l }

/* ---------------- llave + relay ---------------- */
const RELAY = import.meta.env.VITE_RELAY || location.origin
const B62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
function genKey (n = 32) {
  const a = new Uint8Array(n); crypto.getRandomValues(a)
  let s = ''; for (let i = 0; i < n; i++) s += B62[a[i] % 62]; return s
}
const KEY_STORE = 'tunnel.key'
const key = ref(localStorage.getItem(KEY_STORE) || genKey())
localStorage.setItem(KEY_STORE, key.value)
const publicUrl = computed(() => `${RELAY.replace(/\/$/, '')}/${key.value}`)
function regen () { key.value = genKey(); localStorage.setItem(KEY_STORE, key.value); reconnect() }

/* ---------------- respuesta configurable ---------------- */
const resMode = ref('fixed')         // fixed | echo
const resStatus = ref(200)
const resType = ref('application/json')
const resBody = ref('{\n  "ok": true,\n  "from": "dotrino-tunnel"\n}')

/* ---------------- estado WS ---------------- */
const status = ref('connecting')     // connecting | connected | disconnected
const requests = ref([])
let ws = null, closed = false, backoff = 500

function wsUrl () {
  const u = new URL(RELAY)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  u.pathname = '/_agent'; u.search = '?key=' + key.value
  return u.toString()
}
function connect () {
  if (closed) return
  status.value = 'connecting'
  ws = new WebSocket(wsUrl())
  ws.onopen = () => { backoff = 500 }
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data) } catch { return }
    if (m.type === 'ready') status.value = 'connected'
    else if (m.type === 'req') onReq(m)
  }
  ws.onclose = () => { status.value = 'disconnected'; if (!closed) { setTimeout(connect, backoff); backoff = Math.min(backoff * 2, 15000) } }
  ws.onerror = () => {}
}
function reconnect () { try { ws?.close() } catch {} ; status.value = 'connecting' }

const b64ToStr = (b) => { try { return decodeURIComponent(escape(atob(b))) } catch { return atob(b) } }
const strToB64 = (s) => { try { return btoa(unescape(encodeURIComponent(s))) } catch { return btoa(s) } }

function onReq (m) {
  const bodyStr = m.body ? b64ToStr(m.body) : ''
  requests.value.unshift({ id: m.id, method: m.method, path: m.path, headers: m.headers || {}, body: bodyStr, at: new Date().toLocaleTimeString(lang.value), open: false })
  if (requests.value.length > 100) requests.value.pop()
  // responder
  let status_ = resStatus.value, headers = {}, outBody
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

onMounted(() => { document.documentElement.lang = lang.value; connect() })
onUnmounted(() => { closed = true; try { ws?.close() } catch {} })
</script>

<template>
  <div class="app">
    <header class="topbar">
      <div class="brand"><img src="/icon.svg" alt="" width="30" height="30" /><span>Dotrino Tunnel</span></div>
      <div class="actions">
        <div class="lang" role="group" aria-label="es / en">
          <button :class="{ on: lang === 'es' }" @click="setLang('es')">ES</button>
          <button :class="{ on: lang === 'en' }" @click="setLang('en')">EN</button>
        </div>
        <dotrino-install :lang="lang"></dotrino-install>
        <dotrino-support href="https://ko-fi.com/dotrino" repo="imdotrino/dotrino-tunnel" discord="https://discord.gg/D648uq7cth" :lang="lang"></dotrino-support>
      </div>
    </header>

    <main class="wrap">
      <h1 class="tagline">{{ t.tagline }}</h1>

      <div class="grid">
        <!-- izquierda: túnel + respuesta -->
        <div class="col">
          <div class="card">
            <div class="rowhead">
              <h2>{{ t.yourUrl }}</h2>
              <span class="dot" :class="status">{{ status === 'connected' ? t.connected : status === 'connecting' ? t.connecting : t.disconnected }}</span>
            </div>
            <div class="urlbox">
              <code>{{ publicUrl }}</code>
              <button class="btn btn-primary" @click="copyUrl">{{ copiedFlag ? t.copied : t.copy }}</button>
            </div>
            <button class="btn btn-link" @click="regen">↻ {{ t.regen }}</button>
            <p class="hint">{{ t.hintCurl }} <code class="inline">{{ curlExample }}</code></p>
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
      <p class="privacy">{{ t.privacy }}</p>
    </main>
  </div>
</template>

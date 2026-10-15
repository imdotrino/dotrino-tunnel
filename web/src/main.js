import { createApp } from 'vue'
import { registerSW } from 'virtual:pwa-register'
import '@dotrino/topbar'   // trae marca + volver + idioma + support (CONVENCIONES §5)
import '@dotrino/install'
import App from './App.vue'
import '@dotrino/theme/theme.css'
import './style.css'

const updateSW = registerSW({ immediate: true })
setInterval(() => updateSW(), 30 * 60 * 1000)

createApp(App).mount('#app')

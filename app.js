/* app.js — Notebook Offline (PWA)
   Akış: PDF yükle → sayfa metnini çıkar → parçala → BM25 indeksle
         → soru → en ilgili parçalar → cihazdaki model → kaynak atıflı cevap
   Tüm işlem cihazda. Sunucu, hesap, API anahtarı yok. */

import * as pdfjsLib from './vendor/pdf.min.mjs'
import * as webllm from './vendor/web-llm.js'
import { chunkPageText, buildIndex, search, buildPrompt, fmtBytes } from './core.js'

pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs'

/* ---------------- yardımcılar ---------------- */

const $ = (s) => document.querySelector(s)
const el = (t, cls, txt) => {
  const n = document.createElement(t)
  if (cls) n.className = cls
  if (txt != null) n.textContent = txt
  return n
}
const enc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const tick = () => new Promise((r) => setTimeout(r, 0))

let toastTimer
function toast(msg, ms = 3200) {
  document.querySelectorAll('.toast').forEach((n) => n.remove())
  const t = el('div', 'toast', msg)
  document.body.appendChild(t)
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.remove(), ms)
}

/* ---------------- durum ---------------- */

const state = {
  chunks: [], // {docId, n (dosya adı), p (sayfa), t (metin)}
  index: null,
  docs: [], // {id, name, pages, chunkCount, bytes}
  engine: null,
  modelId: null,
  busy: false,
  generating: false,
}

/* ---------------- Depolama ----------------
   Normalde IndexedDB (kalıcı). Kısıtlı ortamlarda (sandbox'lı iframe gibi)
   IndexedDB açılamazsa otomatik olarak "bellek modu"na düşer: uygulama yine
   çalışır, sadece sekme kapanınca kaynaklar silinir. */

const DB_NAME = 'notebook-offline'
let dbp = null
let memMode = false
const mem = { docs: [], chunks: [], chats: [], seq: 1 }

function openDB() {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    let req
    try {
      req = indexedDB.open(DB_NAME, 2)
    } catch (e) {
      reject(e)
      return
    }
    req.onupgradeneeded = () => {
      const d = req.result
      if (!d.objectStoreNames.contains('chunks')) {
        const st = d.createObjectStore('chunks', { keyPath: 'id', autoIncrement: true })
        st.createIndex('docId', 'docId')
      }
      if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' })
      if (!d.objectStoreNames.contains('chats')) {
        const cs = d.createObjectStore('chats', { keyPath: 'id' })
        cs.createIndex('updatedAt', 'updatedAt')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error || new Error('indexedDB error'))
    req.onblocked = () => reject(new Error('indexedDB blocked'))
  })
  return dbp
}

async function storageInit() {
  try {
    await openDB()
    memMode = false
  } catch (e) {
    console.warn('IndexedDB yok, bellek modu:', e && e.message)
    memMode = true
  }
  return !memMode
}

const store = {
  get memMode() {
    return memMode
  },

  async allDocs() {
    if (memMode) return mem.docs.slice()
    const d = await openDB()
    return new Promise((res, rej) => {
      const r = d.transaction('docs').objectStore('docs').getAll()
      r.onsuccess = () => res(r.result || [])
      r.onerror = () => rej(r.error)
    })
  },

  async allChunks() {
    if (memMode) return mem.chunks.slice()
    const d = await openDB()
    return new Promise((res, rej) => {
      const r = d.transaction('chunks').objectStore('chunks').getAll()
      r.onsuccess = () => res(r.result || [])
      r.onerror = () => rej(r.error)
    })
  },

  async putDoc(doc) {
    if (memMode) {
      mem.docs.push(doc)
      return
    }
    const d = await openDB()
    return new Promise((res, rej) => {
      const t = d.transaction('docs', 'readwrite')
      t.objectStore('docs').put(doc)
      t.oncomplete = () => res()
      t.onerror = () => rej(t.error)
    })
  },

  async addChunks(rows) {
    if (memMode) {
      for (const r of rows) mem.chunks.push({ ...r, id: mem.seq++ })
      return rows.length
    }
    const d = await openDB()
    return new Promise((res, rej) => {
      const t = d.transaction('chunks', 'readwrite')
      const st = t.objectStore('chunks')
      for (const r of rows) st.add(r)
      t.oncomplete = () => res(rows.length)
      t.onerror = () => rej(t.error)
    })
  },

  async deleteDoc(docId) {
    if (memMode) {
      mem.docs = mem.docs.filter((x) => x.id !== docId)
      mem.chunks = mem.chunks.filter((x) => x.docId !== docId)
      return
    }
    const d = await openDB()
    await new Promise((res, rej) => {
      const t = d.transaction(['chunks', 'docs'], 'readwrite')
      const idx = t.objectStore('chunks').index('docId')
      const req = idx.openKeyCursor(IDBKeyRange.only(docId))
      req.onsuccess = () => {
        const cur = req.result
        if (cur) {
          t.objectStore('chunks').delete(cur.primaryKey)
          cur.continue()
        }
      }
      t.objectStore('docs').delete(docId)
      t.oncomplete = res
      t.onerror = () => rej(t.error)
    })
  },

  /* ---- sohbetler ---- */
  async listChats() {
    if (memMode) return mem.chats.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    const d = await openDB()
    return new Promise((res, rej) => {
      const r = d.transaction('chats').objectStore('chats').getAll()
      r.onsuccess = () => res((r.result || []).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)))
      r.onerror = () => rej(r.error)
    })
  },

  async putChat(chat) {
    if (memMode) {
      const i = mem.chats.findIndex((c) => c.id === chat.id)
      if (i >= 0) mem.chats[i] = chat
      else mem.chats.push(chat)
      return
    }
    const d = await openDB()
    return new Promise((res, rej) => {
      const t = d.transaction('chats', 'readwrite')
      t.objectStore('chats').put(chat)
      t.oncomplete = () => res()
      t.onerror = () => rej(t.error)
    })
  },

  async deleteChat(id) {
    if (memMode) {
      mem.chats = mem.chats.filter((c) => c.id !== id)
      return
    }
    const d = await openDB()
    return new Promise((res, rej) => {
      const t = d.transaction('chats', 'readwrite')
      t.objectStore('chats').delete(id)
      t.oncomplete = () => res()
      t.onerror = () => rej(t.error)
    })
  },

  async clearChats() {
    if (memMode) {
      mem.chats = []
      return
    }
    const d = await openDB()
    await new Promise((res, rej) => {
      const t = d.transaction('chats', 'readwrite')
      t.objectStore('chats').clear()
      t.oncomplete = res
      t.onerror = () => rej(t.error)
    })
  },

  async clearAll() {
    if (memMode) {
      mem.docs = []
      mem.chunks = []
      return
    }
    const d = await openDB()
    await Promise.all(
      ['chunks', 'docs'].map(
        (name) =>
          new Promise((res, rej) => {
            const t = d.transaction(name, 'readwrite')
            t.objectStore(name).clear()
            t.oncomplete = res
            t.onerror = () => rej(t.error)
          })
      )
    )
  },
}

/* ---------------- UI: sekmeler ---------------- */

function showTab(name) {
  document.querySelectorAll('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name))
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name))
  $('#composer').classList.toggle('hide', name !== 'chat')
  document.body.classList.toggle('chat-open', name === 'chat')
  if (name === 'chat') setTimeout(() => $('#q').focus(), 60)
  window.scrollTo(0, 0)
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)))

/* ---------------- WebGPU kontrol ---------------- */

async function checkGPU() {
  const dot = $('#gpuDot')
  const txt = $('#gpuTxt')
  if (!('gpu' in navigator)) {
    dot.classList.add('err')
    txt.textContent = 'WebGPU yok'
    showGpuWarn('Bu tarayıcı WebGPU API\'sini sunmuyor. Aynı adresi <b>Safari</b> veya güncel Chrome\'da açman gerekiyor.')
    return false
  }
  try {
    const a = await navigator.gpu.requestAdapter()
    if (!a) throw new Error('adaptör yok')
    dot.classList.add('ok')
    txt.textContent = 'WebGPU hazır'
    return true
  } catch (e) {
    dot.classList.add('warn')
    txt.textContent = 'WebGPU sınırlı'
    const bn = browserName()
    const third = /DuckDuckGo|Opera|Edge|Chrome|Firefox/.test(bn)
    showGpuWarn('WebGPU var ama GPU adaptörü alınamadı (' + (e.message || e) + '). ' +
      (third
        ? 'iOS\'ta ' + bn + ' de WebKit kullanır ama WebGPU genelde kapalıdır. Aynı adresi <b>Safari</b>\'de açıp modeli orada yükle; sonra ' + bn + '\'e dönmek istersen yedeği indir/yükle.'
        : 'Model yüklemeyi yine de deneyebilirsin.'))
    return false
  }
}

function showGpuWarn(html) {
  const box = $('#gpuWarn')
  if (!box) return
  $('#gpuWarnTxt').innerHTML = html
  box.style.display = 'block'
}

/* ---------------- tarayıcı tanılama ---------------- */

function browserName() {
  const ua = navigator.userAgent
  if (/DuckDuckGo/i.test(ua)) return 'DuckDuckGo Browser'
  if (/OPiOS|OPR|Opera/i.test(ua)) return 'Opera'
  if (/EdgiOS|Edg\//i.test(ua)) return 'Edge'
  if (/CriOS|Chrome/i.test(ua)) return 'Chrome'
  if (/FxiOS|Firefox/i.test(ua)) return 'Firefox'
  if (/Safari/i.test(ua)) return 'Safari'
  return 'bilinmiyor'
}

function iosVersion() {
  const m = navigator.userAgent.match(/OS (\d+)[._](\d+)/)
  return m ? `iOS ${m[1]}.${m[2]}` : '—'
}

async function renderDiag() {
  const box = $('#diagBox')
  if (!box) return
  const lines = []
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true

  let gpu = 'API yok'
  try {
    if ('gpu' in navigator) {
      const a = await navigator.gpu.requestAdapter()
      if (!a) gpu = 'adaptör alınamadı'
      else {
        const inf = a.info || {}
        gpu = 'hazır' + (inf.vendor ? ` (${inf.vendor}${inf.architecture ? '/' + inf.architecture : ''})` : '')
      }
    }
  } catch (e) {
    gpu = 'hata: ' + (e.message || e)
  }

  let persist = '?'
  let usage = '?'
  try {
    persist = (await navigator.storage.persisted()) ? 'kalıcı ✓' : 'geçici (silinebilir)'
    const est = await navigator.storage.estimate()
    usage = `${fmtBytes(est.usage)} / ${fmtBytes(est.quota)}`
  } catch (e) {}

  let sw = 'yok'
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration()
      sw = reg && reg.active ? 'aktif ✓' : 'kayıtlı değil'
    }
  } catch (e) {}

  lines.push(`tarayıcı      : ${browserName()}`)
  lines.push(`sürüm         : ${iosVersion()} · ${standalone ? 'ana ekran uygulaması' : 'tarayıcı sekmesi'}`)
  lines.push(`WebGPU        : ${gpu}`)
  lines.push(`depolama      : ${persist} · ${usage}`)
  lines.push(`service worker: ${sw}`)
  lines.push(`kitaplık      : ${state.docs.length} kaynak · ${state.chunks.length} parça`)
  lines.push(`model         : ${state.modelId || 'yüklü değil'}`)
  box.textContent = lines.join('\n')
  return lines.join('\n')
}

/* ---------------- PDF → parçalar ---------------- */

async function ingestFiles(files) {
  const pdfs = Array.from(files).filter((f) => /pdf$/i.test(f.name) || f.type === 'application/pdf')
  if (!pdfs.length) return toast('PDF seçilmedi')
  if (state.busy) return toast('Zaten bir işlem sürüyor')

  state.busy = true
  $('#ingBarWrap').classList.remove('hide')
  const bar = $('#ingBar')
  const txt = $('#ingTxt')

  try {
    for (let fi = 0; fi < pdfs.length; fi++) {
      const f = pdfs[fi]
      const base = fi / pdfs.length
      bar.style.width = (base * 100).toFixed(1) + '%'
      txt.textContent = `${fi + 1}/${pdfs.length} · ${f.name} açılıyor…`
      await tick()

      let pdf
      try {
        const buf = await f.arrayBuffer()
        pdf = await pdfjsLib.getDocument({
          data: new Uint8Array(buf),
          isEvalSupported: false,
          standardFontDataUrl: './vendor/standard_fonts/',
        }).promise
      } catch (e) {
        console.warn(e)
        toast(`Açılamadı: ${f.name}`)
        continue
      }

      const docId = (crypto.randomUUID && crypto.randomUUID()) || 'd' + Date.now() + Math.random()
      const rows = []
      const total = pdf.numPages

      for (let p = 1; p <= total; p++) {
        let pageText = ''
        try {
          const page = await pdf.getPage(p)
          const tc = await page.getTextContent()
          pageText = tc.items
            .map((it) => (it.str || '') + (it.hasEOL ? '\n' : ' '))
            .join('')
          page.cleanup()
        } catch (e) {
          /* bozuk sayfa → atla */
        }
        for (const c of chunkPageText(pageText)) rows.push({ docId, n: f.name, p, t: c })

        if (p % 4 === 0 || p === total) {
          const frac = (fi + p / total) / pdfs.length
          bar.style.width = (frac * 100).toFixed(1) + '%'
          txt.textContent = `${fi + 1}/${pdfs.length} · ${f.name} · sayfa ${p}/${total} · ${rows.length} parça`
          await tick()
        }
      }

      if (rows.length) {
        await store.addChunks(rows)
        const doc = { id: docId, name: f.name, pages: total, chunkCount: rows.length, bytes: f.size }
        await store.putDoc(doc)
        state.docs.push(doc)
        for (const r of rows) state.chunks.push({ docId: r.docId, n: r.n, p: r.p, t: r.t })
      } else {
        toast(`Metin çıkmadı (taranmış olabilir): ${f.name}`, 4500)
      }
      try {
        pdf.destroy()
      } catch (e) {}
    }

    bar.style.width = '100%'
    txt.textContent = 'indeks kuruluyor…'
    await rebuildIndex()
    txt.textContent = `bitti · ${state.chunks.length} parça · ${state.docs.length} kaynak`
  } catch (e) {
    console.error(e)
    toast('Hata: ' + (e.message || e))
  } finally {
    state.busy = false
    renderDocs()
    updateBackupInfo()
    setTimeout(() => $('#ingBarWrap').classList.add('hide'), 4000)
  }
}

async function rebuildIndex() {
  const t0 = performance.now()
  state.index = buildIndex(state.chunks)
  window.__nbChunks = state.chunks // test/teşhis kancası
  const ms = Math.round(performance.now() - t0)
  $('#statLine').innerHTML =
    `${state.docs.length} kaynak · ${state.chunks.length} parça · ` +
    `indeks ${ms} ms'de kuruldu · ${state.index.keys.length.toLocaleString('tr-TR')} ayrı kelime`
  $('#hdrSub').textContent = state.chunks.length
    ? `${state.docs.length} kaynak · ${state.chunks.length} parça`
    : 'kitaplık boş'
}

function renderDocs() {
  const ul = $('#docList')
  ul.innerHTML = ''
  if (!state.docs.length) {
    ul.appendChild(el('li', 'muted', 'Henüz kaynak yok.'))
  } else {
    for (const d of state.docs) {
      const li = el('li')
      const wrap = el('div', 'name')
      wrap.appendChild(el('div', null, d.name))
      wrap.appendChild(el('div', 'meta', `${d.pages} sayfa · ${d.chunkCount} parça · ${fmtBytes(d.bytes)}`))
      li.appendChild(wrap)
      const x = el('button', 'x', '×')
      x.title = 'Sil'
      x.addEventListener('click', async () => {
        await store.deleteDoc(d.id)
        state.docs = state.docs.filter((z) => z.id !== d.id)
        state.chunks = state.chunks.filter((c) => c.docId !== d.id)
        renderDocs()
        await rebuildIndex()
        toast('Kaynak silindi')
      })
      li.appendChild(x)
      ul.appendChild(li)
    }
  }
  $('#libCount').textContent = state.docs.length ? `(${state.docs.length})` : ''
}

/* ---------------- model ---------------- */

async function loadModel() {
  if (state.engine) return toast('Model zaten yüklü')
  const modelId = $('#modelSel').value
  $('#btnLoad').disabled = true
  $('#mdlBarWrap').classList.remove('hide')
  const bar = $('#mdlBar')
  const txt = $('#mdlTxt')
  txt.textContent = 'model hazırlanıyor…'

  try {
    state.engine = await webllm.CreateMLCEngine(modelId, {
      initProgressCallback: (r) => {
        const p = Math.max(0, Math.min(1, r.progress || 0))
        bar.style.width = (p * 100).toFixed(1) + '%'
        txt.textContent = (r.text || '').slice(0, 160)
      },
    })
    state.modelId = modelId
    toast('Model yüklü — artık offline çalışabilirsin')
    txt.textContent = 'hazır · ' + modelId
    bar.style.width = '100%'
  } catch (e) {
    console.error(e)
    txt.textContent = 'yüklenemedi: ' + (e.message || e)
    toast('Model yüklenemedi. WebGPU destekli bir tarayıcı gerekiyor.', 5000)
    $('#mdlBarWrap').classList.remove('hide')
  } finally {
    $('#btnLoad').disabled = false
  }
}

async function unloadModel() {
  if (!state.engine) return
  try {
    await state.engine.unload()
  } catch (e) {}
  state.engine = null
  state.modelId = null
  $('#mdlBarWrap').classList.add('hide')
  toast('Model bellekten kaldırıldı')
}

/* ---------------- sohbet ---------------- */

function stripThink(s) {
  // Qwen vb. "düşünme" bloklarını göster(me)
  return s.replace(/<think[^>]*>[\s\S]*?<\/think>/gi, '').replace(/^\s*<think[\s\S]*/i, '')
}

function renderAnswer(html) {
  let h = enc(html)
  h = h.replace(/^###?\s*(.+)$/gm, '<b>$1</b>')
  h = h.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
  h = h.replace(/(^|\n)\s*[-*•]\s+/g, '$1• ')
  h = h.replace(/\[(\d{1,2})\]/g, '<span class="sup">[$1]</span>')
  h = h.replace(/\n{3,}/g, '\n\n')
  return h
}

/* --- oturum (sohbet kalıcılığı) --- */
let session = null

function newSession() {
  return {
    id: (crypto.randomUUID && crypto.randomUUID()) || 'c' + Date.now() + Math.random(),
    title: '',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
  }
}

function ensureSession() {
  if (!session) session = newSession()
  return session
}

async function saveSession() {
  if (!session) return
  session.updatedAt = Date.now()
  if (!session.title) {
    const first = session.messages.find((m) => m.role === 'user')
    if (first) session.title = first.text.slice(0, 48)
  }
  try {
    await store.putChat(JSON.parse(JSON.stringify(session)))
  } catch (e) {
    console.warn('sohbet kaydedilemedi', e)
  }
}

function paintSources(box, sources) {
  box.innerHTML = ''
  if (!sources || !sources.length) {
    box.classList.add('hide')
    return
  }
  box.classList.remove('hide')
  const det = el('details')
  det.appendChild(el('summary', null, `kaynaklar (${sources.length}) — görmek için dokun`))
  sources.forEach((src, i) => {
    const p = el('p')
    const txt = src.t || ''
    p.innerHTML =
      `<b style="color:#cfe1f5">[${i + 1}] ${enc(src.n)} · sayfa ${src.p}</b>\n` +
      enc(txt.slice(0, 700)) +
      (txt.length > 700 ? '…' : '')
    det.appendChild(p)
  })
  box.appendChild(det)
}

function paintBot(ui, text, sources) {
  ui.body.innerHTML = text ? renderAnswer(text) : '<b>Kaynaklarda bu bilgi yok.</b>'
  paintSources(ui.src, sources)
}

function addUserMsg(text, persist = true) {
  $('#chatEmpty')?.classList.add('hide')
  const m = el('div', 'msg user')
  m.textContent = text
  $('#chat').appendChild(m)
  scrollChat()
  if (persist) {
    ensureSession().messages.push({ role: 'user', text, ts: Date.now() })
    saveSession()
  }
}

function addBotMsg() {
  const m = el('div', 'msg bot')
  const head = el('h3', null, 'cevap')
  const body = el('div')
  body.innerHTML = '<span class="muted">aranıyor…</span>'
  m.appendChild(head)
  m.appendChild(body)
  const src = el('div', 'src hide')
  m.appendChild(src)
  $('#chat').appendChild(m)
  scrollChat()
  return { body, src, head }
}

function renderSession() {
  const box = $('#chat')
  box.innerHTML = ''
  const msgs = session ? session.messages : []
  if (!msgs.length) {
    $('#chatEmpty')?.classList.remove('hide')
    return
  }
  $('#chatEmpty')?.classList.add('hide')
  for (const msg of msgs) {
    if (msg.role === 'user') {
      const m = el('div', 'msg user')
      m.textContent = msg.text
      box.appendChild(m)
    } else {
      const m = el('div', 'msg bot')
      m.appendChild(el('h3', null, 'cevap'))
      const body = el('div')
      body.innerHTML = renderAnswer(msg.text || '')
      m.appendChild(body)
      const src = el('div', 'src hide')
      m.appendChild(src)
      paintSources(src, msg.sources)
      box.appendChild(m)
    }
  }
  scrollChat()
}

async function startNewChat() {
  await saveSession()
  session = newSession()
  renderSession()
  toast('Yeni sohbet')
  $('#q').focus()
}

async function deleteCurrentChat() {
  if (!session || !session.messages.length) {
    session = newSession()
    renderSession()
    return toast('Sohbet temizlendi')
  }
  if (!confirm('Bu sohbet geçmişi silinsin mi?')) return
  await store.deleteChat(session.id)
  session = newSession()
  renderSession()
  toast('Sohbet silindi')
}

function scrollChat() {
  const main = document.querySelector('main')
  requestAnimationFrame(() => (main.scrollTop = main.scrollHeight))
}

async function ask(question) {
  if (!question.trim()) return
  if (state.generating) return toast('Cevap hâlâ yazılıyor…')
  if (!state.chunks.length) return toast('Önce PDF ekle')
  if (!state.index) await rebuildIndex()
  if (!state.engine) {
    showTab('model')
    return toast('Önce modeli yükle (Model sekmesi)')
  }

  state.generating = true
  $('#btnSend').disabled = true
  addUserMsg(question)

  const ui = addBotMsg()
  try {
    ui.body.innerHTML = '<span class="muted">kaynaklar aranıyor…</span>'
    await tick()

    const hits = search(state.index, question, 6).map((h) => ({ ...h, chunk: state.chunks[h.i] }))
    if (!hits.length) {
      const msg =
        'Kaynaklarda bu bilgi yok.\n\n(Verilen kelimelerle eşleşen parça bulunamadı. Farklı kelimelerle dene veya kitaplığa ilgili PDF ekle.)'
      paintBot(ui, msg, [])
      ensureSession().messages.push({ role: 'bot', text: msg, sources: [], ts: Date.now() })
      await saveSession()
      return
    }

    const messages = buildPrompt(question, hits, { maxChars: 6000 })
    ui.body.innerHTML = '<span class="muted">yazıyor…</span>'

    let acc = ''
    const stream = await state.engine.chat.completions.create({
      messages,
      stream: true,
      temperature: 0.2,
      max_tokens: 640,
      extra_body: { enable_thinking: false },
    })
    for await (const part of stream) {
      const d = part?.choices?.[0]?.delta?.content || ''
      if (!d) continue
      acc += d
      ui.body.innerHTML = renderAnswer(stripThink(acc)) || '<span class="muted">yazıyor…</span>'
      scrollChat()
    }
    const clean = stripThink(acc).trim()
    const sources = hits.map((h) => ({ n: h.chunk.n, p: h.chunk.p, t: h.chunk.t }))
    paintBot(ui, clean, sources)
    scrollChat()
    ensureSession().messages.push({
      role: 'bot',
      text: clean || 'Kaynaklarda bu bilgi yok.',
      sources,
      ts: Date.now(),
    })
    await saveSession()
  } catch (e) {
    console.error(e)
    const t = 'Hata: ' + (e.message || String(e))
    ui.body.innerHTML = `<b style="color:#ff8a8a">${enc(t)}</b>`
    ensureSession().messages.push({ role: 'bot', text: t, sources: [], ts: Date.now() })
    await saveSession()
  } finally {
    state.generating = false
    $('#btnSend').disabled = false
  }
}

/* ---------------- depolama ---------------- */

async function updateStorage() {
  try {
    const est = await navigator.storage.estimate()
    $('#storageLine').textContent =
      `kullanılan: ${fmtBytes(est.usage)} / kotanın ${fmtBytes(est.quota)}`
  } catch (e) {
    $('#storageLine').textContent = 'durum okunamadı'
  }
}

/* ---------------- yedekleme (cihazlar arası taşıma) ---------------- */

async function updateBackupInfo() {
  try {
    const chars = state.chunks.reduce((a, c) => a + (c.t ? c.t.length : 0), 0)
    const chats = await store.listChats()
    const raw = chars * 2
    $('#backupInfo').textContent =
      `${state.docs.length} kaynak · ${state.chunks.length} parça · ${chats.length} sohbet · ` +
      `yedek ~${fmtBytes(raw)} (sıkıştırınca genelde 1/3'ü)`
  } catch (e) {}
}

async function exportBackup() {
  try {
    if (!state.chunks.length) return toast('Kitaplık boş — yedeklenecek bir şey yok')
    await saveSession()
    const payload = {
      app: 'notebook-offline',
      version: 1,
      exportedAt: new Date().toISOString(),
      docs: state.docs,
      chunks: state.chunks.map((c) => ({ d: c.docId, n: c.n, p: c.p, t: c.t })),
      chats: await store.listChats(),
    }
    const json = JSON.stringify(payload)
    let blob = new Blob([json], { type: 'application/json' })
    let name = `notebook-yedek-${new Date().toISOString().slice(0, 10)}.json`
    if (typeof CompressionStream !== 'undefined') {
      try {
        blob = await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).blob()
        name += '.gz'
      } catch (e) {
        /* sıkıştırma yoksa düz json */
      }
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 15000)
    toast(`Yedek indirildi: ${name} · ${fmtBytes(blob.size)}`, 6000)
  } catch (e) {
    console.error(e)
    toast('Yedek alınamadı: ' + (e.message || e), 5000)
  }
}

async function importBackup(file) {
  const bar = $('#ingBarWrap'), txt = $('#ingTxt')
  try {
    bar.classList.remove('hide')
    txt.textContent = 'yedek okunuyor…'
    const buf = await file.arrayBuffer()
    const head = new Uint8Array(buf.slice(0, 2))
    let json
    if (head[0] === 0x1f && head[1] === 0x8b) {
      if (typeof DecompressionStream === 'undefined') throw new Error('Bu tarayıcı gzip açamıyor; sıkıştırılmamış yedek dene')
      json = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
    } else {
      json = new TextDecoder().decode(buf)
    }
    const data = JSON.parse(json)
    if (!data || data.app !== 'notebook-offline') throw new Error('Bu dosya bir Notebook Offline yedeği değil')

    if (state.docs.length || state.chunks.length) {
      if (!confirm('Mevcut kitaplık ve sohbetler silinip yedek yüklenecek. Devam?')) {
        bar.classList.add('hide')
        return
      }
    }

    txt.textContent = 'kitaplık yazılıyor…'
    await store.clearAll()
    await store.clearChats()
    state.docs = []
    state.chunks = []

    const docs = data.docs || []
    const chunks = (data.chunks || []).map((c) => ({
      docId: c.d || c.docId,
      n: c.n,
      p: c.p,
      t: c.t,
    }))
    for (let i = 0; i < docs.length; i++) {
      await store.putDoc(docs[i])
      state.docs.push(docs[i])
      if (i % 20 === 0) {
        txt.textContent = `kaynaklar yazılıyor… ${i + 1}/${docs.length}`
        await tick()
      }
    }
    await store.addChunks(chunks)
    state.chunks = chunks
    for (const ch of data.chats || []) await store.putChat(ch)

    txt.textContent = 'indeks kuruluyor…'
    await rebuildIndex()
    renderDocs()
    const chats = await store.listChats()
    session = chats.length ? chats[0] : newSession()
    renderSession()
    await updateBackupInfo()
    showTab('lib')
    toast(`Yedek yüklendi: ${docs.length} kaynak · ${chunks.length} parça`, 6000)
    txt.textContent = 'yedek yüklendi'
  } catch (e) {
    console.error(e)
    toast('Yedek yüklenemedi: ' + (e.message || e), 6000)
    txt.textContent = 'hata: ' + (e.message || e)
  } finally {
    setTimeout(() => bar.classList.add('hide'), 4000)
  }
}

/* ---------------- olaylar ---------------- */

$('#fileInput').addEventListener('change', (e) => {
  ingestFiles(e.target.files)
  e.target.value = ''
})
$('#drop').addEventListener('dragover', (e) => {
  e.preventDefault()
  $('#drop').style.borderColor = '#4da3ff'
})
$('#drop').addEventListener('dragleave', () => ($('#drop').style.borderColor = ''))
$('#drop').addEventListener('drop', (e) => {
  e.preventDefault()
  $('#drop').style.borderColor = ''
  ingestFiles(e.dataTransfer.files)
})

$('#btnClear').addEventListener('click', async () => {
  if (!confirm('Tüm kaynaklar ve indeks silinsin mi? (Modeller kalır)')) return
  await store.clearAll()
  state.docs = []
  state.chunks = []
  state.index = null
  renderDocs()
  await rebuildIndex()
  toast('Kitaplık temizlendi')
})

async function loadDemo() {
  try {
    if (state.docs.some((d) => d.name === 'demo-kaynak.pdf')) return toast('Demo kaynak zaten kitaplıkta')
    showTab('lib')
    const r = await fetch('./demo-kaynak.pdf')
    if (!r.ok) throw new Error('demo dosyası bulunamadı')
    const blob = await r.blob()
    const file = new File([blob], 'demo-kaynak.pdf', { type: 'application/pdf' })
    await ingestFiles([file])
    toast('Demo yüklendi — şimdi Model sekmesinden modeli yükle')
  } catch (e) {
    toast('Demo yüklenemedi: ' + (e.message || e))
  }
}

$('#btnDemo').addEventListener('click', loadDemo)
$('#btnDemo2').addEventListener('click', loadDemo)

$('#btnDiagCopy').addEventListener('click', async () => {
  const t = await renderDiag()
  try {
    await navigator.clipboard.writeText(t)
    toast('Tanılama bilgisi kopyalandı')
  } catch (e) {
    toast('Kopyalanamadı — metni elle seçebilirsin')
  }
})
$('#btnDiagRefresh').addEventListener('click', renderDiag)
$('#btnCopyUrl').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(location.href)
    toast('Adres kopyalandı — Safari\'de aç')
  } catch (e) {
    toast(location.href, 6000)
  }
})

$('#btnExport').addEventListener('click', exportBackup)
$('#btnImport').addEventListener('click', () => $('#importInput').click())
$('#importInput').addEventListener('change', (e) => {
  const f = e.target.files && e.target.files[0]
  if (f) importBackup(f)
  e.target.value = ''
})
$('#btnNewChat').addEventListener('click', startNewChat)
$('#btnDelChat').addEventListener('click', deleteCurrentChat)

$('#btnLoad').addEventListener('click', loadModel)
$('#btnUnload').addEventListener('click', unloadModel)
$('#btnPersist').addEventListener('click', async () => {
  try {
    const ok = await navigator.storage.persist()
    toast(ok ? 'Kalıcı depolama açıldı' : 'Tarayıcı izin vermedi')
  } catch (e) {
    toast('Desteklenmiyor')
  }
})

$('#btnSend').addEventListener('click', () => {
  const q = $('#q')
  const v = q.value.trim()
  q.value = ''
  q.style.height = 'auto'
  ask(v)
})
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    $('#btnSend').click()
  }
})
$('#q').addEventListener('input', (e) => {
  const t = e.target
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, 140) + 'px'
})
document.querySelectorAll('[data-ex]').forEach((b) =>
  b.addEventListener('click', () => {
    $('#q').value = b.dataset.ex
    $('#q').focus()
  })
)

/* ---------------- açılış ---------------- */

;(async function boot() {
  window.__nbBoot = true
  await storageInit()
  if (store.memMode) {
    const s = document.getElementById('modeNote')
    if (s) {
      s.textContent =
        'Bellek modu: bu ortamda kalıcı depo (IndexedDB) kapalı. Uygulama çalışır ama sekmeyi kapatınca kaynaklar silinir. Kalıcı kullanım için GitHub Pages adresini Safari\'de aç.'
      s.classList.remove('hide')
    }
  }
  checkGPU()
  await updateStorage()
  try {
    state.docs = await store.allDocs()
    state.chunks = await store.allChunks()
    renderDocs()
    if (state.chunks.length) {
      await rebuildIndex()
    } else {
      $('#statLine').textContent = 'henüz indeks yok'
    }
    const chats = await store.listChats()
    session = chats.length ? chats[0] : newSession()
    renderSession()
    await updateBackupInfo()
    renderDiag()
  } catch (e) {
    console.error('DB okunamadı', e)
    toast('Yerel depo açılamadı (gizli sekme olabilir)')
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').then(() => renderDiag()).catch(() => {})
  }
})()

/* test/teşhis kancası (uygulama davranışını etkilemez) */
window.__nb = {
  get state() {
    return state
  },
  get session() {
    return session
  },
  store,
}

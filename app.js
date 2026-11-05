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
const mem = { docs: [], chunks: [], seq: 1 }

function openDB() {
  if (dbp) return dbp
  dbp = new Promise((resolve, reject) => {
    let req
    try {
      req = indexedDB.open(DB_NAME, 1)
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
    return false
  }
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

function addUserMsg(text) {
  $('#chatEmpty')?.classList.add('hide')
  const m = el('div', 'msg user')
  m.textContent = text
  $('#chat').appendChild(m)
  scrollChat()
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
      ui.body.innerHTML =
        '<b>Kaynaklarda bu bilgi yok.</b>\n\n(Verilen kelimelerle eşleşen parça bulunamadı. Farklı kelimelerle dene veya kitaplığa ilgili PDF\'i ekle.)'
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
    if (!clean) ui.body.innerHTML = '<b>Kaynaklarda bu bilgi yok.</b>'
    else ui.body.innerHTML = renderAnswer(clean)

    // kaynak listesi
    ui.src.classList.remove('hide')
    const det = el('details')
    const sum = el('summary', null, `kaynaklar (${hits.length}) — görmek için dokun`)
    det.appendChild(sum)
    hits.forEach((h, i) => {
      const p = el('p')
      p.innerHTML =
        `<b style="color:#cfe1f5">[${i + 1}] ${enc(h.chunk.n)} · sayfa ${h.chunk.p}</b>\n` +
        enc(h.chunk.t.slice(0, 700)) +
        (h.chunk.t.length > 700 ? '…' : '')
      det.appendChild(p)
    })
    ui.src.appendChild(det)
    scrollChat()
  } catch (e) {
    console.error(e)
    ui.body.innerHTML = `<b style="color:#ff8a8a">Hata:</b> ${enc(e.message || String(e))}`
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
      $('#chatEmpty')?.classList.remove('hide')
    } else {
      $('#statLine').textContent = 'henüz indeks yok'
    }
  } catch (e) {
    console.error('DB okunamadı', e)
    toast('Yerel depo açılamadı (gizli sekme olabilir)')
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {})
  }
})()

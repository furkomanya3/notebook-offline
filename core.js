/* core.js — Notebook Offline
   Tarayıcıdan bağımsız saf mantık: Türkçe tokenizasyon, parçalama (chunking),
   BM25 arama. Node ile test edilebilir (test/test-core.mjs).
   Lisans: senin. İstediğin gibi değiştir. */

/* ---------------- Türkçe metin işleme ---------------- */

// Türkçe büyük/küçük harf tuzağı: JS'te 'I'.toLowerCase() === 'i' (yanlış, 'ı' olmalı).
export function trLower(s) {
  return s
    .replace(/\u0130/g, 'i') // İ -> i
    .replace(/\u0049/g, '\u0131') // I -> ı
    .toLowerCase();
}

// Aşırı sık geçen, aramada ayırt ediciliği olmayan kelimeler
export const STOPWORDS = new Set(
  ('ve veya ile için gibi bu şu o da de ki mi mu mü bir iki çok daha en her ne ' +
    'olan olarak olduğu olduğunu ise ama fakat ancak hem ya yani göre kadar sonra önce ' +
    'şey şeyi bunun bunu buna şunun onun onu ona neden nasıl hangi kim ' +
    'var yok ise iken üzere ayrıca sadece hepsi bazı tüm bütün')
    .split(/\s+/)
)

export function tokenize(text) {
  if (!text) return []
  const raw = trLower(text).match(/[\p{L}\p{N}]+/gu) || []
  const out = []
  for (const t of raw) {
    if (t.length < 2) continue
    if (STOPWORDS.has(t)) continue
    out.push(t)
  }
  return out
}

/* ---------------- Parçalama (chunking) ----------------
   Her parça tek bir PDF sayfasından gelir; böylece atıf "dosya + sayfa" olarak
   kesin olur. Cümle sonuna denk getirmeye çalışır. */

export function chunkPageText(text, opts = {}) {
  const max = opts.max ?? 900
  const overlap = opts.overlap ?? 150
  const clean = String(text || '')
    .replace(/\s+/g, ' ')
    .replace(/\u00ad/g, '') // yumuşak tire
    .trim()
  if (!clean) return []
  if (clean.length <= max) return [clean]

  const out = []
  let start = 0
  while (start < clean.length) {
    let end = Math.min(start + max, clean.length)
    if (end < clean.length) {
      // son 250 karakter içinde cümle/paragraf sonu ara
      const tail = clean.slice(Math.max(start + max - 250, start), end)
      const m = tail.match(/[.!?…]\s|[.;:]\s|,\s(?!\d)/g)
      if (m && m.length) {
        const lastIdx = tail.lastIndexOf(m[m.length - 1])
        if (lastIdx > 100) end = Math.max(start + max - 250, start) + lastIdx + m[m.length - 1].length
      }
    }
    out.push(clean.slice(start, end).trim())
    if (end >= clean.length) break
    start = Math.max(end - overlap, start + 1)
  }
  return out.filter((s) => s.length > 40)
}

/* ---------------- BM25 arama ----------------
   Türkçe ek alan bir dil olduğu için tam kelime eşleşmesinin yanında
   "önek eşleşmesi" de puanlanır (ör. "mevzuatın" sorgusu "mevzuat" ile eşleşir). */

const K1 = 1.4
const B = 0.72
const PREFIX_MIN = 5 // bu uzunluktan uzun sorgu kelimeleri için önek araması yapılır

export function buildIndex(chunks) {
  const tf = [] // her parça için {token: sayı}
  const df = new Map() // token -> kaç parçada geçiyor
  const lens = new Array(chunks.length)
  let total = 0

  for (let i = 0; i < chunks.length; i++) {
    const toks = tokenize(chunks[i].t)
    const m = new Map()
    for (const tok of toks) m.set(tok, (m.get(tok) || 0) + 1)
    tf.push(m)
    lens[i] = toks.length
    total += toks.length
    for (const tok of m.keys()) df.set(tok, (df.get(tok) || 0) + 1)
  }

  const N = Math.max(chunks.length, 1)
  const avgdl = total / N || 1
  return { tf, df, lens, N, avgdl, keys: Array.from(df.keys()) }
}

function idf(index, term) {
  const d = index.df.get(term) || 0
  return Math.log(1 + (index.N - d + 0.5) / (d + 0.5))
}

/** Sorguya en uygun parçaları döndürür: [{i, score}] */
export function search(index, query, k = 6) {
  const qToks = tokenize(query)
  if (!qToks.length) return []

  // sorgu token -> {terim: ağırlık}
  const expanded = new Map()
  for (const tok of qToks) {
    expanded.set(tok, Math.max(expanded.get(tok) || 0, 1))
    if (tok.length >= PREFIX_MIN) {
      for (const key of index.keys) {
        if (key !== tok && key.startsWith(tok) && expanded.get(key) !== 1) {
          expanded.set(key, Math.max(expanded.get(key) || 0, 0.45))
        }
      }
    }
  }

  const scores = new Float64Array(index.N)
  for (const [term, w] of expanded) {
    if (!index.df.has(term)) continue
    const wIdf = idf(index, term) * w
    for (let i = 0; i < index.N; i++) {
      const f = index.tf[i].get(term)
      if (!f) continue
      const dl = index.lens[i] || 1
      scores[i] += (wIdf * (f * (K1 + 1))) / (f + K1 * (1 - B + (B * dl) / index.avgdl))
    }
  }

  const res = []
  for (let i = 0; i < index.N; i++) if (scores[i] > 0) res.push({ i, score: scores[i] })
  res.sort((a, b) => b.score - a.score)
  return res.slice(0, k)
}

/* ---------------- İstem (prompt) kurucu ---------------- */

export function buildPrompt(question, hits, opts = {}) {
  const maxChars = opts.maxChars ?? 6000
  const parts = []
  let used = 0
  let n = 0
  for (const h of hits) {
    const snippet = h.chunk.t.slice(0, Math.max(300, Math.min(1400, maxChars - used)))
    if (used + snippet.length > maxChars) break
    n++
    parts.push(`[${n}] (${h.chunk.n}, sayfa ${h.chunk.p})\n${snippet}`)
    used += snippet.length
  }

  const sources = parts.join('\n\n') || '(kaynak bulunamadı)'

  const system = `Sen bir belge asistanısın. Yalnızca aşağıdaki KAYNAK parçalarını kullanarak Türkçe cevap ver.

Kurallar:
1) Sadece kaynaklardaki bilgiyi kullan; dışarıdan bilgi ekleme.
2) Her bilgi parçasından sonra kaynak numarasını köşeli parantezle yaz: [1]
3) Kaynaklarda cevap yoksa aynen şunu yaz: "Kaynaklarda bu bilgi yok."
4) Kısa, net ve madde madde yaz. En fazla 6 madde.
5) Sayı, tarih, madde numarası gibi ifadeleri kaynaktaki hâliyle aktar.`

  const user = `KAYNAKLAR:\n${sources}\n\nSORU: ${question}`

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/* ---------------- Yardımcılar ---------------- */

export function fmtBytes(n) {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), u.length - 1)
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`
}

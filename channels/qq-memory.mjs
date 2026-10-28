/**
 * 四层记忆，按聊天对象落在磁盘上，不跟桌面会话走。
 * 原文一直追加，可以长到很大；碎片按天收成篇章；反复出现的句子升进档案。
 * 每次只把和这句话相关的几层放进上下文。
 */

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FOLD_AT = 12
const PROMOTE_AT = 3
const RAW_CHARS = 8000
const FRAGMENT_CHARS = 500
const TAIL_BYTES = 256 * 1024
const BUDGET = 1800

export function memoryFileName(sessionKey) {
  const safe = String(sessionKey || 'unknown').replace(/[^a-zA-Z0-9._-]+/g, '_')
  return safe.slice(0, 120)
}

export function splitMemoryUpdate(text) {
  const edits = []
  const visible = String(text || '').replace(/<memory>([\s\S]*?)<\/memory>/gi, (_, body) => {
    const edit = parseMemoryEdit(body)
    if (edit) edits.push(edit)
    return ''
  }).replace(/\n{3,}/g, '\n\n').trim()
  if (!edits.length) return { visible, edit: null }
  return {
    visible,
    edit: {
      add: edits.flatMap((item) => item.add),
      forget: edits.flatMap((item) => item.forget),
    },
  }
}

/** 写入原文和碎片，并在碎片够一叠时收成篇章。 */
export function ingestTurn(dir, sessionKey, { role, text, at = new Date() }) {
  const body = clip(text, RAW_CHARS)
  if (!body || !sessionKey) return null
  const store = ensure(dir, sessionKey)
  const state = readState(store)
  const id = state.next++
  const when = at instanceof Date ? at : new Date(at)
  const day = dayOf(when)
  appendJsonl(store.raw, { id: `r${id}`, at: when.toISOString(), role, text: body })
  const fragment = {
    id: `f${id}`,
    at: when.toISOString(),
    day,
    role,
    text: clip(body, FRAGMENT_CHARS),
  }
  appendJsonl(store.fragments, fragment)
  state.pending.push(fragment)
  organize(store, state)
  writeState(store, state)
  return fragment
}

/** 模型点名要记住或忘掉的，直接改档案。 */
export function applyProfileEdit(dir, sessionKey, edit) {
  const store = ensure(dir, sessionKey)
  const state = readState(store)
  const facts = state.profile.facts
  for (const gone of edit?.forget || []) {
    const needle = String(gone || '').trim()
    if (!needle) continue
    for (let i = facts.length - 1; i >= 0; i--) {
      if (facts[i].text === needle || facts[i].text.includes(needle)) facts.splice(i, 1)
    }
  }
  for (const item of edit?.add || []) {
    const text = clip(item, FRAGMENT_CHARS)
    if (!text) continue
    const found = facts.find((fact) => fact.text === text)
    if (found) found.hits += PROMOTE_AT
    else facts.push({ text, hits: PROMOTE_AT, at: new Date().toISOString() })
  }
  state.profile.facts = facts.slice(-80)
  writeState(store, state)
  return state.profile
}

/** 按这句话从档案、篇章、最近碎片里挑，不把整库塞进上下文。 */
export function retrieveMemory(dir, sessionKey, query) {
  const store = ensure(dir, sessionKey)
  const state = readState(store)
  const wanted = terms(query)
  const episodes = readTailLines(store.episodes, TAIL_BYTES)
    .map((episode) => ({ episode, score: scoreText(episode.summary, wanted) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((item) => item.episode)
  const folded = new Set(episodes.flatMap((episode) => episode.fragmentIds || []))
  const fragments = readTailLines(store.fragments, TAIL_BYTES)
  const ranked = fragments
    .filter((fragment) => !folded.has(fragment.id))
    .map((fragment) => ({ fragment, score: scoreText(fragment.text, wanted) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((item) => item.fragment)
  const recent = state.pending.slice(-3)
  const seen = new Set(ranked.map((fragment) => fragment.id))
  for (const fragment of recent) {
    if (!seen.has(fragment.id)) ranked.push(fragment)
  }
  return {
    facts: [...state.profile.facts].sort((a, b) => b.hits - a.hits).slice(0, 12),
    episodes,
    fragments: ranked.slice(0, 10),
    rawBytes: fileSize(store.raw),
  }
}

export function renderMemoryNote(packet) {
  const lines = ['[记忆] 档案、篇章、碎片、原文分四层存在本地，删掉会话也不会清。这次只带相关的几层。不要原样发到 QQ。']
  if (packet?.facts?.length) {
    lines.push('档案：')
    for (const fact of packet.facts) lines.push(`- ${fact.text}`)
  }
  if (packet?.episodes?.length) {
    lines.push('篇章：')
    for (const episode of packet.episodes) lines.push(`- ${episode.day} ${episode.summary}`)
  }
  if (packet?.fragments?.length) {
    lines.push('碎片：')
    for (const fragment of packet.fragments) lines.push(`- ${fragment.text}`)
  }
  lines.push('若有该长期记住的称呼、约定、偏好或近况，在回复最末另起一行写 <memory>{"add":["一句"],"forget":["旧事实原文"]}</memory>。没有就别写。这一行不会发给对方。')
  return fit(lines.join('\n'), BUDGET)
}

function organize(store, state) {
  promote(state.profile, state.pending)
  const days = new Map()
  for (const fragment of state.pending) {
    const list = days.get(fragment.day) || []
    list.push(fragment)
    days.set(fragment.day, list)
  }
  const folded = new Set()
  for (const [day, items] of days) {
    if (items.length < FOLD_AT) continue
    const episode = {
      id: `e${state.next++}`,
      day,
      at: new Date().toISOString(),
      count: items.length,
      fragmentIds: items.map((item) => item.id),
      summary: summarize(items),
    }
    appendJsonl(store.episodes, episode)
    for (const item of items) folded.add(item.id)
  }
  if (folded.size) state.pending = state.pending.filter((item) => !folded.has(item.id))
}

function promote(profile, items) {
  const counts = new Map()
  for (const item of items) {
    const text = clip(item.text, 120)
    if (text.length < 4) continue
    counts.set(text, (counts.get(text) || 0) + 1)
  }
  for (const [text, count] of counts) {
    if (count < PROMOTE_AT) continue
    const found = profile.facts.find((fact) => fact.text === text)
    if (found) found.hits += count
    else profile.facts.push({ text, hits: count, at: new Date().toISOString() })
  }
  profile.facts = profile.facts.slice(-80)
}

function summarize(items) {
  const seen = new Set()
  const lines = []
  for (const item of items) {
    const text = clip(item.text, 80)
    if (!text || seen.has(text)) continue
    seen.add(text)
    lines.push(text)
    if (lines.length >= 8) break
  }
  return lines.join(' / ')
}

function ensure(dir, sessionKey) {
  const peer = join(dir, memoryFileName(sessionKey))
  mkdirSync(peer, { recursive: true })
  return {
    peer,
    raw: join(peer, 'raw.jsonl'),
    fragments: join(peer, 'fragments.jsonl'),
    episodes: join(peer, 'episodes.jsonl'),
    state: join(peer, 'state.json'),
  }
}

function readState(store) {
  try {
    const parsed = JSON.parse(readFileSync(store.state, 'utf8'))
    return {
      next: Number(parsed.next) || 1,
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      profile: { facts: Array.isArray(parsed.profile?.facts) ? parsed.profile.facts : [] },
    }
  } catch {
    return { next: 1, pending: [], profile: { facts: [] } }
  }
}

function writeState(store, state) {
  writeFileSync(store.state, JSON.stringify(state, null, 2))
  writeFileSync(join(store.peer, 'profile.json'), JSON.stringify(state.profile, null, 2))
}

function appendJsonl(file, value) {
  appendFileSync(file, `${JSON.stringify(value)}\n`)
}

function readTailLines(file, maxBytes) {
  let size
  try { size = statSync(file).size } catch { return [] }
  if (!size) return []
  const start = Math.max(0, size - maxBytes)
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(size - start)
    readSync(fd, buf, 0, buf.length, start)
    let text = buf.toString('utf8')
    if (start > 0) {
      const cut = text.indexOf('\n')
      text = cut >= 0 ? text.slice(cut + 1) : ''
    }
    const rows = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try { rows.push(JSON.parse(line)) } catch {}
    }
    return rows
  } finally {
    closeSync(fd)
  }
}

function fileSize(file) {
  try { return statSync(file).size } catch { return 0 }
}

function scoreText(text, wanted) {
  if (!wanted.size) return 0
  let score = 0
  for (const term of terms(text)) if (wanted.has(term)) score += 1
  return score
}

function terms(text) {
  const source = String(text || '').toLowerCase()
  const found = new Set()
  for (const word of source.split(/[^\p{L}\p{N}]+/u)) {
    if (word.length >= 2) found.add(word)
  }
  const chars = [...source].filter((char) => /\p{Script=Han}/u.test(char))
  for (let i = 0; i < chars.length - 1; i++) found.add(chars[i] + chars[i + 1])
  return found
}

function parseMemoryEdit(body) {
  try {
    const parsed = JSON.parse(String(body || '').trim())
    const add = Array.isArray(parsed.add) ? parsed.add.map((item) => String(item)) : []
    const forget = Array.isArray(parsed.forget) ? parsed.forget.map((item) => String(item)) : []
    if (!add.length && !forget.length) return null
    return { add, forget }
  } catch {
    return null
  }
}

function clip(text, max) {
  const line = String(text || '').replace(/\s+/g, ' ').trim()
  if (!line) return ''
  return line.length > max ? line.slice(0, max) : line
}

function dayOf(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function fit(text, max) {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…其余还在本地，需要时会再翻出来。`
}

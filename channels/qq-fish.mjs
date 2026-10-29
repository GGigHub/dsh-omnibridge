/**
 * QQ 肥鱼这一路的纯逻辑：表情对照、群唤醒、认人、语音请求。
 * 不连网、不碰 DSH，方便单独验证。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** 同一个表情 id 有好几个名字时，她更常写这些。 */
const PREFERRED_FACE_NAMES = new Set(['旺柴'])

/** 名字 → QQ 表情 id。反查优先用她常写的名字。 */
export function loadFaceMap(jsonPath = join(here, 'qq-face-map.json')) {
  const raw = JSON.parse(readFileSync(jsonPath, 'utf8'))
  const nameToId = new Map()
  const idToName = new Map()
  for (const [name, id] of Object.entries(raw)) {
    const n = String(name).trim()
    const s = String(id)
    if (!n || !s) continue
    nameToId.set(n, s)
    if (!idToName.has(s) || PREFERRED_FACE_NAMES.has(n)) idToName.set(s, n)
  }
  return { nameToId, idToName }
}

/** 群里这条消息要不要叫醒她。私聊不走这里。 */
export function shouldAnswerGroup({ groupAtOnly = true, selfReady = true, atMe = false, replyToMe = false, text = '', wakeWords = [] }) {
  if (groupAtOnly === false) return true
  if (!selfReady) return true
  if (atMe || replyToMe) return true
  const body = String(text || '')
  return (wakeWords || []).some((word) => word && body.includes(String(word)))
}

/** 只放进她的上下文，不发回 QQ。 */
export function identityNote(senderId, senderName, ownerIds) {
  const owners = new Set((ownerIds || []).map((id) => String(id)))
  const role = owners.has(String(senderId)) ? '主人' : '朋友'
  const name = senderName || senderId
  return `[身份] ${name}(${senderId}) 是${role}。这行只给你看，不要复述。`
}

const VOICE_ASK = /语音回|用语音|发语音|语音回复|说给我听|念给我/
const TEXT_ASK = /打字回|文字回|别发语音|不要语音|别用语音|用文字/

/** 对方这句话是在让她用语音回。 */
export function wantsVoiceReply(text) {
  return VOICE_ASK.test(String(text || ''))
}

/** 对方这句话是在让她改回打字。 */
export function wantsTextReply(text) {
  return TEXT_ASK.test(String(text || ''))
}

/** 私聊默认念出来。对方要文字时不念。群里仍要明说。 */
export function prefersVoice(target, text, enabled = true) {
  if (enabled === false) return false
  if (wantsTextReply(text)) return false
  const kind = String(target || '').split(':')[0]
  if (kind === 'private') return true
  return wantsVoiceReply(text)
}

const QUIET_MS = 3 * 60 * 60 * 1000

/** 主人隔了几小时没说话，而且这段空档还没主动找过，白天就找一次。 */
export function shouldCheckIn({ lastAt, lastPing, now = new Date(), quietMs = QUIET_MS } = {}) {
  const seen = Date.parse(lastAt || '')
  if (!Number.isFinite(seen)) return false
  const clock = now instanceof Date ? now : new Date(now)
  const hour = clock.getHours()
  if (hour < 8 || hour >= 23) return false
  if (clock.getTime() - seen < quietMs) return false
  const ping = Date.parse(lastPing || '')
  if (Number.isFinite(ping) && ping >= seen) return false
  return true
}

/** 主动开口的那一句。没有近况就不找。 */
export function checkInText({ project, step, lastAsk, agenda } = {}) {
  const bits = []
  if (project) bits.push(`你最近在改 ${project}`)
  if (step) bits.push(`上次停在${step}`)
  else if (lastAsk) bits.push(`上次你说「${String(lastAsk).slice(0, 40)}」`)
  const pending = (agenda || []).map((item) => item?.text || item).filter(Boolean).slice(0, 3)
  if (pending.length) bits.push(`还搁着：${pending.join('，')}`)
  if (!bits.length) return ''
  return `${bits.join('。')}。`
}

/** 只给她看：主人说「这个」「继续」时指的就是最近在改的项目。 */
export function workNote(glance) {
  if (!glance?.project) return ''
  const file = glance.file ? `，刚动过 ${glance.file}` : ''
  return `[正在做] 当前项目是 ${glance.project}${file}。主人说「这个」或「继续」时就是它，不用再问路径。这行不要复述。`
}

const PROJECT_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'data', 'coverage', '.dsh'])

/** 工作目录里最近改过文件的那个项目。 */
export function recentProject(root, now = Date.now(), withinMs = 36 * 60 * 60 * 1000) {
  const base = String(root || '').trim()
  if (!base) return null
  let entries
  try { entries = readdirSync(base, { withFileTypes: true }) } catch { return null }
  const budget = { left: 800 }
  let best = null
  for (const entry of entries) {
    if (budget.left <= 0) break
    if (entry.name.startsWith('.') || PROJECT_SKIP.has(entry.name)) continue
    const path = join(base, entry.name)
    const found = entry.isDirectory()
      ? newestFile(path, entry.name, 2, budget)
      : stampFile(path, entry.name, budget)
    if (!found || now - found.mtime > withinMs) continue
    if (!best || found.mtime > best.mtime) {
      best = { project: entry.isDirectory() ? entry.name : entry.name, file: found.rel, mtime: found.mtime }
    }
  }
  if (!best) return null
  return { project: best.project, file: best.file, at: new Date(best.mtime).toISOString() }
}

function newestFile(dir, rel, depth, budget) {
  if (depth < 0 || budget.left <= 0) return null
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return null }
  let best = null
  for (const entry of entries) {
    if (budget.left <= 0) break
    if (entry.name.startsWith('.') || PROJECT_SKIP.has(entry.name)) continue
    const path = join(dir, entry.name)
    const next = `${rel}/${entry.name}`
    const found = entry.isDirectory() ? newestFile(path, next, depth - 1, budget) : stampFile(path, next, budget)
    if (found && (!best || found.mtime > best.mtime)) best = found
  }
  return best
}

function stampFile(path, rel, budget) {
  budget.left -= 1
  try {
    const st = statSync(path)
    if (!st.isFile()) return null
    return { mtime: st.mtimeMs, rel }
  } catch {
    return null
  }
}

/** 系统提示不要念成语音条。 */
export function isSystemOutbound(text) {
  return /^[⏳❌⏹⚠️♻️✅💤🤖]/.test(String(text || '').trim())
}

/** 像 QQ 一样把一段回复拆成几条短消息。报告和系统提示保持一整条。 */
export function chatBubbles(text) {
  const raw = String(text || '').trim()
  if (!raw) return []
  if (isSystemOutbound(raw) || /累计 token|账户余额|当前会话：|未知命令|命令执行/.test(raw)) return [raw]
  const pieces = []
  for (const block of raw.split(/\n+/)) {
    const line = block.trim()
    if (!line) continue
    pieces.push(...splitChatLine(line))
  }
  if (pieces.length <= 4) return pieces
  return [...pieces.slice(0, 3), pieces.slice(3).join('\n')]
}

function splitChatLine(line) {
  if (line.length <= 42) return [line]
  const bits = line.split(/(?<=[。！？!?；])/).map((bit) => bit.trim()).filter(Boolean)
  if (bits.length <= 1) return [line]
  const out = []
  let current = ''
  for (const bit of bits) {
    if (bit.length < 4 && current) {
      current += bit
      continue
    }
    if (current && current.length + bit.length > 42) {
      out.push(current)
      current = bit
    } else {
      current += bit
    }
  }
  if (current) out.push(current)
  return out
}

/** 念出来的句子：去掉表情方括号和常见记号，最多 300 字。 */
export function spokenForTts(text) {
  const spoken = String(text || '')
    .replace(/\[[^\[\]]{1,12}\]/g, '')
    .replace(/[`*#_>~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return spoken.slice(0, 300)
}

function cqField(body, key) {
  const m = new RegExp(`(?:^|[&,])${key}=([^,\\]]*)`).exec(body || '')
  return m ? cqUnescape(m[1]) : ''
}

export function cqUnescape(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#91;/g, '[')
    .replace(/&#93;/g, ']')
    .replace(/&comma;/g, ',')
}

function faceToken(id, idToName) {
  const name = idToName.get(String(id))
  return name ? `[${name}]` : `[表情${id}]`
}

/**
 * 把一条 OneBot 消息拆成文本、图片、是否 @、被引用的消息号、语音文件。
 * selfId 用来认 @。
 */
export function parseOnebotMessage(data, { selfId = '', idToName = new Map() } = {}) {
  const images = []
  let atMe = false
  let replyId = null
  let voice = null
  let text = ''
  const self = String(selfId || '')

  const takeVoice = (file, url) => {
    if (voice) return
    if (!file && !url) return
    voice = { file: file || '', url: url || '' }
  }

  if (typeof data?.raw_message === 'string') {
    const raw = data.raw_message
    if (self && new RegExp(`\\[CQ:at,qq=${self.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[,\\]]`).test(raw)) atMe = true
    if (/\[CQ:at,qq=all[,\]]/.test(raw)) atMe = true
    const reply = /\[CQ:reply,([^\]]*)\]/.exec(raw)
    if (reply) {
      const id = cqField(reply[1], 'id')
      if (id) replyId = id
    }
    const record = /\[CQ:record,([^\]]*)\]/.exec(raw)
    if (record) takeVoice(cqField(record[1], 'file'), cqField(record[1], 'url'))
    for (const m of raw.matchAll(/\[CQ:image,([^\]]*)\]/g)) {
      const url = cqField(m[1], 'url')
      if (!/^https?:\/\//i.test(url)) continue
      const file = cqField(m[1], 'file')
      images.push({ url, ...(file ? { name: file.slice(0, 120) } : {}) })
    }
    text = raw
      .replace(/\[CQ:face,([^\]]*)\]/g, (_, body) => faceToken(cqField(body, 'id'), idToName))
      .replace(/\[CQ:[^\]]+\]/g, '')
      .trim()
  } else if (Array.isArray(data?.message)) {
    const bits = []
    for (const seg of data.message) {
      const type = seg?.type
      const d = seg?.data || {}
      if (type === 'text') bits.push(String(d.text ?? ''))
      else if (type === 'face') bits.push(faceToken(d.id, idToName))
      else if (type === 'at') {
        const qq = String(d.qq ?? '')
        if (qq === 'all' || (self && qq === self)) atMe = true
      } else if (type === 'reply' && d.id != null && d.id !== '') replyId = String(d.id)
      else if (type === 'record') takeVoice(String(d.file || ''), String(d.url || ''))
      else if (type === 'image') {
        const url = String(d.url || d.file || '')
        if (/^https?:\/\//i.test(url)) {
          images.push({ url, ...(d.file ? { name: String(d.file).slice(0, 120) } : {}) })
        }
      }
    }
    text = bits.join('').trim()
  }

  return { text, images, atMe, replyId, voice }
}

/** 有表情才返回段数组；没有就返回 null，调用方继续发纯文本。 */
export function toOnebotSegments(text, nameToId) {
  const src = String(text || '')
  const re = /\[([^\[\]]+)\]/g
  const parts = []
  let last = 0
  let hit = false
  let m
  while ((m = re.exec(src))) {
    const id = nameToId.get(m[1])
    if (id == null) continue
    hit = true
    if (m.index > last) parts.push({ type: 'text', data: { text: src.slice(last, m.index) } })
    parts.push({ type: 'face', data: { id: String(id) } })
    last = m.index + m[0].length
  }
  if (!hit) return null
  if (last < src.length) parts.push({ type: 'text', data: { text: src.slice(last) } })
  return parts.filter((p) => p.type !== 'text' || p.data.text)
}

const ACTION_TAG_RE = /<(poke|like|remark|recall|notice|file|history|files|album)\b([^>]*)\/>|<(poke|like|remark|recall|notice|file|history|files|album)\b([^>]*)>([\s\S]*?)<\/\3>/gi

function parseAttrs(raw) {
  const attrs = {}
  const re = /([A-Za-z_]+)="([^"]*)"/g
  let match
  while ((match = re.exec(String(raw || '')))) attrs[match[1].toLowerCase()] = match[2]
  return attrs
}

/** 从回复里拆出发图、说说，以及要交给 NapCat 的动作。标记本身不留给对方看。 */
export function splitOutbound(text) {
  const images = []
  const actions = []
  let qzone = null
  ACTION_TAG_RE.lastIndex = 0
  const visible = String(text || '')
    .replace(ACTION_TAG_RE, (full, singleName, singleAttrs, pairName, pairAttrs, body) => {
      const type = String(singleName || pairName || '').toLowerCase()
      if (!type) return full
      actions.push({ type, attrs: parseAttrs(singleAttrs || pairAttrs), body: String(body || '').trim() })
      return ''
    })
    .replace(/<image>([\s\S]*?)<\/image>/gi, (_, body) => {
      const src = String(body || '').trim()
      if (src) images.push(src)
      return ''
    })
    .replace(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g, (_, url) => {
      images.push(url)
      return ''
    })
    .replace(/<qzone>([\s\S]*?)<\/qzone>/gi, (_, body) => {
      qzone = String(body || '').trim()
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { visible, images, qzone, actions }
}

function messageText(msg) {
  if (typeof msg?.raw_message === 'string' && msg.raw_message.trim()) return msg.raw_message.replace(/\s+/g, ' ').trim()
  const message = msg?.message
  if (typeof message === 'string') return message.replace(/\s+/g, ' ').trim()
  if (!Array.isArray(message)) return ''
  return message.map((seg) => {
    if (seg?.type === 'text') return seg.data?.text || ''
    if (seg?.type === 'image') return '[图片]'
    if (seg?.type === 'record') return '[语音]'
    if (seg?.type === 'face') return '[表情]'
    if (seg?.type === 'at') return `@${seg.data?.qq || ''}`
    if (seg?.type === 'file') return `[文件 ${seg.data?.name || seg.data?.file || ''}]`
    return ''
  }).join('').replace(/\s+/g, ' ').trim()
}

/** 把历史消息收成给她看的短名单，最多 30 行。 */
export function formatHistory(data) {
  const messages = Array.isArray(data?.messages) ? data.messages : []
  if (!messages.length) return '没有翻到更早的聊天记录。'
  const lines = messages.slice(-30).map((msg) => {
    const name = msg?.sender?.card || msg?.sender?.nickname || msg?.sender?.user_id || '某人'
    const text = messageText(msg).slice(0, 80)
    const id = msg?.message_id != null ? ` #${msg.message_id}` : ''
    return `${name}${id}：${text || '[非文字]'}`
  })
  return `最近聊天：\n${lines.join('\n')}`
}

function formatSize(n) {
  const size = Number(n) || 0
  if (size >= 1048576) return `${(size / 1048576).toFixed(1)} MB`
  if (size >= 1024) return `${Math.round(size / 1024)} KB`
  return `${size} B`
}

/** 群文件根目录。keyword 有的话优先列出名字里带它的。 */
export function formatFileList(data, keyword = '') {
  const files = Array.isArray(data?.files) ? data.files : []
  const folders = Array.isArray(data?.folders) ? data.folders : []
  const lines = [
    ...folders.map((folder) => `文件夹 ${folder.folder_name || folder.name || '未命名'}`),
    ...files.map((file) => `${file.file_name || file.name || '未命名'}（${formatSize(file.file_size || file.size)}）`),
  ]
  const query = String(keyword || '').trim()
  const filtered = query ? lines.filter((line) => line.includes(query)) : lines
  const shown = (filtered.length ? filtered : lines).slice(0, 20)
  if (!shown.length) return '群文件是空的。'
  return `群文件：\n${shown.join('\n')}`
}

/** 群相册名单。 */
export function formatAlbumList(data) {
  const albums = Array.isArray(data?.album_list) ? data.album_list : []
  if (!albums.length) return '这个群没有相册。'
  const lines = albums.slice(0, 20).map((album) => {
    const name = album.album_name || '未命名'
    const id = album.album_id ? `（编号 ${album.album_id}）` : ''
    return `${name}${id}`
  })
  return `群相册：\n${lines.join('\n')}`
}

/** 某个相册里的照片地址，最多 8 张。 */
export function formatAlbumMedia(name, data) {
  const list = Array.isArray(data) ? data : (data?.media_list || data?.response?.media_list || [])
  if (!list.length) return `相册「${name}」里没有照片。`
  const lines = list.slice(0, 8).map((media, index) => {
    const url = media?.url || media?.cover_url || ''
    return `${index + 1}. ${url || media?.media_id || '一张照片'}`
  })
  return `相册「${name}」：\n${lines.join('\n')}`
}

/** NapCat 能发出去的图：网址、base64，或本机路径。 */
export function isSendableImage(src) {
  const value = String(src || '').trim()
  if (/^https?:\/\//i.test(value)) return true
  if (/^base64:\/\//i.test(value)) return true
  if (/^file:\/\//i.test(value)) return true
  if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) return true
  return false
}

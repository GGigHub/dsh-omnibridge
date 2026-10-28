/**
 * QQ 肥鱼这一路的纯逻辑：表情对照、群唤醒、认人、语音请求。
 * 不连网、不碰 DSH，方便单独验证。
 */

import { readFileSync } from 'node:fs'
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

/** 对方这句话是在让她用语音回。 */
export function wantsVoiceReply(text) {
  return VOICE_ASK.test(String(text || ''))
}

/** 系统提示不要念成语音条。 */
export function isSystemOutbound(text) {
  return /^[⏳❌⏹⚠️♻️✅💤🤖]/.test(String(text || '').trim())
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

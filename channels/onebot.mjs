/**
 * dsh-omnibridge channel: QQ（OneBot v11 正向 WS 客户端）。
 *
 * 直连 NapCat / go-cqhttp / Lagrange 等 OneBot v11 实现的 WebSocket
 * 服务端。本机 NapCat 示例：ws://127.0.0.1:3001?access_token=%20
 *
 * target 约定："group:<群号>" | "private:<QQ号>"
 *
 * QQ 肥鱼补充（只在这一路）：真表情、语音条、群里喊名字叫醒、背后认人。
 *
 * @module dsh-omnibridge/channels/onebot
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Channel, InboundMessage, splitForDelivery } from '../bridge-core.mjs'
import { Reconnector } from './retry.mjs'
import {
  formatAlbumList,
  formatAlbumMedia,
  formatFileList,
  formatHistory,
  identityNote,
  isSendableImage,
  bubbleGapMs,
  chatBubbles,
  inboxWaitMs,
  isSystemOutbound,
  loadFaceMap,
  parseOnebotMessage,
  shouldAnswerGroup,
  splitOutbound,
  prefersVoice,
  spokenForTts,
  toOnebotSegments,
} from './qq-fish.mjs'

/** OneBot action 回执等待上限。 */
const RPC_TIMEOUT_MS = 8000
/** 登录信息查询回执上限。 */
const LOGIN_TIMEOUT_MS = 5000
const RECORD_TIMEOUT_MS = 30000
const ACTION_FAIL = {
  poke: '戳一戳没发出去。',
  like: '点赞没发出去。',
  remark: '备注没改成。',
  recall: '没撤回。',
  notice: '公告没发出去。',
  file: '文件没传上去。',
  history: '聊天记录没翻到。',
  files: '群文件没列出来。',
  album: '群相册没打开。',
}

const faces = loadFaceMap()

export class OneBotChannel extends Channel {
  constructor(config) {
    super('onebot', config)
    this.ws = null
    this.pending = new Map()
    this.echoSeq = 0
    this.selfId = null
    this.reconnector = new Reconnector({ baseDelayMs: config.reconnectDelayMs || 5000 })
    this.closed = false
    /** target → 下一句真人回复要不要配语音条 */
    this.voiceTargets = new Set()
    /** 同一聊天里连着发来的几句，等对方停一下再一起交给她。 */
    this.inbox = new Map()
  }

  get url() {
    return this.config.url || 'ws://127.0.0.1:3001?access_token=%20'
  }

  /** 发送 OneBot action 并等待回执。 */
  call(action, params, timeoutMs = RPC_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new Error('OneBot WebSocket 未连接'))
        return
      }
      const echo = `omni-${++this.echoSeq}`
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new Error(`OneBot action ${action} 超时`))
      }, timeoutMs)
      this.pending.set(echo, { resolve, reject, timer })
      this.ws.send(JSON.stringify({ action, params, echo }))
    })
  }

  async start(ctx, bridge) {
    if (typeof WebSocket === 'undefined') {
      throw new Error('当前 Node 无全局 WebSocket（需要 Node ≥ 22 或 --experimental-websocket）')
    }
    this.ctx = ctx
    this.bridge = bridge
    this.closed = false
    this.connect()
  }

  connect() {
    if (this.closed) return
    try {
      this.ws = new WebSocket(this.url)
    } catch (error) {
      this.ctx?.logger?.error?.('[dsh-omnibridge:onebot] connect error: %s', error instanceof Error ? error.message : String(error))
      this.scheduleReconnect()
      return
    }
    this.ws.onopen = () => {
      this.ctx?.logger?.info?.('[dsh-omnibridge:onebot] connected to %s', this.url)
      this.reconnector.reset()
      this.call('get_login_info', {}, LOGIN_TIMEOUT_MS).then((r) => {
        if (r?.retcode === 0 && r?.data?.user_id) {
          this.selfId = String(r.data.user_id)
          this.bridge?.noteQqLogin?.({ uin: this.selfId, nick: r.data.nickname || '' })
        }
      }).catch(() => {})
    }
    this.ws.onmessage = (ev) => {
      let data
      try { data = JSON.parse(String(ev.data)) } catch { return }
      void this.handleMessage(data)
    }
    this.ws.onclose = () => {
      if (this.closed) return
      if (this.manualReconnect) {
        this.manualReconnect = false
        this.connect()
        return
      }
      this.ctx?.logger?.warn?.('[dsh-omnibridge:onebot] connection closed, reconnecting…')
      this.scheduleReconnect()
    }
    this.ws.onerror = () => {
      try { this.ws?.close() } catch {}
    }
  }

  scheduleReconnect() {
    this.reconnector.schedule(() => this.connect())
  }

  async handleMessage(data) {
    if (data.echo && this.pending.has(String(data.echo))) {
      const p = this.pending.get(String(data.echo))
      this.pending.delete(String(data.echo))
      clearTimeout(p.timer)
      if (data.status === 'ok' || data.retcode === 0) p.resolve(data)
      else p.reject(new Error(`OneBot retcode ${data.retcode}: ${data.status || ''}`))
      return
    }
    if (data.post_type !== 'message') return
    const self = String(data.self_id ?? this.selfId ?? '')
    const senderId = String(data.user_id ?? '')
    if (self && senderId === self) return
    const parsed = parseOnebotMessage(data, { selfId: self, idToName: faces.idToName })
    const isGroup = data.message_type === 'group'
    let replyToMe = false
    if (isGroup && parsed.replyId && self) replyToMe = await this.replyTargetsSelf(parsed.replyId)
    let text = parsed.text
    // 先听完语音，群里喊「大肥鱼」的声音才叫得醒她
    if (parsed.voice && (!isGroup || parsed.atMe || replyToMe || this.config.groupAtOnly === false || !(parsed.text || '').trim())) {
      const heard = await this.transcribeVoice(parsed.voice)
      text = text ? `${text}\n${heard}` : heard
    }
    if (isGroup && !shouldAnswerGroup({
      groupAtOnly: this.config.groupAtOnly !== false,
      selfReady: !!self,
      atMe: parsed.atMe,
      replyToMe,
      text,
      wakeWords: this.config.groupWakeWords || ['大肥鱼'],
    })) {
      const heard = text || (parsed.images.length ? `[图片${parsed.images.length}张]` : '') || (parsed.voice ? '[语音]' : '')
      if (heard) {
        const who = data.sender?.card || data.sender?.nickname || senderId
        this.bridge?.overhear?.(`qq-group:${data.group_id}`, `${who}：${heard}`)
      }
      return
    }
    if (parsed.voice && !text.includes('语音转写') && !text.includes('没听清')) {
      const heard = await this.transcribeVoice(parsed.voice)
      text = text ? `${text}\n${heard}` : heard
    }
    if (!text && !parsed.images.length) return

    const target = isGroup ? `group:${data.group_id}` : `private:${senderId}`
    const command = text.startsWith('/')
    if (!command && prefersVoice(target, text, this.config.voiceReply !== false)) this.voiceTargets.add(target)
    else this.voiceTargets.delete(target)
    const sessionKey = isGroup ? `qq-group:${data.group_id}` : `qq-private:${senderId}`
    const senderName = data.sender?.card || data.sender?.nickname || senderId
    await this.acceptChat(new InboundMessage({
      platform: 'onebot',
      sessionKey,
      senderId,
      senderName,
      text,
      images: parsed.images.length ? parsed.images : undefined,
      contextNote: [
        identityNote(senderId, senderName, this.config.ownerIds || ['2711686331']),
        '[怎么说话] 像在 QQ 里聊天。用空行分成两三条，每条只说一两句，不要写成一段作文，也不必每句都追问。有时回一个表情就够。对方连着发来的几句是同一次。查天气、新闻、网页这些实时信息，用你已有的搜索工具去查，不要说自己不能联网。私聊你的回复会另外念成语音，所以文字保持短。',
        '[先做] 主人交代的事直接做完，再用一两句说结果。少反问。改代码就改「正在做」的那个项目，看文件、改文件、跑命令，不要说自己不能写文件。对方指定了别的路径就去那个路径。日程写进记事的 agenda，办完的写进 done。不要把整份代码贴到 QQ。',
        '[能做的事] 标记不要原样发出来。发图 <image>网址或本机路径</image>。发说说 <qzone>正文</qzone>。撤回 <recall>消息号</recall>。戳一戳 <poke>QQ号</poke>，私聊可写 <poke/>。点赞 <like>QQ号</like>，多次写 <like times="3">QQ号</like>，最多 10。改备注 <remark user="QQ号">备注</remark>，私聊可写 <remark>备注</remark>。群公告 <notice>正文</notice>。传文件 <file>本机路径或网址</file>。看最近聊天 <history>20</history>。看群文件 <files/>，要下载地址就写 <files>文件名</files>。看群相册 <album/>，看某个相册 <album>相册名</album>。群里没点你的话已经记在这个群的记事里，不要主动插话。',
      ].join('\n'),
      raw: { target, messageId: data.message_id },
    }))
  }

  /** 连发的几句合成一次。以 / 开头的命令不等。 */
  async acceptChat(msg) {
    const heard = String(msg.text || '').trim()
    if (heard) this.lastHeard = { from: msg.senderName || msg.senderId || '', text: heard.slice(0, 80), at: Date.now() }
    const text = heard
    if (text.startsWith('/')) {
      await this.flushInbox(msg.sessionKey)
      await this.bridge?.handleInbound(msg)
      return
    }
    let bucket = this.inbox.get(msg.sessionKey)
    if (!bucket) {
      bucket = { timer: null, msgs: [] }
      this.inbox.set(msg.sessionKey, bucket)
    }
    bucket.msgs.push(msg)
    clearTimeout(bucket.timer)
    bucket.timer = setTimeout(() => { void this.flushInbox(msg.sessionKey) }, inboxWaitMs(msg.sessionKey))
  }

  async flushInbox(key) {
    const bucket = this.inbox.get(key)
    if (!bucket) return
    clearTimeout(bucket.timer)
    this.inbox.delete(key)
    const msgs = bucket.msgs
    if (!msgs.length) return
    const last = msgs[msgs.length - 1]
    const text = msgs.map((item) => String(item.text || '').trim()).filter(Boolean).join('\n')
    const images = msgs.flatMap((item) => item.images || [])
    await this.bridge?.handleInbound(new InboundMessage({
      platform: last.platform,
      sessionKey: last.sessionKey,
      senderId: last.senderId,
      senderName: last.senderName,
      text,
      images: images.length ? images : undefined,
      contextNote: last.contextNote,
      replyToken: last.replyToken,
      raw: last.raw,
    }))
  }

  async replyTargetsSelf(messageId) {
    try {
      const id = /^\d+$/.test(String(messageId)) ? Number(messageId) : messageId
      const r = await this.call('get_msg', { message_id: id })
      const uid = r?.data?.sender?.user_id ?? r?.data?.user_id
      return String(uid || '') === String(this.selfId)
    } catch {
      return false
    }
  }

  async transcribeVoice(voice) {
    try {
      const file = await this.resolveVoiceFile(voice)
      if (!file) return '[语音]（没听清）'
      const { transcribeWavFile } = await import('./qq-stt.mjs')
      const heard = transcribeWavFile(file)
      return heard ? `（语音转写：${heard}）` : '[语音]（没听清）'
    } catch (error) {
      this.ctx?.logger?.warn?.('[dsh-omnibridge:onebot] 语音转写失败: %s', error instanceof Error ? error.message : String(error))
      return '[语音]（没听清）'
    }
  }

  async resolveVoiceFile(voice) {
    if (voice.file) {
      try {
        const r = await this.call('get_record', { file: voice.file, out_format: 'wav' }, RECORD_TIMEOUT_MS)
        const loc = r?.data?.file || r?.data?.url || ''
        const local = await materializeMedia(String(loc))
        if (local) return local
      } catch (error) {
        this.ctx?.logger?.warn?.('[dsh-omnibridge:onebot] get_record 失败: %s', error instanceof Error ? error.message : String(error))
      }
    }
    if (voice.url) return materializeMedia(voice.url)
    return null
  }

  /** 整段回复：先做戳一戳、点赞这些动作，再发说说和图片，剩下的文字分段发出。查记录时不把原文发给对方，交给下一句来讲。 */
  async deliver(target, text, max = 2000) {
    const { visible, images, qzone, actions } = splitOutbound(text)
    const [kind, id] = String(target).split(':')
    if (!id) throw new Error(`无效 target: ${target}`)
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const who = kind === 'group' ? { group_id: Number(id) } : { user_id: Number(id) }
    const acks = []
    const lookups = []
    for (const item of actions || []) {
      try {
        const result = await this.runAction(kind, id, item)
        if (result?.lookup) lookups.push(result.lookup)
        else if (result?.ack) acks.push(result.ack)
      } catch (error) {
        this.ctx?.logger?.warn?.('[dsh-omnibridge:onebot] %s 失败: %s', item.type, error instanceof Error ? error.message : String(error))
        const failed = ACTION_FAIL[item.type] || '这步没做成。'
        if (item.type === 'history' || item.type === 'files' || item.type === 'album') lookups.push(failed)
        else acks.push(failed)
      }
    }
    const pics = images.filter(isSendableImage)
    let posted = false
    if (qzone) {
      try {
        const params = { content: qzone.slice(0, 2000) }
        if (pics.length) params.images = pics
        await this.call('send_qzone_msg', params, 60000)
        posted = true
      } catch (error) {
        this.ctx?.logger?.warn?.('[dsh-omnibridge:onebot] 发说说失败: %s', error instanceof Error ? error.message : String(error))
        await this.call(action, { ...who, message: '说说没发出去。' })
      }
    }
    const chatImages = posted ? [] : pics
    let body = visible
    if (!body && !chatImages.length && posted) body = '发到空间了。'
    const hold = lookups.length > 0
    if (!body && !chatImages.length && acks.length && !hold) body = acks.join('\n')
    const report = /累计 token|账户余额|当前会话：|未知命令|命令执行/.test(body || '')
    let voiceP = null
    if (!hold && this.voiceTargets.has(target) && body && !isSystemOutbound(body) && !report) {
      this.voiceTargets.delete(target)
      const spoken = spokenForTts(body)
      if (spoken) {
        voiceP = synthesizeSpeech(spoken, this.config.ttsScript).catch((error) => {
          this.ctx?.logger?.warn?.('[dsh-omnibridge:onebot] 语音回复失败: %s', error instanceof Error ? error.message : String(error))
          return ''
        })
      }
    }
    if (!hold && body) {
      const bubbles = chatBubbles(body)
      for (let i = 0; i < bubbles.length; i++) {
        const gap = i > 0 ? bubbleGapMs(kind, bubbles[i]) : 0
        if (gap) await this.showTyping(kind, id, gap)
        const chunks = splitForDelivery(bubbles[i], max)
        for (let j = 0; j < chunks.length; j++) {
          const segments = toOnebotSegments(chunks[j], faces.nameToId) || [{ type: 'text', data: { text: chunks[j] } }]
          if (i === bubbles.length - 1 && j === chunks.length - 1) {
            for (const file of chatImages) segments.push({ type: 'image', data: { file } })
          }
          await this.call(action, { ...who, message: segments })
        }
      }
    } else if (chatImages.length) {
      await this.call(action, {
        ...who,
        message: chatImages.map((file) => ({ type: 'image', data: { file } })),
      })
    }
    if (voiceP) {
      const wav = await voiceP
      if (wav) {
        try {
          await this.call(action, { ...who, message: [{ type: 'record', data: { file: wav } }] }, RECORD_TIMEOUT_MS)
        } catch (error) {
          this.ctx?.logger?.warn?.('[dsh-omnibridge:onebot] 语音条没发出去: %s', error instanceof Error ? error.message : String(error))
        }
      }
    }
    if (!hold) return null
    const lookup = lookups.join('\n\n')
    return {
      lookup,
      followup: [
        '[查询结果] 只给你看，不要原样发到 QQ。用口语告诉对方。对方如果要撤回、下载或看某一张照片，可以再写一个对应标记，不要把查询再做一遍。',
        acks.length ? `已经做完：${acks.join(' ')}` : '',
        body ? `你刚才准备说的话：${body}` : '',
        lookup,
      ].filter(Boolean).join('\n'),
    }
  }

  async runAction(kind, id, item) {
    const group = kind === 'group'
    const peer = String(id)
    const body = String(item.body || '').trim()
    const qqOf = (value) => String(value || '').replace(/\D/g, '')
    switch (item.type) {
      case 'poke': {
        const user = qqOf(body || (group ? '' : peer))
        if (!user) return { ack: '戳一戳要写对方的 QQ 号。' }
        if (group) await this.call('send_poke', { group_id: peer, user_id: user })
        else await this.call('send_poke', { user_id: user })
        return { ack: '戳了一下。' }
      }
      case 'like': {
        const user = qqOf(body || item.attrs.user || (group ? '' : peer))
        if (!user) return { ack: '点赞要写对方的 QQ 号。' }
        let times = Number(item.attrs.times || 1)
        if (!Number.isFinite(times) || times < 1) times = 1
        if (times > 10) times = 10
        await this.call('send_like', { user_id: user, times })
        return { ack: '点过赞了。' }
      }
      case 'remark': {
        const user = qqOf(item.attrs.user || (group ? '' : peer))
        const remark = body.slice(0, 60)
        if (!user || !remark) return { ack: '改备注要有 QQ 号和备注名。' }
        await this.call('set_friend_remark', { user_id: user, remark })
        return { ack: '备注改好了。' }
      }
      case 'recall': {
        if (!body) return { ack: '撤回要有消息号。' }
        await this.call('delete_msg', { message_id: /^\d+$/.test(body) ? Number(body) : body })
        return { ack: '撤回了。' }
      }
      case 'notice': {
        if (!group) return { ack: '公告只能发在群里。' }
        if (!body) return { ack: '公告没有内容。' }
        await this.call('_send_group_notice', { group_id: peer, content: body.slice(0, 1000) })
        return { ack: '公告发出去了。' }
      }
      case 'file': {
        if (!body) return { ack: '传文件要有路径或网址。' }
        const name = item.attrs.name || body.split(/[/\\]/).pop() || 'file'
        if (group) await this.call('upload_group_file', { group_id: peer, file: body, name }, 60000)
        else await this.call('upload_private_file', { user_id: peer, file: body, name }, 60000)
        return { ack: '文件传好了。' }
      }
      case 'history': {
        let count = Number(body) || 20
        if (count < 1) count = 1
        if (count > 30) count = 30
        const params = { message_seq: 0, count }
        const result = group
          ? await this.call('get_group_msg_history', { group_id: peer, ...params }, 20000)
          : await this.call('get_friend_msg_history', { user_id: peer, ...params }, 20000)
        return { lookup: formatHistory(result?.data) }
      }
      case 'files': {
        if (!group) return { lookup: '私聊没有群文件。要传文件就写文件路径。' }
        const result = await this.call('get_group_root_files', { group_id: peer }, 20000)
        return { lookup: await this.fileLookup(peer, result?.data, body) }
      }
      case 'album': {
        if (!group) return { lookup: '私聊没有群相册。' }
        const result = await this.call('get_qun_album_list', { group_id: peer, attach_info: '' }, 20000)
        return { lookup: await this.albumLookup(peer, result?.data, body) }
      }
      default:
        return null
    }
  }

  async fileLookup(groupId, data, keyword) {
    const text = formatFileList(data, keyword)
    const files = Array.isArray(data?.files) ? data.files : []
    const query = String(keyword || '').trim()
    const hit = query ? files.find((file) => String(file.file_name || file.name || '').includes(query)) : null
    if (!hit?.file_id) return text
    try {
      const url = await this.call('get_group_file_url', { group_id: groupId, file_id: hit.file_id }, 20000)
      if (url?.data?.url) return `${text}\n「${hit.file_name || hit.name}」的下载地址：${url.data.url}`
    } catch {}
    return text
  }

  async albumLookup(groupId, data, query) {
    const albums = Array.isArray(data?.album_list) ? data.album_list : []
    const name = String(query || '').trim()
    if (!name) return formatAlbumList(data)
    const hit = albums.find((album) => album.album_id === name || String(album.album_name || '').includes(name))
    if (!hit?.album_id) return `${formatAlbumList(data)}\n没有名叫「${name}」的相册。`
    const media = await this.call('get_group_album_media_list', {
      group_id: groupId,
      album_id: hit.album_id,
      attach_info: '',
    }, 20000)
    return formatAlbumMedia(hit.album_name || name, media?.data)
  }

  /** 发送文本。有表情就改成表情段；这一轮若对方要求语音，再附一条语音。 */
  async send(target, text) {
    await this.deliver(target, text, this.bridge?.config?.maxMessageChars || 2000)
  }

  async showTyping(kind, id, ms) {
    if (kind !== 'group') this.call('set_input_status', { user_id: String(id), event_type: 1 }).catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, ms))
  }

  async stop() {
    this.closed = true
    for (const bucket of this.inbox.values()) clearTimeout(bucket.timer)
    this.inbox.clear()
    this.reconnector.close()
    try { this.ws?.close() } catch {}
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('channel stopped')) }
    this.pending.clear()
  }

  linkState() {
    const connected = this.ws?.readyState === 1
    return {
      connected: !!connected,
      reconnecting: !this.closed && !connected,
      selfId: this.selfId || '',
      lastHeard: this.lastHeard || null,
    }
  }

  reconnectNow() {
    this.closed = false
    if (this.reconnector.closed) this.reconnector = new Reconnector({ baseDelayMs: this.config.reconnectDelayMs || 5000 })
    const socket = this.ws
    if (!socket || socket.readyState === 3) {
      this.connect()
      return
    }
    this.manualReconnect = true
    try { socket.close() } catch {
      this.manualReconnect = false
      this.connect()
    }
  }

  async sendProbe(uin) {
    const id = String(uin || '').trim()
    if (!/^\d{5,12}$/.test(id)) throw new Error('还没有主人 QQ 号')
    if (this.ws?.readyState !== 1) throw new Error('DeepSeek 还没接上 QQ')
    await this.call('send_private_msg', { user_id: id, message: '测试。我在。' })
  }
}

function mediaDir() {
  const dir = join(tmpdir(), 'dsh-omnibridge-qq')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 把 OneBot 给的路径、网址或 base64 落成本地文件。 */
export async function materializeMedia(loc) {
  const value = String(loc || '').trim()
  if (!value) return null
  if (value.startsWith('base64://')) {
    const file = join(mediaDir(), `in-${Date.now()}.wav`)
    writeFileSync(file, Buffer.from(value.slice('base64://'.length), 'base64'))
    return file
  }
  if (/^https?:\/\//i.test(value)) {
    const resp = await fetch(value, { signal: AbortSignal.timeout(RECORD_TIMEOUT_MS) })
    if (!resp.ok) return null
    const file = join(mediaDir(), `in-${Date.now()}.wav`)
    writeFileSync(file, Buffer.from(await resp.arrayBuffer()))
    return file
  }
  const path = value.replace(/^file:\/\//, '')
  if (existsSync(path)) return path
  return null
}

export function defaultTtsScript() {
  const candidates = [
    join('D:\\Gitobjects\\dsh-voice-mode\\tools\\tts-to-file.mjs'),
    join(homedir(), 'dsh-voice-mode', 'tools', 'tts-to-file.mjs'),
  ]
  return candidates.find((p) => existsSync(p)) || ''
}

/** 用本机已有的语音脚本合成 wav，返回文件路径。 */
export function synthesizeSpeech(text, script) {
  const tts = script || defaultTtsScript()
  if (!tts || !existsSync(tts)) return Promise.reject(new Error('找不到本机语音合成脚本'))
  const out = join(mediaDir(), `out-${Date.now()}.wav`)
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tts, '--text', text, '--out', out, '--engine', 'kokoro'], { windowsHide: true })
    let err = ''
    child.stderr?.on('data', (d) => { err += String(d) })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0 && existsSync(out)) resolve(out)
      else reject(new Error(err.trim() || `语音合成退出码 ${code}`))
    })
  })
}

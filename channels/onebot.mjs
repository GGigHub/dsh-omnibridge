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
import { Channel, InboundMessage } from '../bridge-core.mjs'
import { Reconnector } from './retry.mjs'
import {
  identityNote,
  isSystemOutbound,
  loadFaceMap,
  parseOnebotMessage,
  shouldAnswerGroup,
  spokenForTts,
  toOnebotSegments,
  wantsVoiceReply,
} from './qq-fish.mjs'

/** OneBot action 回执等待上限。 */
const RPC_TIMEOUT_MS = 8000
/** 登录信息查询回执上限。 */
const LOGIN_TIMEOUT_MS = 5000
const RECORD_TIMEOUT_MS = 30000

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
        if (r?.retcode === 0 && r?.data?.user_id) this.selfId = String(r.data.user_id)
      }).catch(() => {})
    }
    this.ws.onmessage = (ev) => {
      let data
      try { data = JSON.parse(String(ev.data)) } catch { return }
      void this.handleMessage(data)
    }
    this.ws.onclose = () => {
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
    })) return
    if (parsed.voice && !text.includes('语音转写') && !text.includes('没听清')) {
      const heard = await this.transcribeVoice(parsed.voice)
      text = text ? `${text}\n${heard}` : heard
    }
    if (!text && !parsed.images.length) return

    const target = isGroup ? `group:${data.group_id}` : `private:${senderId}`
    if (this.config.voiceReply !== false && wantsVoiceReply(text)) this.voiceTargets.add(target)
    const sessionKey = isGroup ? `qq-group:${data.group_id}` : `qq-private:${senderId}`
    const senderName = data.sender?.card || data.sender?.nickname || senderId
    await this.bridge.handleInbound(new InboundMessage({
      platform: 'onebot',
      sessionKey,
      senderId,
      senderName,
      text,
      images: parsed.images.length ? parsed.images : undefined,
      contextNote: identityNote(senderId, senderName, this.config.ownerIds || ['2711686331']),
      raw: { target, messageId: data.message_id },
    })).catch(() => {})
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

  /** 发送文本。有表情就改成表情段；这一轮若对方要求语音，再附一条语音。 */
  async send(target, text) {
    const [kind, id] = String(target).split(':')
    if (!id) throw new Error(`无效 target: ${target}`)
    const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg'
    const who = kind === 'group' ? { group_id: Number(id) } : { user_id: Number(id) }
    if (this.voiceTargets.has(target) && !isSystemOutbound(text)) {
      this.voiceTargets.delete(target)
      const spoken = spokenForTts(text)
      if (spoken) {
        try {
          const wav = await synthesizeSpeech(spoken, this.config.ttsScript)
          await this.call(action, { ...who, message: [{ type: 'record', data: { file: wav } }] }, RECORD_TIMEOUT_MS)
        } catch (error) {
          this.ctx?.logger?.warn?.('[dsh-omnibridge:onebot] 语音回复失败: %s', error instanceof Error ? error.message : String(error))
        }
      }
    }
    const segments = toOnebotSegments(text, faces.nameToId)
    await this.call(action, { ...who, message: segments || text })
  }

  async stop() {
    this.closed = true
    this.reconnector.close()
    try { this.ws?.close() } catch {}
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('channel stopped')) }
    this.pending.clear()
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

/**
 * dsh-omnibridge —— 大肥鱼的 QQ 身体。
 *
 * DeepSeek 是贾维斯，NapCat 是身体，QQ 是对话。目标见 JARVIS.md。
 * 别的平台配置还留在文件里，桥接不再启动它们。
 *
 * @module dsh-omnibridge
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from './channels/host-packages.mjs'
import { Bridge } from './bridge-core.mjs'
import { beginScan, pollScan, wecomKfScan } from './channels/scan-registration.mjs'
import { OneBotChannel } from './channels/onebot.mjs'
import { readJsonBody, respondJson } from './channels/http-utils.mjs'
import { alignDshServer, appendBodyLog, armQqBody, ensureQqBody, findNapcatDir, logoutQq, napcatWebCredential, onebotPort, openNapcatWeb, pickNapcatFolder, qqBodyStatus, qrcodePath, readAccounts, readBodyLog, showQqWindow, splitOnebotUrl, switchQqAccount, writeLogin } from './channels/napcat-body.mjs'
import { createReadStream, existsSync as fileExists } from 'node:fs'

const NAMESPACE = 'dsh-omnibridge'
const CONFIG_FILE = join(fileURLToPath(new URL('.', import.meta.url)), 'config.json')
const API_PREFIX = '/dsh-omnibridge'

export const name = 'dsh-omnibridge'
// 网页服务必须写进依赖，路由才能挂上。对话服务不写：它晚就绪时会把整个插件卡住，设置页就一直 404。
export const inject = ['webServer']

const webhookSchema = z.object({
  id: z.string().required(),
  enabled: z.boolean().default(true),
  format: z.union(['auto', 'feishu', 'wecom', 'wecom_ai', 'dingtalk', 'line', 'mp', 'custom']).default('auto'),
  path: z.string().default(''),
  outboundUrl: z.string().default(''),
  // 飞书扫码创建（PersonalAgent）写入的应用凭证，供后续飞书长连接适配器使用
  app_id: z.string().default(''),
  app_secret: z.string().default(''),
})

export const Config = z.object({
  enabled: z.boolean().default(true),
  allowFrom: z.array(z.string()).default([]),
  // 管理员名单（语法同 allowFrom）：/model /gc /sessions /switch 仅限名单成员；空 = 白名单全员即管理员
  admins: z.array(z.string()).default([]),
  // 唤醒前缀（对齐 AstrBot waking）：配置后所有非 '/' 命令消息需以任一前缀开头才触发；[] = 不启用
  wakePrefixes: z.array(z.string()).default([]),
  // 入站图片抓取是否放行私网/本机地址（自托管 NapCat/缓存服务可能给局域网链接，开启=信任平台来源）
  mediaAllowPrivateHosts: z.boolean().default(false),
  agentPreset: z.union(['standard', 'minimal', 'ptc', 'cordis']).default('standard'),
  agentProvider: z.string().default(''),
  agentModel: z.string().default(''),
  cwd: z.string().default(''),
  maxMessageChars: z.number().default(2000),
  rateLimit: z.object({
    // 每个发送方每窗口最大入站条数；0 或省略 = 不限速
    maxPerMinute: z.number().default(0),
    windowMs: z.number().default(60000),
    // 命中限速时不回提示，仅记日志
    silent: z.boolean().default(false),
  }).default({}),
  // 闲置会话路由自动清理分钟数；0 = 不自动清理（仍可 /gc 手动）
  sessionTtlMinutes: z.number().default(0),
  onebot: z.object({
    enabled: z.boolean().default(true),
    url: z.string().default('ws://127.0.0.1:3001?access_token=%20'),
    reconnectDelayMs: z.number().default(5000),
    // 群聊默认要 @、引用她，或喊醒词。false = 群里每句都回
    groupAtOnly: z.boolean().default(true),
    groupWakeWords: z.array(z.string()).default(['大肥鱼']),
    // 这些 QQ 在她的上下文里标成主人，对方看不到
    ownerIds: z.array(z.string()).default(['2711686331']),
    // 私聊默认回一条语音，对方说打字就改回文字。群里仍要明说才念。
    voiceReply: z.boolean().default(true),
    ttsScript: z.string().default(''),
    // 填了安装目录并打开后，DeepSeek 启动时才拉起 NapCat。
    autoStart: z.boolean().default(false),
    napcatDir: z.string().default(''),
    // 留空则用上次登录记住的号。扫码换号时这一次不带号。
    loginUin: z.string().default(''),
  }).default({}),
  telegram: z.object({
    enabled: z.boolean().default(false),
    token: z.string().default(''),
    apiBase: z.string().default(''),
    pollIntervalMs: z.number().default(1000),
    // 群聊默认仅响应 @机器人 / 回复机器人消息（对齐 AstrBot waking check）；false 恢复全量响应
    groupAtOnly: z.boolean().default(true),
  }).default({}),
  webhooks: z.array(webhookSchema).default([]),
  satori: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().default('http://127.0.0.1:5140'),
    token: z.string().default(''),
    reconnectDelayMs: z.number().default(5000),
    // 群聊（有 guild 的会话）默认仅响应 @机器人 / 引用机器人消息；false 恢复全量响应
    groupAtOnly: z.boolean().default(true),
  }).default({}),
  webchat: z.object({
    enabled: z.boolean().default(false),
    path: z.string().default(''),
    // 出站消息保留分钟数，超时自动淘汰（防长跑内存泄漏）
    retentionMinutes: z.number().default(30),
  }).default({}),
  weixin_oc: z.object({
    enabled: z.boolean().default(false),
    baseUrl: z.string().default(''),
    botType: z.string().default(''),
    token: z.string().default(''),
    accountId: z.string().default(''),
    userId: z.string().default(''),
    statePath: z.string().default(''),
  }).default({}),
})

let enabledCache = null
function readFileEnabled(fallback) {
  if (enabledCache !== null) return enabledCache
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
    if (typeof parsed.enabled === 'boolean') {
      enabledCache = parsed.enabled
      return enabledCache
    }
  } catch {}
  enabledCache = fallback
  return enabledCache
}
function writeFileEnabled(enabled) {
  enabledCache = enabled
  mkdirSync(dirname(CONFIG_FILE), { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify({ enabled }, null, 2), 'utf8')
}

/** 只接 QQ。别的平台配置还留在文件里，不再启动。 */
function buildChannels(config) {
  return [new OneBotChannel({
    ...(config.onebot || {}),
    name: 'QQ',
  })]
}

export function apply(ctx, config) {
  let live = config && typeof config === 'object' ? config : {}
  const scope = {
    get() { return (ctx.fiber && ctx.fiber.config) || live },
    async update(patch) {
      const next = { ...this.get(), ...patch }
      live = next
      if (ctx.fiber && typeof ctx.fiber.update === 'function') ctx.fiber.update(next)
    },
    watch() { return () => {} },
  }
  let bridge = null

  // rebuild 串行链：settings 快速连改 / 手动开关会并发触发 startBridge，
  // 若不串行，前一次还在 await old.stop() 时后一次看到 bridge=null 就再建一个，
  // 出现双 Bridge 同时消费入站。所有重建排队依次执行。
  let rebuildChain = Promise.resolve()
  const startBridge = () => {
    rebuildChain = rebuildChain.then(async () => {
      if (bridge) { const old = bridge; bridge = null; await old.stop() }
      const cfg = scope.get()
      if (!readFileEnabled(cfg.enabled)) return
      bridge = new Bridge(ctx, cfg, buildChannels(cfg))
      try {
        await bridge.start()
        if (cfg.onebot?.enabled !== false && cfg.onebot?.autoStart === true && cfg.onebot?.napcatDir) {
          armQqBody(bodyOptions(cfg))
        }
      } catch (error) {
        ctx.logger?.error?.('[dsh-omnibridge] bridge start failed: %s', error instanceof Error ? error.stack : String(error))
      }
    }).catch((error) => {
      ctx.logger?.error?.('[dsh-omnibridge] bridge rebuild failed: %s', error instanceof Error ? error.message : String(error))
    })
    return rebuildChain
  }

  // settings 变更时重建
  scope.watch(() => startBridge())
  startBridge()

  // 桌面版在 apply 时 webServer 已经在 ctx 上。
  ctx.effect(() => {
    return ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/status`,
      handler: async (request, response) => {
        try {
          if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return }
          const channels = bridge ? bridge.channels.map((c) => c.meta()) : []
          const summary = bridge ? bridge.statusSummary() : null
          respondJson(response, 200, {
            enabled: readFileEnabled(scope.get().enabled),
            channels,
            routes: summary ? summary.routes : 0,
            allowFrom: bridge ? bridge.allowFrom() : [],
            summary,
          })
        } catch (error) {
          respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
    })
  }, 'dsh-omnibridge: status route')

    // 开关
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/settings`,
      handler: async (request, response) => {
        try {
          const cfg = scope.get()
          if (request.method === 'GET' || request.method === 'HEAD') {
            respondJson(response, 200, { ...cfg, enabled: readFileEnabled(cfg.enabled) })
            return
          }
          if (request.method === 'POST') {
            const body = await readJsonBody(request)
            if (typeof body.enabled === 'boolean') {
              writeFileEnabled(body.enabled)
            }
            // 配置写回：patch 合并进 settings.yaml user 层（schema 校验失败回 400），
            // 经 scope.watch 触发桥接热重载。enabled 走 config.json 覆盖层，不进 seam。
            if (body.patch && typeof body.patch === 'object' && !Array.isArray(body.patch)) {
              const { enabled: _skip, ...rest } = body.patch
              if (Object.keys(rest).length) {
                try {
                  await scope.update(rest)
                  rememberQqChoice(scope.get())
                } catch (error) {
                  respondJson(response, 400, { error: '配置校验失败：' + (error instanceof Error ? error.message : String(error)) })
                  return
                }
              }
            }
            if (typeof body.enabled === 'boolean') startBridge()
            respondJson(response, 200, { ...scope.get(), enabled: readFileEnabled(scope.get().enabled) })
            return
          }
          response.writeHead(405)
          response.end()
        } catch (error) {
          respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
    }), 'dsh-omnibridge: settings route')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/qq-body`,
      handler: async (request, response) => {
        try {
          const cfg = scope.get()
          if (request.method === 'GET' || request.method === 'HEAD') {
            respondJson(response, 200, await qqView(cfg, bridge))
            return
          }
          if (request.method === 'POST') {
            const body = await readJsonBody(request)
            const action = String(body.action || 'start')
            const dataDir = qqDataDir()
            if (action === 'logout') {
              await logoutQq()
              appendBodyLog(dataDir, '退出登录')
              respondJson(response, 200, await qqView(cfg, bridge))
              return
            }
            if (action === 'show') {
              respondJson(response, 200, await showQqWindow())
              return
            }
            if (action === 'web') {
              const status = await qqBodyStatus(bodyOptions(cfg))
              await openNapcatWeb(status.napcatDir || cfg.onebot?.napcatDir || '')
              appendBodyLog(dataDir, '打开网页')
              respondJson(response, 200, { ok: true })
              return
            }
            if (action === 'reconnect') {
              onebotChannel(bridge)?.reconnectNow?.()
              appendBodyLog(dataDir, '重新连接 DeepSeek')
              respondJson(response, 200, await qqView(cfg, bridge))
              return
            }
            if (action === 'probe') {
              const owner = (cfg.onebot?.ownerIds || []).map((item) => String(item || '').trim()).find((item) => /^\d{5,12}$/.test(item)) || ''
              const channel = onebotChannel(bridge)
              if (!channel) throw new Error('QQ 还没接上')
              await channel.sendProbe(owner)
              appendBodyLog(dataDir, '给主人发了一句测试')
              respondJson(response, 200, { ok: true })
              return
            }
            const configured = String(body.napcatDir || cfg.onebot?.napcatDir || '')
            const options = bodyOptions(cfg, {
              configured,
              uin: body.fresh ? '' : String(body.loginUin || cfg.onebot?.loginUin || ''),
              fresh: !!body.fresh,
            })
            appendBodyLog(dataDir, body.fresh ? '扫码登录' : '用记住的号登录')
            if (action === 'switch') await switchQqAccount(options)
            else await ensureQqBody(options)
            respondJson(response, 200, await qqView(cfg, bridge))
            return
          }
          response.writeHead(405)
          response.end()
        } catch (error) {
          respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
    }), 'dsh-omnibridge: qq body')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/qq-body/qrcode`,
      handler: async (request, response) => {
        try {
          if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return }
          const status = await qqBodyStatus(bodyOptions(scope.get()))
          const file = qrcodePath(status.napcatDir)
          if (!file || !fileExists(file)) { response.writeHead(404); response.end(); return }
          response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
          if (request.method === 'HEAD') { response.end(); return }
          createReadStream(file).pipe(response)
        } catch (error) {
          respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
    }), 'dsh-omnibridge: qq qrcode')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/qq-body/pick`,
      handler: async (request, response) => {
        try {
          if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
          respondJson(response, 200, await pickNapcatFolder())
        } catch (error) {
          respondJson(response, 400, { error: error instanceof Error ? error.message : String(error) })
        }
      }
    }), 'dsh-omnibridge: qq pick')

    // —— 平台扫码接入（飞书/钉钉/QQ 官方，协议见 channels/scan-registration.mjs） ——
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/scan/begin`,
      handler: async (request, response) => {
        try {
          if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
          const body = await readJsonBody(request)
          const r = await beginScan(body.platform)
          if (!r.ok) { respondJson(response, 400, { error: r.error }); return }
          respondJson(response, 200, { platform: body.platform, session: r.session })
        } catch (error) {
          respondJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      }
    }), 'dsh-omnibridge: scan begin')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/scan/poll`,
      handler: async (request, response) => {
        try {
          if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
          const body = await readJsonBody(request)
          const r = await pollScan(body.platform, body.session)
          if (!r.ok) { respondJson(response, 502, { error: r.error }); return }
          respondJson(response, 200, Object.assign({ platform: body.platform }, r.result))
        } catch (error) {
          respondJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      }
    }), 'dsh-omnibridge: scan poll')

    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: `${API_PREFIX}/scan/wecom-kf`,
      handler: async (request, response) => {
        try {
          if (request.method !== 'POST') { response.writeHead(405); response.end(); return }
          const body = await readJsonBody(request)
          const r = await wecomKfScan(body)
          if (!r.ok) { respondJson(response, 400, { error: r.error }); return }
          respondJson(response, 200, { url: r.url, kfName: r.kfName })
        } catch (error) {
          respondJson(response, 502, { error: error instanceof Error ? error.message : String(error) })
        }
      }
    }), 'dsh-omnibridge: scan wecom-kf')
}

function qqDataDir() {
  return join(dirname(CONFIG_FILE), 'data')
}

function bodyOptions(cfg, extra = {}) {
  const onebot = cfg?.onebot || {}
  return {
    dataDir: qqDataDir(),
    configured: onebot.napcatDir || '',
    uin: onebot.loginUin || '',
    port: onebotPort(onebot.url),
    ...extra,
  }
}

function rememberQqChoice(cfg) {
  const onebot = cfg?.onebot
  if (!onebot || typeof onebot !== 'object') return
  const patch = {}
  const resolved = findNapcatDir({ configured: onebot.napcatDir || '' })
  if (resolved) patch.napcatDir = resolved
  if (/^\d{5,12}$/.test(String(onebot.loginUin || ''))) patch.uin = String(onebot.loginUin)
  if (Object.keys(patch).length) {
    try { writeLogin(qqDataDir(), patch) } catch { /* 目录还没建好时，下次登录仍会记 */ }
  }
  if (!resolved) return
  const link = splitOnebotUrl(onebot.url)
  try {
    alignDshServer(resolved, { port: link.port, token: link.token, uin: patch.uin || '' })
  } catch { /* 这个号还没有连接文件时，登录之后再对齐 */ }
}

function onebotChannel(bridge) {
  return bridge?.channels?.find((item) => item.id === 'onebot') || null
}

async function qqView(cfg, bridge) {
  const status = await qqBodyStatus(bodyOptions(cfg))
  const link = splitOnebotUrl(cfg?.onebot?.url)
  const channel = onebotChannel(bridge)
  const web = napcatWebCredential(status.napcatDir || status.runningDir || '')
  return {
    ...status,
    link: channel?.linkState?.() || { connected: false, reconnecting: false, selfId: '', lastHeard: null },
    accounts: readAccounts(qqDataDir()),
    log: readBodyLog(qqDataDir()),
    webPort: web.port,
    webToken: web.token,
    port: link.port,
    tokenSet: !!link.token,
  }
}

export { NAMESPACE, API_PREFIX }

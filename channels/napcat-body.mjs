/**
 * 肥鱼的 QQ 身体：用用户填的 NapCat 目录打开 QQ，记住登录过的号。
 * 可以从开源发布包准备身体（自带 QQ）。不保存密码。快速登录用本机已经记住的号。
 */

import { execFile, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledBodyDir, cancelInstall, findNamedFile, installProgress } from './napcat-install.mjs'

let job = null
let phase = ''
let lastError = ''
let runningCache = { at: 0, dir: '' }
let qqCache = { at: 0, exe: '' }

export function onebotPort(url) {
  try {
    const parsed = new URL(String(url || '').replace(/^ws/i, 'http'))
    const port = Number(parsed.port)
    if (port > 0 && port < 65536) return port
  } catch { /* 地址写坏了就用 NapCat 默认端口 */ }
  return 3001
}

export function loginUinForLaunch({ fresh, typed, remembered } = {}) {
  if (fresh) return ''
  const chosen = String(typed || remembered || '').trim()
  return /^\d{5,12}$/.test(chosen) ? chosen : ''
}

export function napcatLaunchArgs({ qqExe, hookDll, uin }) {
  const args = [qqExe, hookDll]
  if (/^\d{5,12}$/.test(String(uin || ''))) args.push('-q', String(uin))
  return args
}

export function qqExeFromUninstall(uninstallString) {
  const raw = String(uninstallString || '').trim().replace(/^"|"$/g, '')
  if (!raw) return ''
  return join(dirname(raw), 'QQ.exe')
}

export function describeQqBody({ configured, installed, listening, qqRunning, login, qrFresh, phase: current }) {
  if (current === 'starting') return { state: 'starting', label: '正在打开 QQ' }
  if (listening) {
    const who = login?.nick || login?.uin
    return { state: 'ready', label: who ? `已登录 ${who}` : 'QQ 已连上' }
  }
  if (!configured) return { state: 'unconfigured', label: '还没填写安装目录' }
  if (!installed) return { state: 'missing', label: '这个目录里没有 NapCat' }
  if (qrFresh || qqRunning) return { state: 'scan', label: '等待扫码' }
  return { state: 'offline', label: 'QQ 没开' }
}

export function readLogin(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, 'qq-login.json'), 'utf8'))
    return {
      uin: String(parsed.uin || ''),
      nick: String(parsed.nick || ''),
      at: String(parsed.at || ''),
      napcatDir: String(parsed.napcatDir || ''),
    }
  } catch {
    return { uin: '', nick: '', at: '', napcatDir: '' }
  }
}

export function writeLogin(dataDir, patch) {
  mkdirSync(dataDir, { recursive: true })
  const prev = readLogin(dataDir)
  const next = {
    uin: patch.uin != null ? String(patch.uin || '') : prev.uin,
    nick: patch.nick != null ? String(patch.nick || '') : prev.nick,
    at: new Date().toISOString(),
    napcatDir: patch.napcatDir != null ? String(patch.napcatDir || '') : prev.napcatDir,
  }
  writeFileSync(join(dataDir, 'qq-login.json'), JSON.stringify(next, null, 2))
  if (next.uin && next.napcatDir) {
    try { writeFileSync(join(next.napcatDir, 'qq-uin.txt'), `${next.uin}\n`) } catch {}
  }
  if (next.uin) rememberAccount(dataDir, { uin: next.uin, nick: next.nick })
  return next
}

export function readAccounts(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir, 'qq-accounts.json'), 'utf8'))
    return (Array.isArray(parsed) ? parsed : []).filter((item) => /^\d{5,12}$/.test(String(item?.uin || ''))).slice(0, 8)
  } catch {
    return []
  }
}

function rememberAccount(dataDir, { uin, nick }) {
  const list = readAccounts(dataDir).filter((item) => item.uin !== uin)
  list.unshift({ uin, nick: nick || '', at: new Date().toISOString() })
  writeFileSync(join(dataDir, 'qq-accounts.json'), JSON.stringify(list.slice(0, 8), null, 2))
}

export function appendBodyLog(dataDir, text) {
  const clean = String(text || '').replace(/(token|access_token)(["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1$2***').slice(0, 300)
  if (!clean.trim()) return
  try {
    mkdirSync(dataDir, { recursive: true })
    appendFileSync(join(dataDir, 'qq-body.log'), `${new Date().toISOString()} ${clean}\n`)
  } catch {}
}

export function readBodyLog(dataDir, limit = 30) {
  try {
    const lines = readFileSync(join(dataDir, 'qq-body.log'), 'utf8').split(/\r?\n/).filter(Boolean)
    return lines.slice(-limit)
  } catch {
    return []
  }
}

export function splitOnebotUrl(url) {
  const port = onebotPort(url)
  let token = ''
  try {
    const parsed = new URL(String(url || '').replace(/^ws/i, 'http'))
    token = parsed.searchParams.get('access_token') || ''
  } catch { /* 地址写坏了就当没有口令 */ }
  return { port, token: token.trim() }
}

export function alignDshServer(napcatDir, { port, token, uin } = {}) {
  const boot = findBoot(napcatDir)
  if (!boot) return { ok: false }
  const id = String(uin || '').replace(/\D/g, '')
  const named = id ? join(boot.dir, 'config', `onebot11_${id}.json`) : ''
  const file = named && existsSync(named) ? named : join(boot.dir, 'config', 'onebot11.json')
  if (!existsSync(file)) return { ok: false }
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  const network = parsed.network || (parsed.network = {})
  const servers = Array.isArray(network.websocketServers) ? network.websocketServers : (network.websocketServers = [])
  let slot = servers.find((item) => item && item.name === 'dsh') || servers[0]
  if (!slot) {
    slot = { name: 'dsh', enable: true, host: '127.0.0.1', messagePostFormat: 'array', reportSelfMessage: false, enableForcePushEvent: true, debug: false, heartInterval: 30000 }
    servers.push(slot)
  }
  slot.name = 'dsh'
  slot.enable = true
  slot.host = '127.0.0.1'
  slot.port = port || 3001
  if (token) slot.token = token
  writeFileSync(file, JSON.stringify(parsed, null, 2))
  return { ok: true, port: slot.port }
}

export function napcatWebCredential(dir) {
  const boot = findBoot(dir)
  const empty = { port: 6099, token: '' }
  if (!boot) return empty
  try {
    const parsed = JSON.parse(readFileSync(join(boot.dir, 'config', 'webui.json'), 'utf8'))
    const port = Number(parsed.port)
    return {
      port: port > 0 && port < 65536 ? port : 6099,
      token: String(parsed.token || ''),
    }
  } catch {
    return empty
  }
}

export function napcatWebPort(dir) {
  return napcatWebCredential(dir).port
}

export function napcatWebLoginUrl(dir) {
  const { port, token } = napcatWebCredential(dir)
  const base = `http://127.0.0.1:${port}/webui/web_login`
  return token ? `${base}?token=${encodeURIComponent(token)}` : base
}

export async function logoutQq() {
  await execText('taskkill', ['/F', '/IM', 'NapCatWinBootMain.exe']).catch(() => {})
  await execText('taskkill', ['/F', '/IM', 'QQ.exe']).catch(() => {})
  runningCache = { at: 0, dir: '' }
  phase = ''
  lastError = ''
}

/** DeepSeek 退出时同步关掉身体，不等待。 */
export function logoutQqSync() {
  try { spawnSync('taskkill', ['/F', '/IM', 'NapCatWinBootMain.exe'], { windowsHide: true, timeout: 5000 }) } catch {}
  try { spawnSync('taskkill', ['/F', '/IM', 'QQ.exe'], { windowsHide: true, timeout: 5000 }) } catch {}
  runningCache = { at: 0, dir: '' }
  phase = ''
  lastError = ''
}

/** 身体只跟 DeepSeek 走，不再自己开机、自己守着。 */
export async function releaseIndependentBody() {
  await execText('schtasks', ['/End', '/TN', 'Dafeiyu NapCat']).catch(() => {})
  await execText('schtasks', ['/Delete', '/TN', 'Dafeiyu NapCat', '/F']).catch(() => {})
  const startup = join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Dafeiyu NapCat.vbs')
  try { if (startup && existsSync(startup)) unlinkSync(startup) } catch {}
  const script = "Get-CimInstance Win32_Process -Filter \"Name='powershell.exe'\" | Where-Object { $_.CommandLine -match 'keep-alive\\.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"
  await execText('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', script], 15000).catch(() => {})
}

export async function switchQqAccount(options) {
  await logoutQq()
  for (let i = 0; i < 12; i += 1) {
    const qq = await processRunning('QQ.exe')
    const boot = await processRunning('NapCatWinBootMain.exe')
    if (!qq && !boot) break
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  return ensureQqBody(options)
}

export async function showQqWindow() {
  const script = [
    "$p = Get-Process -Name QQ -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1",
    "if (-not $p) { 'NOWINDOW'; exit 0 }",
    "if (-not ('Dsh.DshWinApi' -as [type])) { Add-Type -Name DshWinApi -Namespace Dsh -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);' }",
    "[Dsh.DshWinApi]::ShowWindow($p.MainWindowHandle, 9) | Out-Null",
    "[Dsh.DshWinApi]::SetForegroundWindow($p.MainWindowHandle) | Out-Null",
    "'OK'",
  ].join('; ')
  try {
    const text = await execText('powershell', ['-NoProfile', '-Command', script], 15000)
    if (text.includes('NOWINDOW')) return { ok: false, error: '没有找到 QQ 窗口。先登录，窗口出来后再点。' }
    return { ok: true }
  } catch {
    return { ok: false, error: '没有把 QQ 窗口调到前面。' }
  }
}

export async function openNapcatWeb(dir) {
  const url = napcatWebLoginUrl(dir).replace(/'/g, "''")
  await execText('powershell', ['-NoProfile', '-Command', `Start-Process '${url}'`])
  return { ok: true }
}

export function findNapcatDir({ configured, extra } = {}) {
  const candidates = [configured, extra]
  for (const dir of candidates) {
    const found = findBoot(dir)
    if (found) return found.dir
  }
  return ''
}

export function findBoot(dir) {
  const root = String(dir || '').trim()
  if (!root || !existsSync(root)) return null
  return walkBoot(root, 3)
}

function walkBoot(dir, depth) {
  const direct = join(dir, 'NapCatWinBootMain.exe')
  if (existsSync(direct)) return { dir, exe: direct, hook: join(dir, 'NapCatWinBootHook.dll') }
  if (depth <= 0) return null
  let entries = []
  try { entries = readdirSync(dir) } catch { return null }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const nested = walkBoot(join(dir, name), depth - 1)
    if (nested) return nested
  }
  return null
}

export async function runningNapcatDir() {
  if (Date.now() - runningCache.at < 5000) return runningCache.dir
  let dir = ''
  try {
    const text = await execText('powershell', [
      '-NoProfile',
      '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='NapCatWinBootMain.exe'\" -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty ExecutablePath)",
    ])
    const exe = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || ''
    if (exe && existsSync(exe)) dir = dirname(exe)
  } catch { dir = '' }
  runningCache = { at: Date.now(), dir }
  return dir
}

export async function pickNapcatFolder() {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = 'NapCat'",
    '$answer = $dialog.ShowDialog()',
    "if ($answer -eq 'OK') { Write-Output $dialog.SelectedPath }",
  ].join('; ')
  let selected = ''
  try {
    const text = await execText('powershell', ['-NoProfile', '-STA', '-Command', script], 180000)
    selected = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).pop() || ''
  } catch {
    return { dir: '', error: '没有打开文件夹窗口' }
  }
  if (!selected) return { dir: '', canceled: true }
  const boot = findBoot(selected)
  if (!boot) return { dir: '', error: '这个文件夹里没有 NapCat。选安装目录，或者它的上一级。' }
  return { dir: boot.dir }
}

export async function qqBodyStatus({ dataDir, configured, port } = {}) {
  const configuredText = String(configured || '').trim()
  const bundled = dataDir ? bundledBodyDir(dataDir) : ''
  const savedDir = findNapcatDir({ configured: configuredText, extra: bundled })
  const runningDir = await runningNapcatDir()
  const dir = savedDir || runningDir
  const login = dataDir ? readLogin(dataDir) : { uin: '', nick: '', napcatDir: '' }
  const rememberedBoot = findBoot(login.napcatDir)
  const listening = await portOpen(port || 3001)
  const qqRunning = await processRunning('QQ.exe')
  const qqExe = await cachedQQExe(dir)
  const qr = dir ? qrInfo(dir) : { fresh: false, at: 0 }
  let install = installProgress()
  if (savedDir && install.busy) {
    cancelInstall()
    install = installProgress()
  }
  const view = describeQqBody({
    configured: !!configuredText || !!runningDir || !!savedDir,
    installed: !!savedDir || !!runningDir,
    listening,
    qqRunning,
    login,
    qrFresh: qr.fresh,
    phase,
  })
  let label = view.label
  if (install.phase === 'checking') label = '正在查找身体版本'
  else if (install.phase === 'downloading') label = install.percent ? `正在下载身体 ${install.percent}%` : '正在连接下载'
  else if (install.phase === 'unpacking') label = '正在解开身体'
  return {
    ...view,
    label,
    installed: !!savedDir || !!runningDir,
    listening,
    qqRunning,
    qqReady: !!qqExe,
    uin: login.uin || '',
    nick: login.nick || '',
    qr: view.state === 'scan' && qr.fresh,
    qrAt: qr.at || 0,
    error: lastError || install.error,
    napcatDir: dir,
    savedDir,
    runningDir,
    rememberedDir: rememberedBoot ? rememberedBoot.dir : '',
    configured: configuredText,
    install,
  }
}

export function qrcodePath(dir) {
  const boot = findBoot(dir)
  if (!boot) return ''
  const file = join(boot.dir, 'cache', 'qrcode.png')
  return existsSync(file) ? file : ''
}

export function armQqBody(options) {
  if (!String(options?.configured || '').trim()) return Promise.resolve(null)
  const run = ensureQqBody(options).catch((error) => {
    lastError = error instanceof Error ? error.message : String(error)
    phase = ''
  })
  return run
}

export function ensureQqBody(options) {
  if (job) return job
  job = runEnsure(options).finally(() => { job = null })
  return job
}

async function runEnsure({ dataDir, configured, uin, fresh, port }) {
  lastError = ''
  const listenPort = port || 3001
  const statusOptions = { dataDir, configured, port: listenPort }
  const listening = await portOpen(listenPort)
  const qqRunning = await processRunning('QQ.exe')
  if (fresh && (listening || qqRunning)) {
    phase = ''
    lastError = 'QQ 还开着。先关掉 QQ 窗口，再点扫码登录。这一页不会替你关 QQ，免得把你自己的号也退出。'
    return qqBodyStatus(statusOptions)
  }
  if (listening) {
    phase = ''
    const dir = findNapcatDir({ configured }) || await runningNapcatDir()
    if (dataDir && dir) writeLogin(dataDir, { napcatDir: dir })
    return qqBodyStatus(statusOptions)
  }
  if (qqRunning) {
    phase = ''
    const status = await qqBodyStatus(statusOptions)
    if (!status.qr) lastError = 'QQ 已经开着，但还没连上。窗口里有二维码就用手机扫；那是你自己的 QQ 的话，先关掉再点登录。'
    return { ...status, error: lastError }
  }
  const dir = findNapcatDir({ configured })
  if (!String(configured || '').trim()) {
    phase = ''
    lastError = ''
    return qqBodyStatus(statusOptions)
  }
  if (!dir) {
    phase = ''
    lastError = '这个文件夹里没有 NapCat。选安装目录，或者它的上一级。'
    return qqBodyStatus(statusOptions)
  }
  const remembered = dataDir ? readLogin(dataDir).uin : ''
  phase = 'starting'
  await launchNapcat(dir, loginUinForLaunch({ fresh, typed: uin, remembered }))
  if (dataDir) writeLogin(dataDir, { napcatDir: dir, ...(uin && !fresh ? { uin } : {}) })
  phase = ''
  return qqBodyStatus(statusOptions)
}

export async function launchNapcat(napcatDir, uin) {
  const boot = findBoot(napcatDir)
  if (!boot) throw new Error('NapCat 没装好')
  const qqExe = await findQQExe(boot.dir)
  if (!qqExe || !existsSync(qqExe)) throw new Error('身体包里还没有 QQ，点「准备身体」再试。')
  await placeLoader(qqExe, boot.dir)
  const args = napcatLaunchArgs({ qqExe, hookDll: boot.hook, uin })
  const child = spawn(boot.exe, args, {
    cwd: boot.dir,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: {
      ...process.env,
      NAPCAT_PATCH_PACKAGE: join(boot.dir, 'qqnt.json'),
      NAPCAT_LOAD_PATH: join(boot.dir, 'loadNapCat.js'),
      NAPCAT_INJECT_PATH: boot.hook,
      NAPCAT_MAIN_PATH: join(boot.dir, 'napcat.mjs'),
    },
  })
  child.unref()
  hideBootConsole(boot.dir)
}

function hideBootConsole(napcatDir) {
  const here = dirname(fileURLToPath(import.meta.url))
  const script = [join(napcatDir, 'hide-console.vbs'), join(here, 'hide-console.vbs')].find((file) => existsSync(file))
  if (!script) return
  const child = spawn('wscript.exe', ['//B', '//nologo', script], {
    cwd: existsSync(join(napcatDir, 'hide-console.ps1')) ? napcatDir : here,
    windowsHide: true,
    stdio: 'ignore',
    detached: true,
  })
  child.unref()
}

async function placeLoader(qqExe, napcatDir) {
  const qqRoot = dirname(qqExe)
  let version = ''
  try {
    const cfg = JSON.parse(readFileSync(join(qqRoot, 'versions', 'config.json'), 'utf8'))
    version = String(cfg.curVersion || '')
  } catch { return }
  if (!version) return
  const src = join(napcatDir, 'loadNapCat.js')
  const dest = join(qqRoot, 'versions', version, 'resources', 'app', 'loadNapCat.js')
  if (!existsSync(src) || !existsSync(dirname(dest))) return
  writeFileSync(dest, readFileSync(src))
}

async function cachedQQExe(napcatDir) {
  const bundled = findQqNear(napcatDir)
  if (bundled) return bundled
  if (Date.now() - qqCache.at < 60000 && qqCache.exe) return qqCache.exe
  const exe = await findQQExe(napcatDir)
  qqCache = { at: Date.now(), exe: exe || '' }
  return qqCache.exe
}

async function findQQExe(napcatDir) {
  const bundled = findQqNear(napcatDir)
  if (bundled) return bundled
  try {
    const text = await execText('reg', ['query', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ', '/v', 'UninstallString'])
    const line = text.split(/\r?\n/).find((item) => /UninstallString/i.test(item)) || ''
    const value = line.replace(/^.*UninstallString\s+REG_\w+\s+/i, '').trim()
    const exe = qqExeFromUninstall(value)
    return exe && existsSync(exe) ? exe : ''
  } catch {
    return ''
  }
}

function findQqNear(napcatDir) {
  let current = String(napcatDir || '').trim()
  for (let i = 0; i < 3 && current; i += 1) {
    const hit = findNamedFile(current, 'QQ.exe', 4)
    if (hit) return hit
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return ''
}

function qrInfo(dir) {
  const file = qrcodePath(dir)
  if (!file) return { fresh: false, at: 0 }
  try {
    const at = statSync(file).mtimeMs
    return { fresh: Date.now() - at < 3 * 60 * 1000, at }
  } catch {
    return { fresh: false, at: 0 }
  }
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (open) => { try { socket.destroy() } catch {} ; resolve(open) }
    socket.setTimeout(800)
    socket.on('connect', () => done(true))
    socket.on('timeout', () => done(false))
    socket.on('error', () => done(false))
  })
}

function processRunning(image) {
  return execText('tasklist', ['/FI', `IMAGENAME eq ${image}`, '/NH']).then((text) => text.toLowerCase().includes(image.toLowerCase())).catch(() => false)
}

function execText(file, args, timeout = 8000) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout }, (error, stdout) => {
      if (error) reject(error)
      else resolve(String(stdout || ''))
    })
  })
}

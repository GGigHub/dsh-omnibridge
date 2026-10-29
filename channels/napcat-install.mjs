/**
 * 从 NapCat 开源发布包准备身体。优先 Windows.Node（自带 QQ），不用先装官方 QQ。
 */

import { execFile } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { get } from 'node:https'
import { join } from 'node:path'

const RELEASE_API = 'https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest'
const FALLBACK = {
  tag: 'v4.18.41',
  name: 'NapCat.Shell.Windows.Node.zip',
  url: 'https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/NapCat.Shell.Windows.Node.zip',
}

let job = null
let phase = ''
let errorText = ''
let received = 0
let total = 0
let tag = ''
let aborted = false
let activeReq = null
let forced = false

export function bundledBodyDir(dataDir) {
  return join(String(dataDir || ''), 'napcat-body')
}

export function pickWindowsBodyAsset(release) {
  const assets = Array.isArray(release?.assets) ? release.assets : []
  const node = assets.find((item) => /NapCat\.Shell\.Windows\.Node\.zip$/i.test(item?.name || ''))
  if (node?.browser_download_url) {
    return { name: node.name, url: node.browser_download_url, tag: String(release.tag_name || '') }
  }
  return null
}

export function downloadMirrors(url) {
  const raw = String(url || '')
  if (!raw) return []
  return [
    raw,
    `https://ghfast.top/${raw}`,
    `https://gitproxy.click/${raw}`,
  ]
}

export function resolveExistingBody(configured, dataDir) {
  return findBoot(configured) || findBoot(bundledBodyDir(dataDir))
}

export function installProgress() {
  const percent = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0
  const downloading = phase === 'downloading'
  return {
    phase,
    error: errorText,
    percent: downloading ? percent : (phase === 'unpacking' ? 99 : (phase === 'ready' ? 100 : 0)),
    tag,
    busy: !!job && (phase === 'checking' || downloading || phase === 'unpacking'),
    needed: phase === 'checking' || downloading || phase === 'unpacking',
  }
}

export function cancelInstall(reason = '') {
  aborted = true
  forced = false
  try { activeReq?.destroy() } catch {}
  activeReq = null
  if (phase === 'checking' || phase === 'downloading' || phase === 'unpacking') {
    phase = ''
    errorText = reason
    received = 0
    total = 0
  }
}

export function armInstall(dataDir, { configured, force } = {}) {
  const existing = resolveExistingBody(configured, dataDir)
  if (existing && !force) {
    cancelInstall()
    phase = ''
    errorText = ''
    return Promise.resolve({ dir: existing.dir, skipped: true })
  }
  if (job) return job
  aborted = false
  forced = !!force
  job = runInstall(dataDir).finally(() => { job = null; forced = false })
  return job
}

export async function runInstall(dataDir) {
  errorText = ''
  const dest = bundledBodyDir(dataDir)
  const existing = findBoot(dest)
  if (existing && !forced) {
    phase = ''
    tag = tag || 'local'
    return { dir: existing.dir, skipped: true }
  }
  mkdirSync(join(dataDir, 'cache'), { recursive: true })
  mkdirSync(dest, { recursive: true })
  phase = 'checking'
  received = 0
  total = 0
  const asset = await latestAsset().catch(() => FALLBACK)
  if (aborted) throw new Error('已取消')
  tag = asset.tag || FALLBACK.tag
  const zip = join(dataDir, 'cache', asset.name || FALLBACK.name)
  phase = 'downloading'
  await downloadFirst(downloadMirrors(asset.url || FALLBACK.url), zip)
  if (aborted) throw new Error('已取消')
  phase = 'unpacking'
  emptyDir(dest)
  await unpackZip(zip, dest)
  const boot = findBoot(dest)
  if (!boot) {
    phase = ''
    errorText = '下载完成了，但这个包里没有 NapCat。换个网络再试一次。'
    throw new Error(errorText)
  }
  phase = ''
  return { dir: boot.dir }
}

async function latestAsset() {
  const release = JSON.parse(await getBuffer(RELEASE_API))
  const asset = pickWindowsBodyAsset(release)
  if (!asset) throw new Error('没找到 Windows 身体包')
  return asset
}

function downloadFirst(urls, dest) {
  let last = new Error('没有可用的下载地址')
  const tryOne = (index) => {
    if (index >= urls.length) return Promise.reject(last)
    return downloadFile(urls[index], dest).catch((error) => {
      last = error instanceof Error ? error : new Error(String(error))
      return tryOne(index + 1)
    })
  }
  return tryOne(0)
}

function downloadFile(url, dest) {
  received = 0
  total = 0
  return new Promise((resolve, reject) => {
    const follow = (current, hops) => {
      if (hops > 5) { reject(new Error('下载跳转太多')); return }
      const req = get(current, {
        headers: { 'User-Agent': 'dsh-omnibridge', Accept: 'application/octet-stream' },
      }, (res) => {
        if (aborted) { res.resume(); reject(new Error('已取消')); return }
        const next = res.headers.location
        if (res.statusCode >= 300 && res.statusCode < 400 && next) {
          res.resume()
          follow(new URL(next, current).href, hops + 1)
          return
        }
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`下载失败 ${res.statusCode}`))
          return
        }
        total = Number(res.headers['content-length']) || 0
        const file = createWriteStream(dest)
        res.on('data', (chunk) => { received += chunk.length })
        res.pipe(file)
        file.on('finish', () => file.close(() => resolve(dest)))
        file.on('error', reject)
      })
      activeReq = req
      req.on('error', reject)
      req.setTimeout(120000, () => { req.destroy(new Error('下载超时')) })
    }
    follow(url, 0)
  })
}

function getBuffer(url) {
  return new Promise((resolve, reject) => {
    const req = get(url, { headers: { 'User-Agent': 'dsh-omnibridge', Accept: 'application/json' } }, (res) => {
      if (aborted) { res.resume(); reject(new Error('已取消')); return }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`查询版本失败 ${res.statusCode}`)); return }
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    activeReq = req
    req.on('error', reject)
    req.setTimeout(15000, () => { req.destroy(new Error('查询版本超时')) })
  })
}

function unpackZip(zip, dest) {
  return new Promise((resolve, reject) => {
    execFile('tar', ['-xf', zip, '-C', dest], { windowsHide: true }, (error) => {
      if (!error) { resolve(); return }
      execFile('powershell.exe', [
        '-NoProfile', '-WindowStyle', 'Hidden', '-Command',
        `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
      ], { windowsHide: true }, (inner) => {
        if (inner) reject(inner)
        else resolve()
      })
    })
  })
}

function emptyDir(dir) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    rmSync(join(dir, name), { recursive: true, force: true })
  }
}

export function findNamedFile(root, fileName, depth = 4) {
  const dir = String(root || '').trim()
  if (!dir || !existsSync(dir) || depth < 0) return ''
  const direct = join(dir, fileName)
  try { if (statSync(direct).isFile()) return direct } catch {}
  let entries = []
  try { entries = readdirSync(dir) } catch { return '' }
  for (const name of entries) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const nested = findNamedFile(join(dir, name), fileName, depth - 1)
    if (nested) return nested
  }
  return ''
}

function findBoot(dir) {
  const root = String(dir || '').trim()
  if (!root || !existsSync(root)) return null
  const walk = (current, depth) => {
    const exe = join(current, 'NapCatWinBootMain.exe')
    if (existsSync(exe)) return { dir: current, exe, hook: join(current, 'NapCatWinBootHook.dll') }
    if (depth <= 0) return null
    let entries = []
    try { entries = readdirSync(current) } catch { return null }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      const nested = walk(join(current, name), depth - 1)
      if (nested) return nested
    }
    return null
  }
  return walk(root, 3)
}

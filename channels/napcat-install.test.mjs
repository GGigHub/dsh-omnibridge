import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { armInstall, bundledBodyDir, downloadMirrors, findNamedFile, pickWindowsBodyAsset, resolveExistingBody } from './napcat-install.mjs'

test('优先选带 QQ 的 Windows.Node 包', () => {
  const asset = pickWindowsBodyAsset({
    tag_name: 'v4.18.41',
    assets: [
      { name: 'NapCat.Shell.zip', browser_download_url: 'https://example.com/shell.zip' },
      { name: 'NapCat.Shell.Windows.Node.zip', browser_download_url: 'https://example.com/node.zip' },
      { name: 'NapCat.Shell.Windows.OneKey.zip', browser_download_url: 'https://example.com/onekey.zip' },
    ],
  })
  assert.equal(asset.name, 'NapCat.Shell.Windows.Node.zip')
  assert.equal(asset.tag, 'v4.18.41')
})

test('没有 Node 包就不要误用 Shell 包', () => {
  assert.equal(pickWindowsBodyAsset({ assets: [{ name: 'NapCat.Shell.zip', browser_download_url: 'https://example.com/s.zip' }] }), null)
})

test('下载会带上镜像地址', () => {
  const urls = downloadMirrors('https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/NapCat.Shell.Windows.Node.zip')
  assert.equal(urls[0].startsWith('https://github.com/'), true)
  assert.equal(urls.some((item) => item.includes('ghfast.top')), true)
})

test('身体目录落在插件数据里', () => {
  assert.equal(bundledBodyDir('D:\\data'), 'D:\\data\\napcat-body')
})

test('已经有 NapCat 时不要再下', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-have-'))
  writeFileSync(join(dir, 'NapCatWinBootMain.exe'), '')
  const data = mkdtempSync(join(tmpdir(), 'napcat-data-'))
  const found = resolveExistingBody(dir, data)
  assert.equal(found.dir, dir)
  const result = await armInstall(data, { configured: dir })
  assert.equal(result.skipped, true)
  assert.equal(result.dir, dir)
})

test('能在子目录里找到 QQ.exe', () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-qq-'))
  const nested = join(dir, 'QQ', 'versions')
  mkdirSync(nested, { recursive: true })
  writeFileSync(join(dir, 'QQ', 'QQ.exe'), '')
  assert.equal(findNamedFile(dir, 'QQ.exe', 4), join(dir, 'QQ', 'QQ.exe'))
})

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendBodyLog,
  describeQqBody,
  findNapcatDir,
  loginUinForLaunch,
  napcatLaunchArgs,
  napcatWebLoginUrl,
  onebotPort,
  qqExeFromUninstall,
  readBodyLog,
  readLogin,
  splitOnebotUrl,
  writeLogin,
} from './napcat-body.mjs'

test('没填写目录时不会自己猜安装位置', () => {
  assert.equal(findNapcatDir({ configured: '' }), '')
  assert.equal(findNapcatDir({ configured: 'D:\\不存在的目录' }), '')
})

test('口令不会出现在拆出来的空口令里，记录里也会打码', () => {
  assert.deepEqual(splitOnebotUrl('ws://127.0.0.1:3001?access_token=%20'), { port: 3001, token: '' })
  const dir = mkdtempSync(join(tmpdir(), 'qq-log-'))
  appendBodyLog(dir, 'access_token=secret-value 连接上了')
  const lines = readBodyLog(dir)
  assert.equal(lines.length, 1)
  assert.doesNotMatch(lines[0], /secret-value/)
  assert.match(lines[0], /连接上了/)
})

test('登录号：填了就用填的，扫码换号这次不带号', () => {
  assert.equal(loginUinForLaunch({ typed: '2763999309', remembered: '1' }), '2763999309')
  assert.equal(loginUinForLaunch({ remembered: '2763999309' }), '2763999309')
  assert.equal(loginUinForLaunch({ fresh: true, typed: '2763999309', remembered: '2763999309' }), '')
  assert.equal(loginUinForLaunch({ typed: 'abc' }), '')
  assert.equal(onebotPort('ws://127.0.0.1:3001?access_token=%20'), 3001)
  assert.equal(onebotPort(''), 3001)
})

test('网页登录地址带上口令', () => {
  const dir = mkdtempSync(join(tmpdir(), 'napcat-web-'))
  mkdirSync(join(dir, 'config'))
  writeFileSync(join(dir, 'NapCatWinBootMain.exe'), '')
  writeFileSync(join(dir, 'config', 'webui.json'), JSON.stringify({ port: 6099, token: 'desk-token' }))
  assert.equal(napcatWebLoginUrl(dir), 'http://127.0.0.1:6099/webui/web_login?token=desk-token')
})

test('记住的号会写成快速登录参数', () => {
  assert.deepEqual(napcatLaunchArgs({ qqExe: 'QQ.exe', hookDll: 'hook.dll', uin: '2763999309' }).slice(2), ['-q', '2763999309'])
  assert.equal(napcatLaunchArgs({ qqExe: 'QQ.exe', hookDll: 'hook.dll', uin: '' }).length, 2)
  assert.equal(qqExeFromUninstall('"D:\\program files\\Tencent\\QQNT\\Uninstall.exe"'), 'D:\\program files\\Tencent\\QQNT\\QQ.exe')
})

test('登录记录落在插件数据里，下次还能读到这个号', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-login-'))
  const saved = writeLogin(dir, { uin: '2763999309', nick: '酒穷肠', napcatDir: '' })
  assert.equal(saved.uin, '2763999309')
  assert.equal(readLogin(dir).nick, '酒穷肠')
  writeLogin(dir, { uin: '2763999309' })
  assert.equal(readLogin(dir).nick, '酒穷肠')
  assert.match(readFileSync(join(dir, 'qq-login.json'), 'utf8'), /2763999309/)
})

test('状态按有没有填写目录、安装和扫码分开说', () => {
  assert.equal(describeQqBody({ configured: false }).state, 'unconfigured')
  assert.equal(describeQqBody({ configured: true, installed: false }).state, 'missing')
  assert.equal(describeQqBody({ configured: true, installed: true, listening: true, login: { nick: '酒穷肠' } }).label, '已登录 酒穷肠')
  assert.equal(describeQqBody({ configured: true, installed: true, qrFresh: true }).state, 'scan')
  assert.equal(describeQqBody({ configured: true, installed: true, phase: 'starting' }).state, 'starting')
  assert.equal(describeQqBody({ configured: true, installed: true }).state, 'offline')
})

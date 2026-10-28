import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  applyProfileEdit,
  ingestTurn,
  memoryFileName,
  retrieveMemory,
  renderMemoryNote,
  splitMemoryUpdate,
} from './qq-memory.mjs'

test('私聊和群聊的记事目录分开', () => {
  assert.equal(memoryFileName('qq-private:2711686331'), 'qq-private_2711686331')
  assert.notEqual(memoryFileName('qq-private:1'), memoryFileName('qq-group:1'))
})

test('记事标签不会发给对方，点名的事写进档案', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-memory-'))
  const key = 'qq-private:2711686331'
  const { visible, edit } = splitMemoryUpdate('记住了。\n<memory>{"add":["主人下周要交方案"],"forget":[]}</memory>')
  assert.equal(visible, '记住了。')
  const profile = applyProfileEdit(dir, key, edit)
  assert.equal(profile.facts[0].text, '主人下周要交方案')
  const forgotten = applyProfileEdit(dir, key, { add: [], forget: ['交方案'] })
  assert.equal(forgotten.facts.length, 0)
})

test('原文一直追加，碎片收成篇章后旧句还在', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-memory-'))
  const key = 'qq-private:2711686331'
  const at = new Date('2026-10-28T16:00:00')
  for (let i = 0; i < 12; i++) {
    ingestTurn(dir, key, { role: 'user', text: i === 0 ? '我下周要交方案' : `第${i}句闲聊`, at })
  }
  const peer = join(dir, memoryFileName(key))
  const raw = readFileSync(join(peer, 'raw.jsonl'), 'utf8').trim().split('\n')
  assert.equal(raw.length, 12)
  assert.match(raw[0], /我下周要交方案/)
  const episodes = readFileSync(join(peer, 'episodes.jsonl'), 'utf8')
  assert.match(episodes, /我下周要交方案/)
  const again = ingestTurn(dir, key, { role: 'user', text: '又来一句', at })
  assert.equal(again.day, '2026-10-28')
  assert.ok(statSync(join(peer, 'raw.jsonl')).size > 200)
  const packet = retrieveMemory(dir, key, '下周方案')
  const note = renderMemoryNote(packet)
  assert.match(note, /交方案/)
  assert.match(note, /不会清/)
})

test('同一句话反复出现会升进档案', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qq-memory-'))
  const key = 'qq-private:2711686331'
  for (let i = 0; i < 3; i++) ingestTurn(dir, key, { role: 'user', text: '主人喜欢夜里聊天' })
  const packet = retrieveMemory(dir, key, '夜里')
  assert.ok(packet.facts.some((fact) => fact.text.includes('夜里聊天')))
})

test('坏掉的记事标签不会发给对方', () => {
  const { visible, edit } = splitMemoryUpdate('在的<memory>不是json</memory>')
  assert.equal(visible, '在的')
  assert.equal(edit, null)
})

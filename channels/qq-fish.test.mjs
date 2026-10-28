import assert from 'node:assert/strict'
import test from 'node:test'
import {
  identityNote,
  isSendableImage,
  isSystemOutbound,
  loadFaceMap,
  parseOnebotMessage,
  shouldAnswerGroup,
  splitOutbound,
  spokenForTts,
  toOnebotSegments,
  wantsVoiceReply,
} from './qq-fish.mjs'

const { nameToId, idToName } = loadFaceMap()

test('旺柴能对上真表情，反查也是旺柴', () => {
  assert.equal(nameToId.get('旺柴'), '277')
  assert.equal(idToName.get('277'), '旺柴')
})

test('出站把脸变成表情段，不认识的方括号留着', () => {
  const segs = toOnebotSegments('在呢[旺柴]看这个[不是脸]', nameToId)
  assert.deepEqual(segs, [
    { type: 'text', data: { text: '在呢' } },
    { type: 'face', data: { id: '277' } },
    { type: 'text', data: { text: '看这个[不是脸]' } },
  ])
  assert.equal(toOnebotSegments('没有脸', nameToId), null)
})

test('入站表情段变成她能看懂的名字', () => {
  const parsed = parseOnebotMessage({
    message: [
      { type: 'face', data: { id: '277' } },
      { type: 'text', data: { text: '在吗' } },
    ],
  }, { selfId: '2763999309', idToName })
  assert.equal(parsed.text, '[旺柴]在吗')
  assert.equal(parsed.atMe, false)
})

test('群里喊大肥鱼能叫醒，闲聊不行；@ 和引用她也行', () => {
  const base = { groupAtOnly: true, selfReady: true, wakeWords: ['大肥鱼'] }
  assert.equal(shouldAnswerGroup({ ...base, text: '大肥鱼在吗' }), true)
  assert.equal(shouldAnswerGroup({ ...base, text: '今天天气不错' }), false)
  assert.equal(shouldAnswerGroup({ ...base, text: '你好', atMe: true }), true)
  assert.equal(shouldAnswerGroup({ ...base, text: '看看', replyToMe: true }), true)
  assert.equal(shouldAnswerGroup({ ...base, groupAtOnly: false, text: '随便说' }), true)
})

test('主人号和别人的身份标记不一样', () => {
  assert.match(identityNote('2711686331', '君梦实境', ['2711686331']), /是主人/)
  assert.match(identityNote('10000', '路人', ['2711686331']), /是朋友/)
  assert.match(identityNote('10000', '路人', ['2711686331']), /不要复述/)
})

test('只有明说用语音回才念出来，系统提示不念', () => {
  assert.equal(wantsVoiceReply('用语音回我'), true)
  assert.equal(wantsVoiceReply('在吗'), false)
  assert.equal(isSystemOutbound('⏳ 收到，开始处理…'), true)
  assert.equal(isSystemOutbound('在的[旺柴]'), false)
  assert.equal(spokenForTts('在的[旺柴]呀'), '在的呀')
})

test('发图和说说的标记不会留在聊天文字里', () => {
  const split = splitOutbound('给你看\n<image>https://example.com/a.png</image>\n<qzone>今天的云</qzone>')
  assert.equal(split.visible, '给你看')
  assert.deepEqual(split.images, ['https://example.com/a.png'])
  assert.equal(split.qzone, '今天的云')
  assert.equal(isSendableImage('https://example.com/a.png'), true)
  assert.equal(isSendableImage('不是图'), false)
})

test('数组消息里的语音和引用号能拆出来', () => {
  const parsed = parseOnebotMessage({
    message: [
      { type: 'reply', data: { id: '99' } },
      { type: 'at', data: { qq: '2763999309' } },
      { type: 'record', data: { file: 'abc.amr', url: 'https://127.0.0.1/a.amr' } },
      { type: 'text', data: { text: '听一下' } },
    ],
  }, { selfId: '2763999309', idToName })
  assert.equal(parsed.atMe, true)
  assert.equal(parsed.replyId, '99')
  assert.equal(parsed.voice.file, 'abc.amr')
  assert.equal(parsed.text, '听一下')
})

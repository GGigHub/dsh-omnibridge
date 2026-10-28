import assert from 'node:assert/strict'
import test from 'node:test'
import { formatBalance, formatSessionStatus, hitRateText } from './usage-report.mjs'

test('命中率用缓存命中除以命中加未缓存输入', () => {
  assert.equal(hitRateText(8192, 768), '91.4%')
  assert.equal(hitRateText(0, 0), '还没有')
})

test('会话状态写出上下文、token 和命中率', () => {
  const text = formatSessionStatus({
    sessionId: 'onebot-1',
    model: 'deepseek-account/deepseek-flash',
    effort: '高',
    usage: {
      totals: { uncachedInputTokens: 768, outputTokens: 68, cacheReadTokens: 8192, cacheWriteTokens: 0 },
      last: { buckets: { uncachedInputTokens: 768, outputTokens: 68, cacheReadTokens: 8192, cacheWriteTokens: 0 } },
    },
    pressure: { contextWindow: 1048576, pressureTokens: 8960, surfaceTokens: 1702 },
    breakdown: { breakdown: { systemTokens: 1311, toolsTokens: 3941, messageTokens: 391 } },
    stats: { turns: 1, steps: 1 },
  })
  assert.match(text, /当前会话：onebot-1/)
  assert.match(text, /思考：高/)
  assert.match(text, /8,960 \/ 1,048,576（0\.85%）/)
  assert.match(text, /系统 1,311，工具 3,941，对话 391/)
  assert.match(text, /累计命中率：91\.4%/)
  assert.match(text, /上一轮：输入 768/)
})

test('余额分充值和赠送', () => {
  assert.equal(formatBalance(null), '账户余额：还没登录 DeepSeek 账号')
  assert.equal(formatBalance({ status: 'failed' }), '账户余额：暂时读不到')
  const text = formatBalance({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '12.5' }],
    bonusWallets: [{ currency: 'CNY', balance: '0' }],
  })
  assert.match(text, /充值 12\.5 元/)
  assert.match(text, /赠送 0 元/)
})

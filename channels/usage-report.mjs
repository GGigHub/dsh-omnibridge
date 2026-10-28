/** 把会话用量和账户余额收成 QQ 能直接看的短文。 */

function count(value) {
  const n = Number(value) || 0
  return n.toLocaleString('zh-CN')
}

/** 缓存命中 token /（命中 + 未缓存输入）。没有用量时返回「还没有」。 */
export function hitRateText(cacheRead, uncached) {
  const read = Number(cacheRead) || 0
  const miss = Number(uncached) || 0
  const total = read + miss
  if (total <= 0) return '还没有'
  return `${((read / total) * 100).toFixed(1)}%`
}

function money(wallet) {
  const unit = wallet?.currency === 'CNY' ? '元' : wallet?.currency === 'USD' ? '美元' : (wallet?.currency || '')
  const n = Number(wallet?.balance)
  const shown = Number.isFinite(n)
    ? n.toLocaleString('zh-CN', { maximumFractionDigits: 4 })
    : String(wallet?.balance ?? '未知')
  return unit ? `${shown} ${unit}` : shown
}

/** @param result deepseekAccount.getBalance 的结果，未登录时为 null。 */
export function formatBalance(result) {
  if (!result) return '账户余额：还没登录 DeepSeek 账号'
  if (result.status !== 'ready') return '账户余额：暂时读不到'
  const wallets = Array.isArray(result.value) ? result.value : []
  const bonus = Array.isArray(result.bonusWallets) ? result.bonusWallets : []
  const lines = ['账户余额：']
  if (!wallets.length && !bonus.length) lines.push('没有读到钱包')
  for (const wallet of wallets) lines.push(`充值 ${money(wallet)}`)
  for (const wallet of bonus) lines.push(`赠送 ${money(wallet)}`)
  return lines.join('\n')
}

/**
 * @param {{
 *   sessionId?: string,
 *   model?: string,
 *   effort?: string,
 *   usage?: { totals?: object, last?: { buckets?: object } | null } | null,
 *   pressure?: { contextWindow?: number, pressureTokens?: number, surfaceTokens?: number } | null,
 *   breakdown?: { breakdown?: { systemTokens?: number, toolsTokens?: number, messageTokens?: number } } | null,
 *   stats?: { turns?: number, steps?: number } | null,
 * }} input
 */
export function formatSessionStatus(input = {}) {
  const lines = []
  lines.push(input.sessionId ? `当前会话：${input.sessionId}` : '当前还没有会话。先正常发一句话，再发 /status。')
  if (input.model) lines.push(`模型：${input.model}${input.effort ? `，思考：${input.effort}` : ''}`)
  const turns = Number(input.stats?.turns) || 0
  const steps = Number(input.stats?.steps) || 0
  if (turns || steps) lines.push(`已经进行：${[turns ? `${turns} 轮` : '', steps ? `${steps} 步` : ''].filter(Boolean).join('，')}`)

  const pressure = input.pressure
  const used = Number(pressure?.pressureTokens ?? pressure?.surfaceTokens)
  if (pressure && Number.isFinite(used)) {
    if (pressure.contextWindow) {
      const pct = ((used / pressure.contextWindow) * 100).toFixed(2)
      lines.push(`上下文：${count(used)} / ${count(pressure.contextWindow)}（${pct}%）`)
    } else {
      lines.push(`上下文：已用 ${count(used)}，窗口大小还没读到`)
    }
  } else if (input.sessionId) {
    lines.push('上下文：这轮还没有用量')
  }

  const parts = input.breakdown?.breakdown
  if (parts) {
    lines.push(`组成：系统 ${count(parts.systemTokens)}，工具 ${count(parts.toolsTokens)}，对话 ${count(parts.messageTokens)}`)
  }

  const totals = input.usage?.totals
  if (totals) {
    lines.push(`累计 token：输入 ${count(totals.uncachedInputTokens)}，缓存命中 ${count(totals.cacheReadTokens)}，缓存写入 ${count(totals.cacheWriteTokens)}，输出 ${count(totals.outputTokens)}`)
    lines.push(`累计命中率：${hitRateText(totals.cacheReadTokens, totals.uncachedInputTokens)}`)
  }
  const last = input.usage?.last?.buckets
  if (last) {
    lines.push(`上一轮：输入 ${count(last.uncachedInputTokens)}，命中 ${count(last.cacheReadTokens)}，输出 ${count(last.outputTokens)}，命中率 ${hitRateText(last.cacheReadTokens, last.uncachedInputTokens)}`)
  }
  return lines.join('\n')
}

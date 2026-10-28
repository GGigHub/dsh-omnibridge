/**
 * 从桌面版自己带的运行库里取依赖。
 * 插件目录在仓库里，Node 不会去 DSH 的安装目录找包，直接 import 会让整个插件起不来。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

function hostPackageRoot() {
  const roots = []
  if (process.resourcesPath) roots.push(process.resourcesPath)
  roots.push(join(dirname(process.execPath), 'resources'))
  for (const root of roots) {
    const dir = join(root, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai')
    if (existsSync(join(dir, 'schemastery', 'package.json'))) return dir
  }
  return ''
}

const root = hostPackageRoot()
if (!root) {
  throw new Error('找不到桌面版自带的依赖，消息桥没有启动')
}

const requireHost = createRequire(join(root, 'schemastery', 'package.json'))
const schema = requireHost('@deepseek-ai/schemastery')
export const z = schema.object ? schema : schema.default

let userMessage
export async function createUserMessage(input) {
  if (!userMessage) {
    const mod = await import(pathToFileURL(join(root, 'dsh-llm', 'lib', 'index.js')).href)
    userMessage = mod.createUserMessage
    if (typeof userMessage !== 'function') throw new Error('桌面版没有提供创建消息的方法')
  }
  return userMessage(input)
}

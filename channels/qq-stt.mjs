/**
 * 把一段 wav 交给本机已经缓存的 SenseVoice 听成文字。
 * 模型跟 DSH 语音插件放在同一处，这个文件不自己下载模型。
 */

import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

let recognizer = null

export function defaultSenseDir() {
  if (process.env.QQ_FISH_SENSE_DIR) return process.env.QQ_FISH_SENSE_DIR
  const base = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(base, 'dsh-voice-mode', 'models', 'csukuangfj', 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17')
}

export function defaultSherpaEntry() {
  if (process.env.QQ_FISH_SHERPA) return process.env.QQ_FISH_SHERPA
  return join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'sherpa-onnx-node', 'sherpa-onnx.js')
}

function resample(samples, from, to) {
  if (from === to) return samples
  const outLen = Math.max(1, Math.round(samples.length * to / from))
  const out = new Float32Array(outLen)
  const last = samples.length - 1
  for (let i = 0; i < outLen; i++) {
    const x = i * from / to
    const i0 = Math.min(last, Math.floor(x))
    const i1 = Math.min(last, i0 + 1)
    const t = x - i0
    out[i] = samples[i0] * (1 - t) + samples[i1] * t
  }
  return out
}

function loadRecognizer() {
  if (recognizer) return recognizer
  const dir = defaultSenseDir()
  const model = join(dir, 'model.int8.onnx')
  const tokens = join(dir, 'tokens.txt')
  const entry = defaultSherpaEntry()
  if (!existsSync(model) || !existsSync(tokens)) {
    throw new Error(`语音模型不在 ${dir}`)
  }
  if (!existsSync(entry)) throw new Error(`语音库不在 ${entry}`)
  const sherpa = createRequire(import.meta.url)(entry)
  const OfflineRecognizer = sherpa.OfflineRecognizer || sherpa.default?.OfflineRecognizer
  if (!OfflineRecognizer) throw new Error('sherpa-onnx-node 没有 OfflineRecognizer')
  recognizer = new OfflineRecognizer({
    featConfig: { sampleRate: 16000, featureDim: 80 },
    modelConfig: {
      senseVoice: {
        model,
        language: 'zh',
        useInverseTextNormalization: 1,
      },
      tokens,
      provider: 'cpu',
      debug: 0,
      numThreads: 2,
    },
  })
  recognizer.readWave = sherpa.readWave || sherpa.default?.readWave
  return recognizer
}

/** 听一个 wav 文件。失败抛错，由调用方改成「没听清」。 */
export function transcribeWavFile(filePath) {
  const rec = loadRecognizer()
  if (typeof rec.readWave !== 'function') throw new Error('sherpa 不能读 wav')
  const wave = rec.readWave(filePath)
  let samples = wave.samples
  let rate = Number(wave.sampleRate) || 16000
  if (rate !== 16000) samples = resample(samples, rate, 16000)
  const stream = rec.createStream()
  try {
    stream.acceptWaveform({ samples, sampleRate: 16000 })
    rec.decode(stream)
    const text = String(rec.getResult(stream).text || '')
      .replace(/<\|[^|]*\|>/g, '')
      .trim()
    return text
  } finally {
    try { stream.free() } catch {}
  }
}

#!/usr/bin/env node
/**
 * DSH 会话日志读取器
 *
 * 用途：机器人不回话 / 回得不对 / 疑似卡死时，直接读宿主侧的会话事件日志。
 * 这是唯一能看到「模型到底有没有被调用」的地方。
 *
 * 用法：
 *   node session-log.mjs list                       列出所有会话（按最近活动倒序）
 *   node session-log.mjs find  <sessionKey>         由 sessionKey 反推并定位会话文件
 *   node session-log.mjs scan  <目标>               只列关键事件（preset / turn 结束原因）
 *   node session-log.mjs tail  <目标> [n]           打印最后 n 个事件（默认 20）
 *   node session-log.mjs range <目标> <from> <to>   打印 seq 区间内的完整事件
 *
 * <目标> 可以是：会话文件路径 / 会话 id / sessionKey（自动识别）
 *
 * 两个关键背景（踩过的坑，别重复踩）：
 *   1. 会话文件是**多帧追加**的 zstd。Node 的 zstdDecompressSync 只解第一帧，
 *      直接解会只得到 1 个事件。必须按魔数 28 B5 2F FD 切帧逐帧解。
 *   2. QQ 会话 id 不是随机数，是 sessionKey 的 sha256 按 8-4-4-4-12 切分而来，
 *      所以可以从 sessionKey 直接算出来。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const SESSIONS_ROOT = join(homedir(), '.dsh', 'sessions')
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

// ── sessionKey → sessionId（与插件 session-manager 的推导保持一致）──
function sessionIdOf(sessionKey) {
  const hex = createHash('sha256').update(sessionKey, 'utf8').digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** QQ 会话的 sessionKey 格式：qqbot:<appId>:<c2c|group>:<peerId> */
function looksLikeSessionKey(value) {
  return value.startsWith('qqbot:')
}

// ── 多帧 zstd 解压 ──
function decompressAll(file) {
  const raw = readFileSync(file)
  const starts = []
  for (let i = 0; i + 4 <= raw.length; i++) {
    if (raw[i] === ZSTD_MAGIC[0] && raw[i + 1] === ZSTD_MAGIC[1]
      && raw[i + 2] === ZSTD_MAGIC[2] && raw[i + 3] === ZSTD_MAGIC[3]) starts.push(i)
  }
  if (starts.length === 0) starts.push(0)

  let text = ''
  let pending = starts[0]
  for (let k = 1; k <= starts.length; k++) {
    const end = k < starts.length ? starts[k] : raw.length
    try {
      text += zstdDecompressSync(raw.subarray(pending, end)).toString('utf8')
      pending = end
    } catch {
      // 魔数可能误命中：把这一段并进下一段重试
      if (k === starts.length) {
        try { text += zstdDecompressSync(raw.subarray(pending)).toString('utf8') } catch { /* 放弃 */ }
      }
    }
  }
  return { text, frames: starts.length }
}

function parseEvents(file) {
  const { text, frames } = decompressAll(file)
  const events = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* 跳过坏行 */ }
  }
  return { events, frames }
}

// ── 定位会话文件 ──
function resolveTarget(target) {
  if (existsSync(target)) return target

  let id = target
  if (looksLikeSessionKey(target)) {
    id = sessionIdOf(target)
    console.error(`# 由 sessionKey 推导 sessionId: ${id}`)
  }

  // 在所有 cwd 分组下找同名目录
  if (!existsSync(SESSIONS_ROOT)) {
    console.error(`# 会话根目录不存在: ${SESSIONS_ROOT}`)
    process.exit(1)
  }
  for (const group of readdirSync(SESSIONS_ROOT)) {
    const dir = join(SESSIONS_ROOT, group, id)
    const file = join(dir, 'session.v4.jsonl.zstd')
    if (existsSync(file)) return file
  }
  console.error(`# 找不到会话文件: ${id}`)
  process.exit(1)
}

/** 会话头的 agentPreset —— 判断「人格有没有生效」的唯一依据 */
function presetOf(events) {
  const head = events.find((e) => e.type === 'session')
  return head?.agentPreset ?? '(未记录)'
}

/** 取事件里的内容块——两种形状都兼容：data.content / data.message.content */
function contentBlocks(ev) {
  const blocks = ev.data?.content ?? ev.data?.message?.content
  return Array.isArray(blocks) ? blocks : []
}

function summarize(ev) {
  const t = ev.type ?? '?'
  if (t === 'turn/end') {
    const kind = ev.data?.reason?.kind ?? '?'
    const err = ev.data?.reason?.error
    return `turn/end  reason=${kind}${err ? ` code=${err.code} msg=${err.message}` : ''}`
  }
  if (t === 'session') return `session  agentPreset=${ev.agentPreset ?? '(未记录)'}`
  if (t === 'user/message') {
    const text = contentBlocks(ev).map((c) => c.text ?? '').join('')
    return `user/message  ${text.slice(0, 90).replace(/\n/g, ' ')}`
  }
  if (t === 'assistant/message') {
    const types = contentBlocks(ev).map((c) => c.type)
    const text = contentBlocks(ev).filter((c) => c.type === 'text').map((c) => c.text).join('')
    return `assistant/message  blocks=[${types.join(',')}]  ${text.slice(0, 70).replace(/\n/g, ' ')}`
  }
  return t
}

// ── 子命令 ──
const [cmd, ...args] = process.argv.slice(2)

if (!cmd || cmd === 'help' || cmd === '--help') {
  console.log(readFileSync(new URL(import.meta.url)).toString('utf8').split('*/')[0].replace(/^\/\*\*?/, '').trim())
  process.exit(0)
}

if (cmd === 'list') {
  if (!existsSync(SESSIONS_ROOT)) {
    console.error(`会话根目录不存在: ${SESSIONS_ROOT}`)
    process.exit(1)
  }
  const rows = []
  for (const group of readdirSync(SESSIONS_ROOT)) {
    const groupDir = join(SESSIONS_ROOT, group)
    for (const id of readdirSync(groupDir)) {
      const file = join(groupDir, id, 'session.v4.jsonl.zstd')
      if (!existsSync(file)) continue
      const st = statSync(file)
      rows.push({ id, group, sizeKB: Math.round(st.size / 1024), mtime: st.mtime })
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime)
  console.log('会话 id                                大小    最后活动(本地)      cwd 分组')
  for (const r of rows.slice(0, 40)) {
    // 本地时间：排查时要和日志/聊天记录对时间，用 UTC 会看错
    const local = new Date(r.mtime.getTime() - r.mtime.getTimezoneOffset() * 60000)
      .toISOString().slice(5, 19).replace('T', ' ')
    console.log(`${r.id}  ${String(r.sizeKB).padStart(6)}KB  ${local}  ${r.group}`)
  }
  process.exit(0)
}

if (cmd === 'find') {
  const key = args[0]
  if (!key) { console.error('用法: find <sessionKey>'); process.exit(1) }
  const id = looksLikeSessionKey(key) ? sessionIdOf(key) : key
  console.log(`sessionKey : ${key}`)
  console.log(`sessionId  : ${id}`)
  const file = resolveTarget(id)
  const { events, frames } = parseEvents(file)
  console.log(`文件       : ${file}`)
  console.log(`帧数       : ${frames}`)
  console.log(`事件数     : ${events.length}`)
  console.log(`agentPreset: ${presetOf(events)}`)
  process.exit(0)
}

const target = args[0]
if (!target) { console.error(`用法: ${cmd} <目标> [...]`); process.exit(1) }
const file = resolveTarget(target)
const { events, frames } = parseEvents(file)

if (cmd === 'scan') {
  console.log(`文件: ${file}  帧数: ${frames}  事件数: ${events.length}`)
  console.log(`agentPreset: ${presetOf(events)}`)
  console.log('---')
  for (const ev of events) {
    if (['session', 'turn/end', 'turn/start', 'user/message'].includes(ev.type)) {
      console.log(`[${ev.seq ?? ''}] ${summarize(ev)}`)
    }
  }
} else if (cmd === 'tail') {
  const n = Number(args[1] ?? 20)
  console.log(`文件: ${file}  事件数: ${events.length}`)
  console.log('---')
  for (const ev of events.slice(-n)) console.log(`[${ev.seq ?? ''}] ${summarize(ev)}`)
} else if (cmd === 'range') {
  const from = Number(args[1] ?? 0)
  const to = Number(args[2] ?? 1e9)
  for (const ev of events) {
    const seq = ev.seq ?? -1
    if (seq < from || seq > to) continue
    console.log(`\n===== seq ${seq} : ${ev.type} =====`)
    console.log(JSON.stringify(ev.data ?? ev, null, 1).slice(0, 2000))
  }
} else {
  console.error(`未知子命令: ${cmd}`)
  process.exit(1)
}

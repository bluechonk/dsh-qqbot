#!/usr/bin/env node
/**
 * 群友档案维护工具
 *
 * 用途：`~/.dsh-qqbot/people.json` 里存的是「学到的别名」这类**不可再生**数据，
 * 插件记错了必须能查、能改、能备份。这个技能就是那双手。
 *
 * 用法：
 *   node people.mjs list                          列出所有档案（按互动次数倒序）
 *   node people.mjs show   <openid|名字|别名>      看某个人的完整档案
 *   node people.mjs forget <openid|名字|别名> <片段>  删掉匹配的别名 / 记忆
 *   node people.mjs export                         导出成可读文本（备份 / 迁移）
 *   node people.mjs path                           打印档案文件位置与状态
 *
 * ⚠️ 并发提醒：插件把档案缓存在内存里，收到新消息后 5 秒内会整份写回。
 *    所以**在群里安静时改**，改完再确认一次（`node people.mjs show <key>`）。
 *
 * 文件位置默认 `~/.dsh-qqbot/people.json`，多实例时可用 `--file` 指定
 * （多实例的档案落在 `~/.dsh-qqbot/<settingsNs>/people.json`）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

// ── 参数解析 ──
const argv = process.argv.slice(2)
let fileOverride = process.env.DSH_QQBOT_PEOPLE || ''
const rest = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--file') {
    fileOverride = argv[++i] ?? ''
  } else if (argv[i] === '--dir') {
    fileOverride = join(argv[++i] ?? '', 'people.json')
  } else {
    rest.push(argv[i])
  }
}
const FILE = fileOverride || join(homedir(), '.dsh-qqbot', 'people.json')
const [command, ...args] = rest

// ── 档案读写 ──
function readPeople() {
  if (!existsSync(FILE)) {
    return { ok: false, reason: 'missing', data: { version: 1, people: {} } }
  }
  try {
    const parsed = JSON.parse(readFileSync(FILE, 'utf8'))
    if (parsed?.version !== 1 || typeof parsed?.people !== 'object' || parsed.people === null) {
      return { ok: false, reason: '结构不符合预期（version 应为 1）', data: null }
    }
    return { ok: true, reason: '', data: parsed }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err), data: null }
  }
}

/** 原子写回（先写临时文件再改名），避免写一半把档案弄坏 */
function writePeople(data) {
  mkdirSync(dirname(FILE), { recursive: true })
  const tmp = `${FILE}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, FILE)
}

// ── 展示辅助 ──
function shortId(openid) {
  return openid.length > 12 ? `…${openid.slice(-12)}` : openid
}

function callAs(profile) {
  const alias = profile.aliases?.[profile.aliases.length - 1]
  return alias || profile.name || '<无称呼>'
}

function fmtTime(ts) {
  if (!ts) return '未知'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return String(ts)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/**
 * 把用户给的查询串解析成档案 key 列表。
 * 依次尝试：完整 key、openid、name、alias。
 *
 * 同一个人可能同时出现在多个群 / 私聊里（key 不同、openid 相同），
 * 所以返回**列表**，由调用方决定怎么处理——猜错人比不猜更糟。
 */
function resolveKeys(data, query) {
  const people = data.people ?? {}
  if (Object.prototype.hasOwnProperty.call(people, query)) return [query]

  const hits = []
  for (const [key, p] of Object.entries(people)) {
    if (p.openid === query) { hits.push(key); continue }
    if (p.name === query) { hits.push(key); continue }
    if ((p.aliases ?? []).includes(query)) hits.push(key)
  }
  return hits
}

/** 多个命中是否其实是同一个人（只是不同群 / 私聊） */
function samePerson(data, keys) {
  const ids = new Set(keys.map((k) => data.people[k]?.openid))
  return ids.size === 1
}

/** 命中不唯一时，把候选列出来让用户自己挑 */
function reportAmbiguous(data, keys) {
  console.error(`匹配到 ${keys.length} 个档案，请指定完整 openid：`)
  for (const k of keys) console.error(`  ${k}`)
}

function describeProfile(key, p) {
  const scope = key.includes('|group:') ? '群聊' : '私聊'
  const facts = p.memory?.facts ?? []
  const lines = [
    `key      ${key}`,
    `范围     ${scope}`,
    `openid   ${p.openid}`,
    `称呼     ${callAs(p)}`,
    p.name ? `昵称     ${p.name}` : null,
    `别名     ${(p.aliases ?? []).length > 0 ? p.aliases.join('、') : '（无）'}`,
    `互动次数 ${p.count ?? 0}`,
    `首次见到 ${fmtTime(p.firstSeen)}`,
    `最近见到 ${fmtTime(p.lastSeen)}`,
  ]
  if (facts.length > 0) {
    lines.push(`记忆     ${facts.length} 条`)
    for (const f of facts) lines.push(`         - ${f.text}（${fmtTime(f.at)}）`)
  }
  return lines.filter((l) => l !== null)
}

// ── 命令实现 ──
function cmdPath() {
  console.log(`文件     ${FILE}`)
  console.log(`存在     ${existsSync(FILE) ? '是' : '否'}`)
  if (existsSync(FILE)) {
    const r = readPeople()
    if (r.ok) console.log(`档案数   ${Object.keys(r.data.people).length}`)
    else console.log(`可读     否（${r.reason}）`)
  } else {
    console.log('含义     插件从未成功处理过消息（档案在入站时创建）')
  }
}

function cmdList() {
  const r = readPeople()
  if (!r.ok && r.reason !== 'missing') {
    console.error(`读不了档案文件：${r.reason}`)
    console.error('原始文件已保留，未做任何改动。')
    process.exit(1)
  }
  const entries = Object.entries(r.data.people)
  if (entries.length === 0) {
    console.log(existsSync(FILE) ? '档案是空的（还没有群友被记录）' : '档案文件不存在')
    return
  }
  entries.sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0))
  console.log(`共 ${entries.length} 人（按互动次数倒序）\n`)
  for (const [key, p] of entries) {
    const scope = key.includes('|group:') ? '群' : '私'
    const facts = p.memory?.facts?.length ?? 0
    console.log(
      `${scope}  ${callAs(p)}  ${shortId(p.openid)}  `
      + `聊过 ${p.count ?? 0} 次  最近 ${fmtTime(p.lastSeen)}`
      + (facts > 0 ? `  记忆 ${facts} 条` : ''),
    )
  }
}

function cmdShow(query) {
  if (!query) {
    console.error('用法：node people.mjs show <openid|名字|别名>')
    process.exit(1)
  }
  const r = readPeople()
  if (!r.ok) {
    console.error(`读不了档案文件：${r.reason}`)
    process.exit(1)
  }
  const keys = resolveKeys(r.data, query)
  if (keys.length === 0) {
    console.error(`没有找到「${query}」。先用 list 看看都有谁。`)
    process.exit(1)
  }
  if (keys.length > 1 && !samePerson(r.data, keys)) {
    reportAmbiguous(r.data, keys)
    process.exit(1)
  }
  if (keys.length > 1) {
    console.log(`「${query}」是同一个人，出现在 ${keys.length} 个范围：\n`)
  }
  console.log(keys.map((k) => describeProfile(k, r.data.people[k]).join('\n')).join('\n\n'))
}

function cmdForget(query, fragment) {
  if (!query || !fragment) {
    console.error('用法：node people.mjs forget <openid|名字|别名> <要删的片段>')
    console.error('例子：node people.mjs forget EC162542… 老王')
    process.exit(1)
  }
  const r = readPeople()
  if (!r.ok) {
    console.error(`读不了档案文件：${r.reason}`)
    process.exit(1)
  }
  const keys = resolveKeys(r.data, query)
  if (keys.length === 0) {
    console.error(`没有找到「${query}」。`)
    process.exit(1)
  }
  if (keys.length > 1 && !samePerson(r.data, keys)) {
    reportAmbiguous(r.data, keys)
    process.exit(1)
  }

  const removed = []
  for (const key of keys) {
    const profile = r.data.people[key]

    // 记忆与别名是两类东西，都可能被记错，所以两者都搜
    const facts = profile.memory?.facts
    if (Array.isArray(facts)) {
      profile.memory.facts = facts.filter((f) => {
        const hit = f.text.includes(fragment)
        if (hit) removed.push(`[${key}] 记忆：${f.text}`)
        return !hit
      })
      if (profile.memory.facts.length === 0) delete profile.memory
    }

    const aliases = profile.aliases ?? []
    if (aliases.length > 0) {
      profile.aliases = aliases.filter((a) => {
        const hit = a.includes(fragment)
        if (hit) removed.push(`[${key}] 别名：${a}`)
        return !hit
      })
    }
  }

  if (removed.length === 0) {
    console.error(`「${fragment}」在 ${callAs(r.data.people[keys[0]])} 的档案里没有匹配到任何条目。`)
    console.error('未做改动。')
    process.exit(1)
  }

  writePeople(r.data)
  console.log(`已删除 ${removed.length} 条：`)
  for (const item of removed) console.log(`  ${item}`)
  console.log(`\n写回 ${FILE}`)
  console.log('提醒：机器人收到新消息后会用内存副本整份写回，必要时重启插件让它重新读盘。')
}

function cmdExport() {
  const r = readPeople()
  if (!r.ok && r.reason !== 'missing') {
    console.error(`读不了档案文件：${r.reason}`)
    process.exit(1)
  }
  const entries = Object.entries(r.data.people).sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0))
  console.log(`# 群友档案导出`)
  console.log(`# 文件：${FILE}`)
  console.log(`# 人数：${entries.length}`)
  console.log('')
  for (const [key, p] of entries) {
    console.log(describeProfile(key, p).join('\n'))
    console.log('')
  }
}

function cmdHelp() {
  console.log(`群友档案维护工具

  node people.mjs list                            列出所有档案（按互动次数倒序）
  node people.mjs show   <openid|名字|别名>        看某个人的完整档案
  node people.mjs forget <openid|名字|别名> <片段>  删掉匹配的别名 / 记忆
  node people.mjs export                           导出成可读文本（备份 / 迁移）
  node people.mjs path                             打印档案文件位置与状态

选项：
  --file <path>   指定档案文件（默认 ~/.dsh-qqbot/people.json）
  --dir  <path>   指定数据目录（自动拼 people.json）
  DSH_QQBOT_PEOPLE 环境变量也能指定档案文件`)
}

// ── 入口 ──
switch (command) {
  case 'list': cmdList(); break
  case 'show': cmdShow(args[0]); break
  case 'forget': cmdForget(args[0], args[1]); break
  case 'export': cmdExport(); break
  case 'path': cmdPath(); break
  case 'help':
  case undefined: cmdHelp(); break
  default:
    console.error(`未知命令：${command}`)
    cmdHelp()
    process.exit(1)
}

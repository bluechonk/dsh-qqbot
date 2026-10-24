#!/usr/bin/env node
/**
 * 表情包维护工具
 *
 * 用途：导入素材（目录里的图片 → 图库条目）、查看、删除、核对素材文件是否还在。
 * 素材不随仓库分发（版权归原作者），所以「导入」是本地操作，这个技能是那双手。
 *
 * 用法：
 *   node stickers.mjs list                       列出图库与素材状态
 *   node stickers.mjs import <素材目录>           扫描图片并加入图库（已存在则跳过）
 *   node stickers.mjs forget <id|文件名片段>      删除条目
 *   node stickers.mjs export                     导出可读文本
 *   node stickers.mjs path                       打印图库与素材目录位置
 *
 * 目录约定：图库 `~/.dsh-qqbot/stickers.json`，素材 `~/.dsh-qqbot/stickers/`。
 *
 * 标签说明（对应 docs/拟人化路线图.md 的三层）：
 *   L1 台词/描述 ← 导入时从文件名推导（零成本、质量最高）
 *   L2 场景标签 ← 需要人工批量指定，本工具不猜（猜错的标签比没有更糟）
 *   L3 检索向量 ← 未做（需要嵌入模型）
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, join } from 'node:path'

// ── 参数解析 ──
const argv = process.argv.slice(2)
let fileOverride = ''
let dirOverride = ''
const rest = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--file') fileOverride = argv[++i] ?? ''
  else if (argv[i] === '--dir') dirOverride = argv[++i] ?? ''
  else rest.push(argv[i])
}
const [command, ...args] = rest

const DATA_DIR = process.env.DSH_QQBOT_DIR || join(homedir(), '.dsh-qqbot')
const CATALOG = fileOverride || join(DATA_DIR, 'stickers.json')
const ASSETS = dirOverride || join(DATA_DIR, 'stickers')

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'])

// ── 图库读写 ──
function readCatalog() {
  if (!existsSync(CATALOG)) return { version: 1, stickers: [] }
  try {
    const parsed = JSON.parse(readFileSync(CATALOG, 'utf8'))
    if (parsed?.version !== 1 || !Array.isArray(parsed.stickers)) {
      console.error(`图库结构不符合预期（version 应为 1）：${CATALOG}`)
      process.exit(1)
    }
    return parsed
  } catch (err) {
    console.error(`读不了图库：${err instanceof Error ? err.message : String(err)}`)
    console.error('原始文件已保留，未做任何改动。')
    process.exit(1)
  }
}

function writeCatalog(data) {
  mkdirSync(dirname(CATALOG), { recursive: true })
  const tmp = `${CATALOG}.tmp`
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  renameSync(tmp, CATALOG)
}

/** 从文件名推导 L1 台词（去掉扩展名，下划线/连字符转空格，截断） */
function textFromName(name) {
  const stem = basename(name, extname(name))
  const cleaned = stem.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 60) : undefined
}

/** 稳定 id：文件名哈希（同一文件反复导入得到同一 id，便于去重判断） */
function idOf(name) {
  let h = 0
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) | 0
  }
  return `s_${(h >>> 0).toString(36)}`
}

function assetExists(file) {
  return existsSync(join(ASSETS, file))
}

// ── 命令 ──
function cmdPath() {
  console.log(`图库     ${CATALOG}`)
  console.log(`素材目录 ${ASSETS}（${existsSync(ASSETS) ? '存在' : '不存在，导入时会创建'}）`)
}

function cmdList() {
  const data = readCatalog()
  if (data.stickers.length === 0) {
    console.log(existsSync(CATALOG) ? '图库是空的（还没有导入素材）' : '图库不存在')
    return
  }
  const missing = data.stickers.filter((s) => !assetExists(s.file))
  console.log(`共 ${data.stickers.length} 条（素材缺失 ${missing.length} 条）\n`)
  for (const s of data.stickers) {
    const flags = [
      assetExists(s.file) ? '素材在' : '素材缺失',
      s.mood ? `情绪=${s.mood}` : '',
      s.scene ? `场景=${s.scene}` : '',
      s.strength ? `强度=${s.strength}` : '',
    ].filter(Boolean).join('  ')
    console.log(`${s.id}  ${s.file}  ${s.text ?? '（无台词）'}  [${flags}]`)
  }
}

function cmdImport(dir) {
  if (!dir) {
    console.error('用法：node stickers.mjs import <素材目录>')
    process.exit(1)
  }
  if (!existsSync(dir)) {
    console.error(`目录不存在：${dir}`)
    process.exit(1)
  }

  const files = readdirSync(dir)
    .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
    .sort()
  if (files.length === 0) {
    console.error(`目录里没有图片（支持 ${[...IMAGE_EXTS].join(' ')}）：${dir}`)
    process.exit(1)
  }

  const data = readCatalog()
  const existing = new Set(data.stickers.map((s) => s.file))
  const added = []
  for (const file of files) {
    if (existing.has(file)) continue
    const id = idOf(file)
    if (data.stickers.some((s) => s.id === id)) continue
    data.stickers.push({ id, file, text: textFromName(file) })
    added.push(file)
  }

  if (added.length === 0) {
    console.log(`${files.length} 张图片都已在图库中，未做改动。`)
    return
  }

  writeCatalog(data)
  console.log(`已加入 ${added.length} 条（共 ${files.length} 张）：`)
  for (const f of added) console.log(`  ${f}`)
  console.log(`\n写回 ${CATALOG}`)
  console.log('提醒：素材文件需放在素材目录才能发送——')
  console.log(`  mkdir -p "${ASSETS}" && cp <你的图片> "${ASSETS}/"`)
  console.log('L2 场景标签需要人工指定（本工具不猜），指定后她才知道什么时候发哪张。')
}

function cmdForget(query) {
  if (!query) {
    console.error('用法：node stickers.mjs forget <id|文件名片段>')
    process.exit(1)
  }
  const data = readCatalog()
  const hits = data.stickers.filter((s) => s.id === query || s.file.includes(query))
  if (hits.length === 0) {
    console.error(`没有匹配「${query}」的条目。先用 list 看看都有什么。`)
    process.exit(1)
  }
  if (hits.length > 1) {
    console.error(`「${query}」匹配到 ${hits.length} 条，请用完整 id：`)
    for (const s of hits) console.error(`  ${s.id}  ${s.file}`)
    process.exit(1)
  }
  const [target] = hits
  data.stickers = data.stickers.filter((s) => s !== target)
  writeCatalog(data)
  console.log(`已删除 ${target.id}（${target.file}）`)
  console.log('注意：只删了图库条目，素材文件还在素材目录里，需要的话自行清理。')
}

function cmdExport() {
  const data = readCatalog()
  console.log(`# 表情包导出`)
  console.log(`# 图库：${CATALOG}`)
  console.log(`# 素材：${ASSETS}`)
  console.log(`# 条数：${data.stickers.length}`)
  console.log('')
  for (const s of data.stickers) {
    console.log(`${s.id}\t${s.file}\t${s.text ?? ''}\t${s.mood ?? ''}\t${s.scene ?? ''}\t${s.strength ?? ''}`)
  }
}

function cmdHelp() {
  console.log(`表情包维护工具

  node stickers.mjs list                    列出图库与素材状态
  node stickers.mjs import <素材目录>        扫描图片并加入图库（已存在则跳过）
  node stickers.mjs forget <id|文件名片段>   删除条目
  node stickers.mjs export                  导出可读文本
  node stickers.mjs path                    打印图库与素材目录位置

选项：
  --file <path>   指定图库文件（默认 ~/.dsh-qqbot/stickers.json）
  --dir  <path>   指定素材目录（默认 ~/.dsh-qqbot/stickers）
  DSH_QQBOT_DIR   环境变量也能指定数据目录`)
}

switch (command) {
  case 'list': cmdList(); break
  case 'import': cmdImport(args[0]); break
  case 'forget': cmdForget(args[0]); break
  case 'export': cmdExport(); break
  case 'path': cmdPath(); break
  case 'help':
  case undefined: cmdHelp(); break
  default:
    console.error(`未知命令：${command}`)
    cmdHelp()
    process.exit(1)
}

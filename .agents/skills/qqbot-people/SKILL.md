---
name: qqbot-people
description: "维护 dsh-qqbot 的群友档案（~/.dsh-qqbot/people.json）：查看、删除记错的别名/记忆、导出备份。当需要「机器人把某人记错了要改」「想看看它记住了什么」「备份群友档案」「群友档案文件损坏了」时用这个技能。档案是学到的别名这类不可再生数据，改之前先看清结构，改完要确认。"
user-invocable: true
allowed-tools: "Read Bash Glob Grep"
---

# 群友档案维护

## 这个技能解决什么

`people.json` 里存的是插件**学到的东西**：谁希望被怎么称呼、聊过几次。
它是**不可再生**的——丢了就是丢了，没有别的地方能恢复。

所以它必须能查、能改、能备份。插件自己只在入站时写，没有任何人工入口，
这个技能就是那双手。

**它不负责「让机器人记住更多」**——那是长期记忆功能的事，还没实现。
这个技能只维护**已有的**档案。

## 工具

```bash
cd .agents/skills/qqbot-people/scripts

# 列出所有档案（按互动次数倒序）
node people.mjs list

# 看某个人的完整档案（openid / 昵称 / 别名都行）
node people.mjs show EC162542C77F402DC4C07E3735E786A9

# 删掉记错的东西（别名与记忆都会搜）
node people.mjs forget <openid|名字|别名> <要删的片段>

# 导出成可读文本（备份 / 迁移）
node people.mjs export

# 档案文件在哪、有没有、几条
node people.mjs path
```

多实例时档案落在 `~/.dsh-qqbot/<settingsNs>/people.json`，
用 `--dir <数据目录>` 或 `--file <路径>` 指过去；
也可以设环境变量 `DSH_QQBOT_PEOPLE`。

## 数据结构

```json
{
  "version": 1,
  "people": {
    "<appId>|<scope>:<scopeId>|<openid>": {
      "openid": "...",
      "name": "bluechonk",
      "aliases": ["老王"],
      "count": 12,
      "firstSeen": 1792725125501,
      "lastSeen": 1792755566998
    }
  }
}
```

key 是 `appId|scope:scopeId|openid`——**同一个人在不同群 / 私聊里是不同档案**，
因为两个群里的「他」本来就不同。所以 `show <openid>` 常常会命中多条，
脚本会把它们都列出来（是同一个人，只是范围不同）。

`name` 是**可选**的：私聊没有群成员表，取不到昵称就不写这个键。
所以私聊档案显示 `<无称呼>` 是正常的，不是坏了。

`memory.facts` 是长期记忆功能预留的字段，**现在还不存在**。
脚本已经能处理它（`list` 会显示条数、`forget` 会删），
等功能落地后不用改工具。

## 改之前必须知道的两件事

### 1. 插件会把你的修改覆盖掉

插件把档案**缓存在内存里**，收到新消息后 5 秒内会**整份写回**。
所以：

- **在群里安静时改**
- 改完用 `show` 再确认一次
- 如果改完发现被还原，说明期间有新消息——重启插件让它重新读盘

`forget` 用的是**原子写**（先写 `.tmp` 再改名），所以不会写一半把文件弄坏。
但原子写只能防「写坏」，防不了「被覆盖」。

### 2. 别猜人

`show` / `forget` 在命中多个**不同**的人时会报错并列出候选，
而不是替你挑一个——认错人比不认更糟。

## 常见场景

**「机器人一直叫我错的称呼」**

```bash
node people.mjs show <你的openid>      # 找到那条别名
node people.mjs forget <你的openid> <错的称呼>
```

**「想看看它记住了谁」**

```bash
node people.mjs list
```

**「换电脑 / 想留个底」**

```bash
node people.mjs export > people-backup.txt
```

**「档案文件读不了了」**

`path` 会报「可读 否」+ 原因。插件在读不动时会把文件改名成
`people.json.corrupt` 而不是直接覆盖，所以**原始数据还在**——
用 `--file ~/.dsh-qqbot/people.json.corrupt` 指过去看。

## 相关

- `qqbot-log-triage` —— 插件层排查（快照里也打印档案，但只能看不能改）
- `docs/群友档案.md` —— 长期记忆的设计稿（本技能是它的维护前置）
- `docs/内部机制.md` —— 数据目录与中间件链

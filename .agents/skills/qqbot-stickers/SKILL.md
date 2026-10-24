---
name: qqbot-stickers
description: "维护 dsh-qqbot 的表情包（~/.dsh-qqbot/stickers.json 与 stickers/ 素材）：导入素材、查看图库、删除条目、核对素材文件是否还在。当需要「导入表情包素材」「看看图库有什么」「某张表情删掉」「素材文件是不是丢了」时用这个技能。素材不随仓库分发（版权归原作者），导入是本地操作。"
user-invocable: true
allowed-tools: "Read Bash Glob Grep"
---

# 表情包维护

## 这个技能解决什么

表情包功能**逻辑与发送链路都已接好**（`src/features/stickers/`），但**默认关闭**
（`stickers.enabled=false`），因为素材要自备——图片版权归原作者，仓库不分发。

所以「导入素材」是本地操作，这个技能是那双手：扫目录、建条目、核对素材还在不在。

**它不猜 L2 场景标签**：L2（什么情绪、什么场景）猜错的标签比没有更糟——
她会选错时机发错图。导入只写 L1（文件名推导的台词），L2 留给你人工指定。

## 工具

```bash
cd .agents/skills/qqbot-stickers/scripts

# 图库有什么、素材文件还在不在
node stickers.mjs list

# 导入一个目录里的图片（已存在则跳过）
node stickers.mjs import <素材目录>

# 删除条目（id 或文件名片段）
node stickers.mjs forget <id|文件名片段>

# 导出可读文本（备份 / 迁移）
node stickers.mjs export

# 图库与素材目录在哪
node stickers.mjs path
```

多实例时数据在 `~/.dsh-qqbot/<settingsNs>/`，用 `--file` / `--dir` 指过去；
也可以设环境变量 `DSH_QQBOT_DIR`。

## 目录约定

```
~/.dsh-qqbot/
├── stickers.json     # 图库目录（条目：id / file / L1 台词 / L2 标签 / L3 向量）
└── stickers/         # 图片素材（需自行导入，仓库不含）
```

## 导入之后还要做什么

1. **把图片放进素材目录**（导入只登记条目，不搬文件）：
   ```bash
   mkdir -p ~/.dsh-qqbot/stickers && cp <你的图片> ~/.dsh-qqbot/stickers/
   ```
2. **给条目补 L2 标签**（情绪 / 场景 / 强度）——直接改 `stickers.json`
3. **打开开关**：`stickers.enabled=true`
4. 重启 DSH，按验收清单实测发送时机

## 条目结构

```json
{
  "id": "s_xxxx",
  "file": "img.png",
  "text": "文件名推导的台词（L1）",
  "mood": "happy",
  "scene": "被夸",
  "strength": "light"
}
```

`id` 由文件名哈希生成（同一文件反复导入得到同一 id，天然去重）；
L3 `vector` 字段留位未用（需要嵌入模型，本版未做）。

## 相关

- `qqbot-people` —— 群友档案维护（同形态的另一个维护入口）
- `docs/表情包.md` —— 图库格式、情绪标签、发送时机规则
- `docs/拟人化路线图.md` —— 表情包专项设计与三层标签的完整推演

# dsh-qqbot

[中文](README.md) | English

DeepSeek Harness plugin: wires QQ private chats and group chats into dsh, where the AI keeps company as the "blue whale" — no terminal, no file tools, it only talks.

## Features

- **Chats like a group member**: sessions always run on the bundled `qqchat` preset — zero tools (no terminal, no file read/write); the persona and speaking style are defined by the plugin itself
- **Speaks up on her own**: when nobody @-mentions her, a local lexical gate decides whether the message is worth answering; whether to actually reply is then up to the model
- **Silence is normal**: the model can answer `[skip]` to stay quiet for a turn — not every message gets a reply
- **Human rhythm**: replies carry a random delay (1.2s base + 80ms per character + jitter), so it never answers instantly
- **In-app binding**: scan the QR code, type credentials, rotate or unbind — all inside Settings → "QQ 机器人", never opening a system browser
- **Question cards**: when the model needs a decision, it posts a button card in QQ; tapping a button answers it
- **Approval cards**: host-driven approvals can be approved or denied straight from QQ
- **Rich media**: incoming images and videos are downloaded and analysed; files can be sent back
- **Session isolation**: private chats and group chats are independent; the session key carries the appId, so multiple accounts never cross
- **Config panel**: access control, @-requirement, streaming, speaking up on her own, reply rhythm, model and prompt overrides — all editable in Settings

## Screenshots

![Group chat](docs/assets/qqgroup.jpg)

![Private chat](docs/assets/qqchannel.jpg)

![QR binding](docs/assets/qrcode.png)

## Install, update, uninstall

### Option 1: paste the GitHub link in the Plugins page (recommended)

The DSH "插件" page has a **+ 添加插件** button in the top right; the dialog's first line reads "输入插件的包名、**GitHub 仓库地址**或本地目录路径" — paste the link below and click "安装"; the UI recognises it as a "Git 仓库":

```
https://github.com/bluechonk/dsh-qqbot
```

The host then writes the package into the profile's `dependencies` (as `github:bluechonk/dsh-qqbot`) and adds it to `dsh.profile.bundles`; the "QQ 机器人" entry appears in Settings.

> Installing from GitHub builds the package on the spot (the repository compiles `dist/` and `lib/` during install via a `prepare` hook). The first install takes about 30 seconds; later ones hit the cache.

### Option 2: the plugin market index (browsable, one-click install)

This repository ships a **market index** `market-index.json` (pointing at its own git source, pinned to a commit). After enabling the market bundle, paste the link below into the index source box on the DSH "设置 → 插件" page — the plugin shows up under the Discover tab, ready to install:

```
https://raw.githubusercontent.com/bluechonk/dsh-qqbot/main/market-index.json
```

Enabling the market bundle (one-off; the version must match your DSH runtime, otherwise the host refuses to enable it and says so):

```bash
plugin_manager set_bundle --target "@deepseek-ai/dsh-experimental-plugin-market-bundle" --enabled true
```

### Option 3: the tool and the command line

```bash
# Tool (available as plugin_manager inside a conversation)
plugin_manager install_bundle --target "https://github.com/bluechonk/dsh-qqbot"

# Command line (forwarded to pnpm in the profile directory)
dsh plugin --profile desktop add "https://github.com/bluechonk/dsh-qqbot"
```

Then bind credentials in Settings → "QQ 机器人" (QR code, or type AppID / AppSecret).

### Local development

When working from source, **link** the repository into the profile's `node_modules`; the host loads through the link, so a rebuild plus a page refresh is enough:

```bash
dsh plugin --profile desktop add link:/path/to/dsh-qqbot
```

Build:

```sh
pnpm install
pnpm build     # tsc (host half → dist/) && tsdown (browser half → lib/client.js)
```

> Use `link:`, not `file:` — the package manager does **not** track content changes for `file:` directory dependencies, so edits never get repacked; `link:` is a symlink and takes effect as soon as the build finishes.

### Installing with an AI assistant

1. Read this file in full first (especially "Known limitations").
2. Use `plugin_manager`'s `install_bundle` with the repository's GitHub URL as the target.
3. Read the result: `application` must be `applied`. On `failed`, diagnose via `error.diagnostic` and reinstall the same package — do not create a second copy.
4. Use `cordis_inspect_query` (Slots.listSubTree, root `settings.section`) to confirm `dsh-qqbot` is listed.
5. Bind credentials: scan in Settings → "QQ 机器人", or type AppID / AppSecret.

## Configuration

Configuration lives in the `im-qqbot` entry of the profile's `cordis.patch.yml`, and can also be edited from the settings panel (changes reload automatically).

### Editable in the settings panel

| Key | Type | Default | Meaning |
|---|---|---|---|
| `requireMention` | boolean | `false` | Whether group messages must @ the bot (superseded by the gate when proactive mode is on) |
| `streaming` | boolean | `false` | Stream replies (always off in group chats) |
| `showToolResults` | boolean | `false` | Show successful tool results (errors always shown) |
| `debug` | boolean | `false` | Debug mode |
| `provider` | string | - | LLM provider name; empty inherits the host default |
| `model` | string | - | Model name; empty inherits the host default |
| `reasoningEffort` | `off`/`low`/`medium`/`high`/`max` | - | Reasoning effort; empty lets the host decide (`off` recommended for qqchat) |
| `preset` | string | `qqchat` | Fixed; kept only for backward compatibility |
| `groupPrompt` | string | - | Extra system prompt for group chats |
| `directPrompt` | string | - | Extra system prompt for private chats |
| `access.c2cMode` | `open`/`allowlist`/`disabled` | `open` | Private chat access mode |
| `access.c2cAllow` | string[] | `[]` | Private chat allowlist (user openid) |
| `access.groupMode` | `open`/`allowlist`/`disabled` | `open` | Group chat access mode |
| `access.groupAllow` | string[] | `[]` | Group chat allowlist (group openid) |
| `proactive.enabled` | boolean | `true` | Master switch for speaking up on her own |
| `proactive.minScore` | number | `0.55` | Pass threshold (0~1) |
| `proactive.cooldownMs` | number | `120000` | Minimum gap between two proactive replies in one group (ms) |
| `proactive.maxPerHour` | number | `6` | Proactive replies per group per hour, 0 means unlimited |
| `proactive.minLength` | number | `6` | Minimum text length to be considered |
| `proactive.observer` | boolean | `true` | Record gate decisions |
| `people.enabled` | boolean | `true` | People profiles (nicknames, how they like to be called, interaction count) |
| `people.maxAliases` | number | `2` | How many aliases to include in the injected hint |
| `replyDelayMs` | number | `1200` | Base reply delay (ms), 0 disables it |
| `replyDelayPerCharMs` | number | `80` | Extra reply delay per character (ms) |
| `replyDelayJitterMs` | number | `1500` | Random jitter cap for reply delay (ms) |
| `replyDelayMaxMs` | number | `8000` | Cap on a single reply delay (ms), 0 means uncapped |

### Patch-file only

Tuning fields; no need to touch them day to day:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `appId` / `appSecret` | string | - | QQ bot credentials (written by the binding flow) |
| `cwd` | string | - | Agent working directory (read-only in the panel) |
| `textChunkLimit` | number | `4500` | Max characters per message |
| `sessionIdleTimeout` | number | `1800000` | Idle session eviction (ms) |
| `maxQueue` | number | `20` | Max concurrency queue length |
| `processingTimeoutMs` | number | `1800000` | Per-request processing timeout (ms) |
| `askTimeoutMs` | number | `300000` | Pending-question timeout (ms) |
| `historyLimit` | number | `10` | Group history buffer size |
| `media.enabled` | boolean | `true` | Rich media understanding on/off |
| `media.maxMB` | number | `200` | Rich media download cap (MB) |
| `media.ttlHours` | number | `24` | Rich media lifetime (hours), 0 means forever |
| `vision.enabled` | boolean | `false` | Vision understanding on/off |
| `vision.provider` / `vision.model` | string | - | Vision model provider and model |
| `sendFile.restrictPaths` | boolean | `true` | Path allowlist for file sending |
| `sendFile.extraRoots` | string[] | `[]` | Extra roots allowed for file sending |

### Speaking up on her own

With `proactive.enabled` on, group messages that do **not** @-mention her go through a local decision first (zero tokens, no model call):

| Signal | Effect |
|---|---|
| Question forms, help words, mentions of "肥鱼 / 鲸鱼" | score up |
| Filler noise ("哈哈", "666", "打卡"…) | score down |
| The message @-mentions someone else | score down (that turn belongs to them) |
| Too short, or only emoji | not answered at all |

Only messages that pass the gate wake the model — and the model judges once more, answering `[skip]` to stay silent.

Decisions are logged to `~/.dsh-qqbot/proactive-scores.jsonl`, one JSON object per line (score, reason, whether the cooldown blocked it) — tune `minScore` from there.

> Note: "not @-mentioned" is **not** a penalty — that is exactly the case where she should speak up. The penalty is for "@-mentioning somebody else".

### Where things live

```
profile  <DSH_HOME>/profiles/<profile>/cordis.patch.yml   # the im-qqbot entry
local    <HOME>/.dsh-qqbot/                               # decision log, startup trace, model prefs
```

## Built-in commands

| Command | Meaning |
|---|---|
| `/new` (aliases `/reset`, `/clear`) | Start a new session (clears context) |
| `/compact` | Compact the session history (summary replaces old records, context preserved) |
| `/model` | Show or switch the model |
| `/preset` | Show the current preset (fixed to `qqchat`, cannot be switched) |
| `/stop` | Abort the current generation |
| `/bot-ping` | Measure network latency (transport and processing time) |
| `/bot-version` | Show version info |
| `/bot-status` | Show current session status |
| `/bot-help` | List every command |

## Internals

- The host half serves same-origin routes under `/qqbot/im-qqbot/*` (bind state, QR code, manual entry, config read/write); local same-origin requests only
- The client half registers `settings.section` (order 7, label "QQ 机器人") plus a right-sidebar tab "QQ 机器人绑定"; the tab opens itself while unbound
- Inbound: `historyBuffer` sits **before** the gate, so group messages are recorded in memory in full (including those that never @-mention her); `mentionGate` only marks, and `proactiveGate` does the blocking
- Decisions come in two layers: L1 is a local lexical gate (zero tokens) that drops the obviously unworthy; L2 is the model deciding in-turn whether to speak
- Outbound: `session/event` → `sendMarkdown`, with a human-ish delay first; a reply that is exactly `[skip]` is never sent
- Session key `qqbot:${appId}:${kind}:${peerId}` keeps private and group chats naturally separate
- All visuals use `--dsw-alias-*` tokens; no hard-coded colours

Details in [docs/内部机制.md](docs/内部机制.md).

## Version line

**This plugin is for personal use and stays on `0.1.x`**: `0.x` means "initial development, no compatibility promised" — configuration, interfaces and UI may still change. By SemVer:

- `0.1.0` → `0.1.1` → `0.1.2`: fixes and small changes within one design;
- `0.2.0`: a new design (config format or interfaces incompatible), requiring migration of existing configuration;
- when to reach `1.0.0`: **only once somebody else starts depending on this plugin's config format and interfaces**.

Host compatibility across DSH upgrades is not decided by this plugin's version number, but by `engines.dsh` / peerDependencies declarations and the host's version-exemption mechanism.

## Known limitations

- Only **one** QQ bot is supported so far; the multi-account design is in [docs/多机器人.md](docs/多机器人.md) (not implemented yet)
- Proactive speaking covers "joining a group conversation" only — no scheduled posts and no proactive private messages
- Sticker packs are not supported yet (design in [docs/拟人化路线图.md](docs/拟人化路线图.md))
- **No streaming in group chats** (QQ has no streaming API for groups); only private chats stream
- Vision needs a vision provider and model configured; it is off by default
- The settings panel hard-codes Chinese copy; i18n is not wired up yet
- Depends on the QQ Open Platform's group message delivery: the bot only receives messages the platform pushes to it

## Development

```sh
pnpm install
pnpm build              # tsc + tsdown
pnpm typecheck:client   # type check for the browser half (the main tsconfig skips src/client)
pnpm test               # vitest: 170 cases
```

Docs:

- [docs/内部机制.md](docs/内部机制.md) — architecture and implementation notes
- [docs/自主接话.md](docs/自主接话.md) — how the decision and speaking work
- [docs/拟人化路线图.md](docs/拟人化路线图.md) — the persona roadmap
- [docs/多机器人.md](docs/多机器人.md) — multi-account design

## License

MIT

Reworked from [tencent-connect/dsh-qqbot](https://github.com/tencent-connect/dsh-qqbot) (MIT); the original copyright notice is kept in [LICENSE](LICENSE).

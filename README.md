# dsh-session-assets

[中文](README.md) · [English](README.en.md)

给 [DeepSeek Harness (DSH)](https://github.com/deepseek-ai/deepseek-harness) Web 界面补上**会话文件资产**能力的插件：**对话卡片直接下载**、主内容区**「文件」标签页**、右侧栏**「会话文件」面板**、预览抽屉**下载入口**，生成的文件自动归档到 session 自己的目录里，**随 session 一起删除**。

> 一个包同时提供宿主端（`lib/index.js`）与浏览器端（`lib/client.js`），零第三方依赖、无构建步骤；既能从 npm 一键安装，也能本地路径运行（开发时改码即时热载）。

## 为什么需要它

DSH Web 原生的文件交互只有两样：**侧边栏预览**和**在宿主桌面打开**——后者在远程访问时通常直接不可用，而且任何地方都没有「下载」。这个插件补齐下载链路，并把"这个对话产生了哪些文件"变成一个可浏览、可下载的清单：

| 入口 | 位置 | 说明 |
|---|---|---|
| ⬇ 下载按钮 | 对话里 `present` 出的文件卡片 | 不依赖宿主桌面，远程访问照常可用 |
| **「文件」视图** | 对话主内容区 tab（「对话」旁） | 本会话产出的全部文件，逐行下载 |
| **「会话文件」面板** | 右侧栏 tab（指南入口） | 与主视图同一数据源 |
| 预览抽屉下载 | 文件预览头部动作区 + 「该格式文件暂时无法预览」空状态 | 可预览的（csv/文本/图片）与不可预览的（zip 等）都有下载 |

列表行带徽标区分来源：**已归档**（assets 目录副本）、**未归档**（`present` 交付但源文件不可再拷贝）、**已生成**（`write`/`edit` 等变更工具的持久产出）、**已不存在**（源文件已删除）。

## 安装

### 方式一：插件管理器（推荐，发给别人就用这条）

包已发布到 npm：**`dsh-session-assets`**。两条路任选：

- **UI**：设置 → 插件 → 「添加插件」→ 输入 `dsh-session-assets` → 安装
- **CLI**：`dsh plugin --profile web add dsh-session-assets`

安装器（本质是 `pnpm add`）把包放进 profile 的 `node_modules/`，并应用包自带的 `cordis.patch.yml`（就是下面那个 insert 条目），即装即生效；升级 = 先卸载再安装新版；卸载在插件页一键完成。

> 本包是**组合包（bundle）**，package.json 声明了 `dsh.bundle.patch`——这正是「添加插件」UI 的硬性要求；同时保留了 `dsh.client` 双面声明，浏览器端 bundle 由 DSH 的模块系统运行时下发，无需构建。

### 方式二：本地路径（开发用，改码即时热载）

```bash
git clone https://github.com/louis-she/dsh-session-assets ~/.dsh/profiles/web/plugins/session-assets
```

然后在 `~/.dsh/profiles/web/cordis.patch.yml` 末尾追加：

```yaml
- insert:
    - id: session-assets
      # 必须是 file: URL 指向 lib/index.js，两个坑都踩过：
      #  - 目录路径 → Node ESM 拒绝（ERR_UNSUPPORTED_DIR_IMPORT）
      #  - 裸绝对路径 → client-modules 扫不到 client bundle（宿主加载了但浏览器不装载）
      name: "file:///Users/<you>/.dsh/profiles/web/plugins/session-assets/lib/index.js"
      config: {}
```

保存即生效：`dsh-hmr` 监听该 patch 文件，宿主端秒级重建，浏览器经 `/plugins/events` SSE **免刷新**装载新的 client bundle。

### 可选配置

```yaml
      config:
        sessionsRoot: ~/dsh-sessions   # 资产归属的会话根目录；默认取持久化根（~/.dsh/sessions）
```

### 卸载

- 插件管理器安装的：插件页一键卸载，或 `dsh plugin --profile web remove dsh-session-assets`
- 本地路径注册的：删除上面的 `insert` 条目（浏览器再刷新一次即可），需要的话连包目录一起删

已归档资产留在各 session 目录内，归 session 所有，不随插件删除。

## 架构

```
浏览器 (lib/client.js)                        宿主 (lib/index.js, cordis 插件)
├─ 卡片按钮  ──HEAD+GET──▶ /api/session.assets.present?sessionId&seq&index
├─ 预览抽屉  ──HEAD+GET──▶ /api/session.assets.file?sessionId&path
├─ 文件列表  ────GET─────▶ /api/session.assets.list?sessionId
│    ├─ 归档资产   <──────  <sessionDir>/assets/  (manifest.json)
│    ├─ present 交付 <────  deliverables/presented 事件
│    └─ 已生成产出 <──────  tool/call + tool/result 事件（日志持久推导）
└─ 列表行下载 ──HEAD+GET──▶ /api/session.assets.download?sessionId&name

session/event(deliverables/presented) ──▶ 自动复制源文件到 <sessionDir>/assets/
```

**资产存储布局**（与 session 持久化同构，删除 session 目录即删除资产）：

```
~/.dsh/sessions/<projectKey(cwd)>/<encodeSegment(sessionId)>/
├── session.v4.jsonl.zstd      # DSH 自有
├── session.lock
└── assets/                    # 本插件
    ├── manifest.json          # {seq, index, source, name, bytes, mtimeMs, description}
    └── <归档副本…>
```

`encodeSegment` / `projectKey` 等价复刻自 `dsh-session-persistence-jsonl`（已与真实会话目录逐一比对），并带 `cwd` 缺失时的目录扫描回退。

## 安全模型

- **所有路由都在 Connection 的认证栅栏内**：浏览器普通 GET 自动携带签名 cookie（与官方 `/api/session.export` 同一机制），无需 token 拼接。
- **文件读取权限与预览一致**（"可读即可下"），与 DSH 自己的 `workspaceFiles` 读取语义相同；暴露边界是 cookie。
- `download` 的 `name` 参数拒绝任何路径穿越（必须是单段文件名）；`file` 路由拒绝 NUL。
- 流式响应（`Readable.toWeb(createReadStream(...))`），**没有大小上限**，也不在内存中缓冲整个文件。

## 开发

```bash
node test/smoke.mjs         # 宿主端：mock 上下文，覆盖全部路由、事件归档、幂等、穿越拒绝
node test/client-smoke.mjs  # 浏览器端：stub react/DOM，真跑 apply、注册面与组件点击路径
```

热更新规则（本插件开发时反复依赖的两条）：

- 改 `lib/client.js` → `dsh-client-hmr` 每 500ms 轮询 bundle 元数据，SSE 推送，**浏览器免刷新**。
- 改 `lib/index.js` → 改文件本身**不会**热重载，需再触碰一次 `cordis.patch.yml`（改注释即可）触发 reconcile 重建。

自检文件（本部署 stdout/stderr 被丢弃，排障看这里）：

- `.state.json` — 加载时间、收到的配置、注册的路由
- `.log` — 诊断日志（路由错误、归档失败等）

浏览器侧验证：

```bash
curl -N http://127.0.0.1:3080/plugins/events          # SSE 图谱，应含 {"id":"dsh-session-assets",...}
curl "http://127.0.0.1:3080/plugins/??dsh-session-assets/client.js&rev=<rev>"   # bundle 本体
```

## 设计取舍

- **资产放在 session 目录内**，而不是独立的资产根：`sessionDir` 源码注释明确写着它"留给 session 本地工件"，且 DSH 当前没有公开的 session 磁盘删除 API（`session/disposed` 在进程退出时同样触发，不可靠）——放在 session 目录里，"删 session 即删资产"由文件系统天然保证。
- **下载走 HTTP 路由 + anchor**，而不是 `workspaceFiles.readBytes`：后者单文件 32MB 上限且需在浏览器内缓冲；流式路由无此限制。
- **list 路由只做一次全量观察 + 10s 缓存**：`SessionCorpus.load` 本身无缓存，逐事件 `readEvent` 是二次方复杂度（曾在 1.7MB 会话上跑出 79.5 秒、拖垮整个 Web）；改为单次 `readSession` 后冷读 <1s，任意会话事件使缓存失效。
- **「已生成」从日志推导**，而不是依赖 `workspace/changes` 内存摘要（重启即失）：复刻 deliverables 的 `write`/`edit`/`str_replace_editor` 成功判据，持久且与官方口径一致。
- **主视图用全新 id `session-files`**（`chat`=0、`trajectory`=10、本插件=20），绝不复用原生 id（复用会顶替原生 tab）。

## License

[MIT](LICENSE)

# 08 · Chrome AI Conversation Watcher

本目录是 Version-C 的 Chrome 网页测量通道。扩展观察 ChatGPT 与 Claude 网页端的
对话切换、输入开始、发送、回答状态、离开、返回与再次参与，并把不含正文和原始
网址的事件写入本机 ActivityWatch：

- `aw-watcher-ai-conversations`：对话与通知生命周期；
- `aw-watcher-study-sessions`：参与者从工具栏开始、结束或取消的实验时间窗。

代码与 mocked Chrome/ActivityWatch 合成测试已经覆盖本文件所述协议。0.2.1 起，未部署
Native Host 的 unpacked checkout 会自动使用浏览器本地身份权威，因此网页端稳定对话键、
后台完成通知和原标签页点击返回不再依赖参与者编号或 Native Host。0.2.2 进一步修复真实
identity 内部 `provider` 字段被严格通知 ingress 拒绝的问题：通知请求现在只投影五个允许的
opaque identity 字段。0.2.3 为被拒绝的通知请求补充无敏感信息诊断，使 completion event
的 ENQUEUE 回调中断不再阻断通知 effect，并覆盖 ChatGPT 新对话从 root URL 绑定 canonical route
时 sender/tab URL 短暂不同步的情况。0.2.4 将通知预览上限固定为回答开头最多 150 个 Unicode
字符，并把扩展主动清除时间从 8 秒延长到 20 秒。0.2.5 修复真实 ChatGPT 流式回答只缓存
开头 3 个字的问题：监听同一文本节点内的逐字更新，从回答正文 `.markdown` 读取不依赖
前后台布局的 `textContent`，并在正文继续增长时重新计算 quiet window；同时仍以消息
identity 识别“总数未增加但最新回答已经替换”的情况。**真实 Chrome、两个
线上站点、macOS 横幅与 ActivityWatch 的 Reload 后端到端验证仍需人工完成**；不能用
单元测试通过代替 pilot 可用证明。

0.2.6 修复 ChatGPT 同一标签页经 SPA 从对话 A 切到 B 后，Chrome 的 `MessageSender.url`
仍停留在 A、而实时 `sender.tab.url` 已是 B，导致 B 的 exact identity 被拒绝并出现
`tracker_notification_failed / identity_not_exact` 的问题。实时 tab route 仍必须与请求的
canonical 对话 ID 完全一致；滞留的 document URL 只在同一 allowlisted provider 的 root
或 canonical route 时可兼容，因此不会回退到按标题、正文或时间猜测身份。

0.2.8 修复带网页搜索引用的 ChatGPT 回答预览：真实页面的
`[data-testid="webpage-citation-pill"]` 会同时保留引用域名、来源数量和动画切换层，直接读取
`textContent` 会把这些标签重复拼接并挤占 150 字正文。adapter 现在只在临时 DOM 副本中
删除引用徽章，再提取回答正文；不会修改真实页面，也不会改变“预览只进入瞬时系统通知、
不进入任何持久层”的边界。

## 当前功能

| 功能 | 记录结果 | 关键边界 |
|---|---|---|
| 对话身份 | Native authority 或浏览器本地 HMAC authority 签发的 64 位十六进制 `conversation_key` | 只接受 canonical route ID；不按标题、正文或时间猜测 |
| SPA 切换 | `conversation_bound`、foreground/background、A→B→A | Navigation API、history、pop/hash 与无 Navigation API fallback |
| 用户动作 | `input_started`、`prompt_submitted` | 不读取或保存字符内容 |
| 回答状态 | started/completed/failed/cancelled | selector 不可靠时写 unhealthy，不按时长猜完成 |
| 返回与参与 | `user_returned`、`user_interacted`、`user_engaged` | 系统事件只是导航/动作证据，不代表理解 |
| 研究通知 | 最后回答开头的临时 150 字预览；suppressed/attempted/created/clicked/auto-cleared/failed | 预览不持久化；`created` 不等于 macOS 一定显示横幅 |
| 通知回访 | 两种模式均验证原 tab；只有已部署 Native Host 时才允许缺失 tab 的 `prepare_reopen` | 浏览器本地模式绝不凭空重开已关闭 tab |
| 可靠写入 | 本地队列、重试、严格 source UUID 去重 | ActivityWatch 仅允许 loopback |
| 实验会话 | start/stop/cancel marker、重启恢复、90 分钟提示 | 对话事件与 session marker 使用不同 bucket |
| 参与者编号 | Options/Popup 只读显示包内 `participant_config.json` | 缺失时采集继续但导出阻断；编号绝不进入 ActivityWatch 事件 |

参与者专属包内唯一编号真源是 `participant_config.json`，格式固定为
`{"schema_version":"1.0","participant_id":"P01"}`，其中编号只能是 `P` 加
2–4 位数字。开发源码目录故意不带该文件，UI 会显示“未配置”；研究者必须使用根目录
生成器产生一人一包，不能手工在 Chrome storage、启动器或 ActivityWatch 中补编号。

## 隐私边界

ActivityWatch 事件统一标记 `privacy_tier=content_free_local`。持久事件不包含：

- prompt、response、键入字符或剪贴板；
- 页面标题、对话名称或侧边栏内容；
- provider conversation ID、完整 URL、query、fragment；
- `locator_handle`、authority receipt、notification ID；
- Cookie、Token、OAuth 凭据或浏览历史。

为让参与者能判断是哪一轮回答完成，adapter 在 completion 当刻读取最后一条助手回答，
去除控制字符、压缩空白并截到最多 150 个 Unicode 字符，只把结果交给
`chrome.notifications.create()` 作为短暂通知正文。该片段不进入状态机 event、可靠队列、
`chrome.storage.local` notification target、ActivityWatch、诊断、Native Messaging 或研究
导出；通知在 20 秒到期或点击后清除。不过正文仍可能被 macOS 通知中心、锁屏或屏幕共享
短暂显示，因此它是**展示隐私面**，不能再把整个扩展描述为“从不读取回答正文”。

当页面 URL 严格匹配 ChatGPT `/c/<id>` 或 Claude `/chat/<uuid>` 时，content 从当前
页面提取 provider ID；background 只用 Chrome 提供的 sender/tab URL 在内存中再次核对
host、canonical route 与 ID。**完整 URL 不进入 content→background request，也不跨越
Native Messaging 边界**。若 production Native authority 已 provision，则只把 provider 与
canonical provider ID 交给该 authority；否则浏览器本地 authority 用每个 Chrome 安装首次
生成的 256-bit 随机密钥做 HMAC-SHA-256，产生稳定 opaque key 与 locator handle。随机密钥
只保存在扩展本地 storage，provider ID 与完整 URL 均不写入该 storage、ActivityWatch、
诊断或通知 target。authority 返回后，content 只保留 opaque `conversation_key`、
`locator_handle` 与 namespace pair。
旧队列迁移会按
event type 的闭合 metadata 契约重新构造事件：任一 metadata key/value 无法证明安全，
整条旧事件即拒绝；不会把自由文本挪进一个“允许的”metadata key。`acknowledged` 只接受
UUID v4 `source_event_id`。

## 双层 identity authority 协议

### 默认浏览器本地 authority

当 `src/authority_provisioning.js` 没有完整、匹配当前 extension ID 的 production 配置时，
background 自动初始化 `browser-local-v1.<随机 namespace>`。同一安装内，同一 canonical
ChatGPT/Claude 对话跨刷新、重启和 A→B→A 都得到同一 key；不同对话得到不同 key。Reload
扩展不会轮换 namespace，但移除扩展或清除扩展数据会删除本地密钥，因此正式实验中不得
卸载重装或清除扩展数据。

浏览器本地 `exact` 表示“在当前 Chrome 本地 namespace 内由 canonical route 精确解析”，
不表示它能与 macOS 原生 App、另一个 Chrome profile、另一台电脑或重新安装后的 namespace
自动关联。regular export 只能在同一 namespace 内做跨时间对话分组。

浏览器本地通知点击会在聚焦前后两次核对原 tab 的 opaque key、locator 与 namespace。
原 tab 已关闭、已切换到另一对话或 context 不匹配时固定失败；该模式不保存 raw URL，也不
允许从 storage 拼接网址重开。

### 可选 production Native authority

content script 不是 production identity authority。可选 Native 路径的
`src/authority_provisioning.js` 只接受下列部署值：

```text
native_host_name=org.chi27.attention.browserbridge
expected_extension_id=<固定的 32 位 Chrome extension ID>
namespace_generation=<正整数>
namespace_fingerprint=<冻结 namespace 指纹>
authority_public_key_x963_base64=<65-byte uncompressed P-256 public key>
```

生产 checkout 中后四项保持空值/0 是有意的；这会选择浏览器本地 authority，而不是使
网页功能停摆。只有配置字段全部合法且 runtime extension ID 精确匹配时，扩展才进入
production Native 模式；进入该模式后，native host 不可用、超时或 receipt 无效仍然
fail closed，不在同一研究场次中静默切换 namespace。不要为“让测试变绿”自行伪造
production key 或临时 Native namespace。

Native host 对每个 issued response 返回 receipt：

```text
receipt.payload   = base64(UTF-8 canonical JSON)
receipt.signature = base64(P-256 ECDSA SHA-256 DER signature)
```

`resolve_web_conversation` 请求只有 common envelope
（`schema_version/type/request_id/provider/surface/client_nonce/extension_id/namespace_*`）
加 `provider_conversation_id`，不允许 `full_url`。`validate_web_locator` 则加
`conversation_key` 与 `locator_handle`，不含 provider ID 或 URL。

同一个 signed Native Messaging bridge 还提供 closed-schema reopen 协议。它只能由用户点击
研究通知触发；后台、alarm、启动恢复与页面 announcement 都无权调用 `prepare_reopen`。只有 Chrome 明确确认原 tab 不存在时才进入原生重开；任意未知 `tabs.get` 错误均 fail closed，不得当作 tab 缺失：

```text
prepare_reopen = common envelope + conversation_key + locator_handle
confirm_web_reopen = prepare fields + attempt_id
reopen_status = common envelope without provider/key/handle + attempt_id
```

其中 confirm 的 provider/key/handle 是新 tab 当下 observation。`attempt_id` 严格匹配
`^rpa_[A-Za-z0-9_-]{22}$`。prepare 只有 native launcher 已接受动作时才返回 signed
`status=attempted`；这绝不代表页面已打开或 focus 成功。confirm 只有 observation 与 prepare
时 target 完全一致才返回 signed `confirmed`；`failed`/`expired` 使用闭合的 content-free
reason。`unavailable` 只接受 `authority_unavailable`、`locator_rejected` 或
prepare 的 `unavailable` 只接受 10 端实际可能返回的固定枚举：
`authority_unavailable`、`locator_rejected`、`namespace_mismatch`、
`identity_mismatch`、`handle_conflict`、`capacity_exceeded`；confirm/status 则只接受
`authority_unavailable` 或 `attempt_not_found`。未知 status、自由文本 reason、字段、
namespace、attempt 或签名一律拒绝。

三种 reopen receipt 共用同一个 canonical payload：

```text
attempt_id, client_nonce, conversation_key, extension_id, locator_handle,
namespace_fingerprint, namespace_generation, provider, request_id,
schema_version, status, surface, type
```

confirm/status 的 receipt 仍绑定 **prepare 时的 target**，而不是把错误 observation B
重新解释为 target。扩展只在 service worker 内存中保存 `attempt_id → target`；terminal、
timeout 或 worker 丢失即删除，绝不把 nonce/receipt 写入 storage、日志或 ActivityWatch。
`reopen_status` 客户端只为协议完整性提供一次性显式调用；通知流程不轮询它。

`locator_handle` 必须严格匹配 `^loc_[A-Za-z0-9_-]{22}$`：`loc_` 后是 16-byte 随机值的
无 padding base64url。错误长度、`=` padding、非 base64url 字符均拒绝；resolve 响应的
handle 还不得等于或包含本次 canonical provider ID。

payload 是闭合 schema，键按字典序排列，且逐字段绑定：

```text
client_nonce, conversation_key, extension_id, locator_handle,
namespace_fingerprint, namespace_generation, provider, request_id,
schema_version, surface, type
```

浏览器要求 payload 字节与 canonical JSON 完全相同，拒绝空白变化、额外字段、重复键、
换序、错绑字段、非 canonical DER、1-byte/畸形签名或错误签名；随后用 provisioned P-256
public key 独立验签。Swift host 应用 `P256.Signing.PublicKey.x963Representation` 发布公钥，
并用 `P256.Signing.ECDSASignature.derRepresentation` 输出签名，与这里的 wire contract
一致。receipt 失败不会降级成“看起来像 exact”的本地 key，而是 provisional。

### Native parity 的部署阻塞项

在进行真实 Web/App 同 namespace 与 closed-tab reopen smoke 前，部署负责人必须共同冻结并核对：

1. release extension ID；
2. namespace generation 与 fingerprint；
3. authority P-256 public key；
4. native host 可执行文件、native-messaging manifest 与安装位置；
5. host manifest 的 `allowed_origins` 只包含
   `chrome-extension://<同一个固定 ID>/`；
6. native host 按上述 canonical receipt 协议签名 `resolve_web_conversation` 与
   `validate_web_locator`。

未完成这些动作时，网页端仍可用浏览器本地 exact identity、通知和现存 tab 回访；但不能
声称 Web/App 跨 surface 使用同一 key，也不能在原 tab 已关闭时做 verified native reopen。

## 通知回访的成功定义

回答在后台完成后，通知先经过 notifications-enabled、active study session、当前
response/session authorization 与 exact identity gate。通知 payload 使用固定标题和最多
150 个字符的最后回答预览；取不到预览时使用“回答已完成。点击返回对应对话。”。payload
不含 URL、provider conversation ID、locator 或 notification target，20 秒后尝试自动清除。
预览只用于系统展示，不属于可分析或可导出的研究数据。

点击通知先检查**原来的现存 tab**。持久 target 必须有非负整数 `tab_id` 且
`target_status=ready`；旧数据中的 null、字符串、负数或其他非法 tab ID 会被 sanitizer
标为 `unavailable`，点击后不会调用 native prepare。若原 tab 仍存在，就只走原有的 focus 前后四字段核对；
原 tab 存在但已切到 B、context 不可读或 namespace 改变时直接失败，不调用 reopen。只有
`chrome.tabs.get` 返回与该整数 tab ID 精确匹配的 Chromium `No tab with id: <id>.`
错误时，才把三态 lookup 从 unknown 改为 missing。浏览器本地模式在此停止；production
Native 模式才通过 Native Messaging 发起 reopen；
null callback、权限错误、未知错误、前后空白或其他近似字符串均 fail closed。扩展自身永不调用
`tabs.create(URL)` 或 `windows.create(URL)`，也不从 storage 拼装 URL。

原 tab 路径一次 `focus_succeeded=true` 必须同时满足：

1. focus 前，content live response 的 key、locator、namespace generation/fingerprint
   与持久 target 四字段完全一致；
2. 激活 tab/window 后再次读取，四字段仍完全一致（防 A→B TOCTOU）；
3. production Native 模式还必须发送不含 raw ID/URL 的 `validate_web_locator`，并收到
   验签通过的 exact echo；浏览器本地模式则要求 namespace 明确为 `browser-local-v1.*`。

缺失 tab 路径只对 production Native 模式开放。一次 `focus_succeeded=true` 必须同时满足：

1. 这次操作来自 notification click 的显式用户手势；
2. signed `prepare_reopen` 返回 `attempted`，且 attempt/namespace/target receipt 全部通过；
3. 只做一次前后 tab query，并事件驱动地等待新建/更新 tab 或 content 的 opaque exact
   announcement，不做后台轮询；
4. bounded timeout 内看到同 provider 的 exact A，并把 observed identity 送入
   `confirm_web_reopen`；
5. confirm receipt 仍绑定 prepare target A 且状态为 `confirmed`；
6. 激活 tab/window 后重新读取 live context，仍为同一个 A。

只完成了 launcher 接受或 tab 激活都属于 attempted，不是成功。B/mismatch、namespace
rotation、bridge 不可用/超时、receipt 错签、focus 后变化或 locator 不一致都固定记录
`focus_succeeded=false`。同一 notification 的重复 click 共享一个 in-flight Promise；失败
settle 后才允许新 attempt，旧 attempt ID 不会被新 attempt 接受。A/B/A 的不同通知各用新的
attempt，绝不复用 receipt 或 nonce。target 只保留到原 20 秒截止。系统无法证明横幅被
macOS 实际绘制，所以
`tracker_notification_created` 也不能表述成“用户已收到通知”。

## 事件结构

ActivityWatch 外层固定为：

```json
{"timestamp":"<occurred_at>","duration":0,"data":{"...":"..."}}
```

`data` 允许字段：

```text
schema_version=1.0
source_event_id=<UUID v4>
occurred_at
observed_at
provider=chatgpt|claude|watcher
surface=chrome
event_type
conversation_key
identity_status=exact|provisional|unknown
namespace_generation        # exact 时存在
namespace_fingerprint       # exact 时存在
confidence=exact|derived|heuristic
source_adapter
adapter_version
privacy_tier=content_free_local
previous_conversation_key   # bind 时可存在
metadata                    # 按 event_type 的闭合 key/value 契约
```

常用 event type：

| 类别 | event type |
|---|---|
| 健康 | `watcher_started`, `watcher_heartbeat`, `adapter_unhealthy` |
| 对话 | `conversation_foregrounded`, `conversation_backgrounded`, `conversation_bound` |
| 轮次 | `input_started`, `prompt_submitted`, `assistant_response_started`, `assistant_response_completed`, `assistant_response_failed`, `assistant_response_cancelled` |
| 返回 | `user_returned`, `user_interacted`, `user_engaged` |
| 通知 | `tracker_notification_suppressed`, `attempted`, `created`, `failed`, `clicked`, `auto_cleared` |

## 安装与用户操作

1. 启动 ActivityWatch，确认浏览器能打开 `http://127.0.0.1:5600`。
2. 打开 `chrome://extensions`，开启右上角“开发者模式”。
3. 点击“加载已解压的扩展程序”，选择本目录
   `08_Chrome-AI-Conversation-Watcher/`。
4. 在扩展卡片核对名称为 `CHI27 AI Conversation Watcher`、版本为 `0.2.8`，记录卡片显示
   的 ID。浏览器本地模式不要求参与者填写该 ID；只有 production Native 部署才要求它与
   `expected_extension_id`、native host `allowed_origins` 完全一致。
5. 卡片的 `Inspect views` 下点击 `service worker`。DevTools 顶部/来源树应指向本扩展的
   `background.js`；仅看到“某个 extension service worker”不能算通过。Console 不应有
   manifest 或初始化错误。
6. 点击扩展卡片“详情”→“扩展程序选项”，保留默认 loopback 地址和两个不同 bucket
   ID，确认回答完成通知已勾选，点击“测试 ActivityWatch”。成功提示必须同时列出两个 bucket。
7. 正式研究采用 `tracker_standardized`：分别打开 `chatgpt.com` 与 `claude.ai`，点击地址栏
   左侧的网站控制图标→“网站设置”→“通知”→“阻止”。这只阻止两个网站的第一方通知；
   不要关闭 macOS 的 Chrome 通知，也不要关闭本扩展的回答完成通知。扩展没有
   `contentSettings` 权限，不会代替操作者暗中修改这些网站设置。
8. 把扩展固定到工具栏。任务开始前点击图标→“开始本次实验”；完成后点击→“结束本次
   实验”；误启动则“取消并标记无效”。显示“等待 ActivityWatch 同步”时恢复
   ActivityWatch，队列会重试。
9. 不启用无痕访问，除非后续研究协议另有明确规定。

加载 unpacked checkout 后会自动建立浏览器本地 namespace。若 canonical 对话仍长期保持
provisional，应先 Reload 扩展并刷新 provider 页面；这与参与者编号、ActivityWatch 连接
和网站自己的通知权限是三件不同的事。

## 最小数据检查

先开始 Study Session，在 ChatGPT 或 Claude 做一个不含敏感内容的 smoke：打开对话、
输入、发送、等待回答、切走再返回。随后只读取安全投影：

```bash
curl -sS --get \
  'http://127.0.0.1:5600/api/0/buckets/aw-watcher-ai-conversations/events' \
  --data-urlencode 'limit=100' \
  | jq '[.[] | {
      timestamp,
      event_type: .data.event_type,
      provider: .data.provider,
      conversation_key: .data.conversation_key,
      identity_status: .data.identity_status,
      previous_conversation_key: (.data.previous_conversation_key // null),
      metadata: .data.metadata
    }] | sort_by(.timestamp)'
```

最小通过条件：

- 能看到 `watcher_heartbeat`；
- 同一浏览器本地或 Native namespace 内，同一对话多轮使用同一 exact key，A→B→A 回到
  A 仍为原 key；
- 输入与发送各出现一次，事件 JSON 中没有 smoke prompt；
- raw 检查中不存在 `http://`、`https://`、`provider_conversation_id`、`full_url`、
  `locator_handle` 或 `receipt`；
- 用一个不含敏感信息、可辨认的 smoke 回答核对通知正文确为其开头片段，同时在
  ActivityWatch raw、扩展 storage、诊断与研究导出中搜索该片段应为 0；
- 通知点击只有经过 focus 前后 live context 核对才能为 true；Native 模式还必须通过
  native postcondition。

不要把未过滤的本机 ActivityWatch 输出粘贴到 issue、聊天或共享研究材料。

## 合成测试

无需安装依赖：

```bash
cd "03 Study Design/Version-C_Platform/08_Chrome-AI-Conversation-Watcher"
npm test
```

测试覆盖 receipt 正确/错签/畸形/非 canonical/逐字段错绑、空 provisioning、native
timeout、metadata 与 acknowledged canary、SPA pushState/replaceState/A→B→A、Navigation
API 缺失、通知 focus 前后 TOCTOU/namespace/bridge postcondition、缺失 tab 的
prepare→A confirm/B mismatch/timeout/rotation/invalid receipt/bridge unavailable/重复 click/
raw canary，以及既有状态机、
ActivityWatch 队列、Study Session、Chrome notification 生命周期。测试数与 PASS 结果以
本次命令输出为准；它仍不能替代下面的真机验证。

## Pilot 前必须完成的真机 smoke

分别在 pilot 使用的 Chrome 版本、ChatGPT 与 Claude 当前线上页面执行并记录日期、版本
和结果：

1. 用 0.2.8 部署包 Reload，逐个刷新已打开的 provider tab；分别记录实际采用
   `browser-local-v1.*` 还是 frozen Native namespace。
2. service worker Console 无错误；设置页 ActivityWatch 双 bucket 测试通过。
3. canonical route 获得 exact key；浏览器本地模式验证 Reload 后 key 不变，Native 模式
   另验证 receipt 错签 fail closed。
4. A→B→A 后 A key 一致；生成中导航写 observation gap，不伪造 completed。
5. 输入、提交、started/completed、cancelled 各做一次；failed 无法安全复现时标未测。
6. 后台完成时区分 attempted、Chrome API created 与肉眼看到 macOS 横幅三层证据；横幅
   正文 payload 应与最后回答开头一致且最长 150 字；macOS 横幅可能受系统布局进一步截断，
   锁屏显示风险已向参与者说明。
7. 点击时测试：两种模式都做原 tab 仍为 A（成功）及 focus 中 A→B（失败）；浏览器本地
   模式原 tab 已关闭必须失败且不新开页面。只有 Native 模式再做 closed-tab prepare→A
   exact confirm、B/mismatch、namespace mismatch、host 停止/超时/错签。
8. 不点击通知，确认 20 秒后仅一次 auto-cleared；ActivityWatch 断开/恢复后同一 source ID
   只写一次。
9. 按“最小数据检查”确认所有持久层与 ActivityWatch 都没有 raw URL/ID canary 或回答
   preview canary；只有 `chrome.notifications.create()` 的瞬时 payload 可以含 preview。

截至 2026-08-04，0.2.3 的真实 ChatGPT Web→ActivityWatch→Chrome notification 链已观察到
`assistant_response_completed → tracker_notification_attempted → tracker_notification_created →
tracker_notification_auto_cleared`，且肉眼看到研究通知横幅。0.2.4 已由用户肉眼确认自制通知
能够显示，但先后暴露“正文退回固定文案”和“流式预览停在开头 3 个字”两个问题。0.2.5
已用真实页面结构核对 `.markdown` 与稳定 message ID；Reload 后又从真实 ActivityWatch
记录定位出 SPA A→B 造成 `identity_not_exact`，0.2.6 已加入对应修复与回归。0.2.6 的
自制通知已经在真机恢复，但带网页引用的回答暴露引用徽章重复占满预览。0.2.8 已根据真实
页面的 `webpage-citation-pill` 结构加入过滤，自动回归为 193/193 PASS；过滤后的 150 字正文
仍须 Reload 后做一次真机视觉复测。Claude 的同版本链路也仍需单独复测。自动测试不能
替代真机验证。

## 目录

```text
manifest.json                 MV3 权限与脚本入口
background.js                 AW、可靠队列、session、通知与 authority bridge
content.js                    identity、状态机、adapter 与 live opaque context
popup.*                       实验会话控制
options.*                     loopback ActivityWatch 设置与测试
src/authority_provisioning.js fail-closed 部署信任根
src/authority_client.js       native wire、receipt canonicalization 与 P-256 验签
src/local_web_authority.js    浏览器本地 HMAC identity fallback
src/route_observer.js         SPA 导航观察与 fallback
src/core.js                   event/metadata 持久契约与 legacy sanitizer
src/identity.js               provisional 与 authority-issued exact identity
src/ingress.js                sender/content event 边界重建
src/state_machine.js          content-free 行为状态机
src/reliable_queue.js         重试与 source_event_id 去重
src/session_controller.js     Study Session 严格契约
src/adapters/                 ChatGPT / Claude DOM adapter
tests/                        Node 与 mocked MV3 生命周期测试
```

## 权限

- `nativeMessaging`：仅在 production Native 模式向固定 host 请求/验证 opaque identity；
- `storage`：设置、可靠队列、session、response binding 与 opaque notification target；
- `notifications`：创建本扩展研究通知；
- `alarms`：heartbeat、队列重试、session 提示与通知清理兜底；
- provider host permissions：只在 ChatGPT/Claude 页面运行；
- loopback host permissions：只访问本机 ActivityWatch 5600 端口。

没有申请 `history`、`cookies`、`clipboardRead`、`webNavigation` 或 `<all_urls>`。

## 已知限制

- 本组件只覆盖 Chrome 网页，不等同于 ChatGPT/Claude 原生 App watcher。
- provider DOM selector 与 Navigation API 行为可能随线上更新漂移，需按版本复验。
- Enter 发送是 heuristic；send control/form submit 在 1.5 秒窗口去重。
- `user_interacted`/`user_engaged` 是动作证据，不代表用户理解或注意。
- Chrome service worker 会休眠；本地队列和 alarm 降低丢失风险，但必须真机验证。
- ChatGPT 当前网页设置可提供 `Responses → Push`（页面说明主要面向 research、image
  generation 等耗时请求），Claude 也可提供第一方通知；扩展既不拦截也无法可靠审计这些
  网站通知。正式研究必须手动阻止二者，避免与 CHI27 通知重复。
- 回答预览依赖 provider DOM selector；取不到时固定文案 fallback，不能把“有通知但无片段”
  解释成回答为空。预览可能在锁屏、通知中心或屏幕共享中暴露回答开头。
- 原 tab 仍存在但已切到另一对话时，通知回访 fail closed；原 tab 已关闭时浏览器本地模式
  不会重开，只有 provisioned Native authority 的 signed `prepare_reopen → exact confirm`
  可以重开。扩展不会保存或自行拼装 URL。
- 浏览器本地 exact key 只在当前扩展 namespace 内稳定；移除扩展或清除扩展数据会轮换
  namespace，不能与旧 key 或原生 App key 自动合并。
- legacy `profile_scope_id` 只保留并报告迁移提示，不参与 key 生成，也不自动删除。

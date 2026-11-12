# 多设备共享数据集（含 Tailscale 线路）：设计草案

> 状态：2026-11-11 用户确认按本文建议执行：Q1–Q4 和 §4.4 两个小问题均按「建议」一栏裁决
> （不内嵌 Tailscale、可选线路、主力电脑单写者、离线进待发队列；副本显示并从主力电脑的标签目录选标签；
> 提醒只在主力电脑触发）。第一个使用方是个人待办的多设备同步。
> 依据：[`product-rules/agent-net.md`](product-rules/agent-net.md)、[`agent-net-plan.md`](agent-net-plan.md)、
> [`self-hosted-relay-plan.md`](self-hosted-relay-plan.md)、[`product-rules/cloud-companions.md`](product-rules/cloud-companions.md)、
> [`product-rules/personal-todos.md`](product-rules/personal-todos.md)、
> [`dev-rules/protocol-compatibility/personal-todo-remote-resource.md`](dev-rules/protocol-compatibility/personal-todo-remote-resource.md)、
> [`dev-rules/remote-and-mobile-adaptation.md`](dev-rules/remote-and-mobile-adaptation.md)、
> [`dev-rules/credentials-and-local-storage.md`](dev-rules/credentials-and-local-storage.md)「个人待办」行。

## 0. 结论

1. **要解决的问题是同步，不是网络。** 同账号的电脑之间已经能互相调用：V1 device-link 走中转，局域网可直连；
   V2 agent-net 端到端加密，支持自建中转和局域网无服务器。个人待办只在各电脑上各存一份，
   原因是缺少「哪台电脑说了算、别的电脑怎么拿到」的数据层，而不是电脑之间连不上。
2. **Tailscale 只作为一条可选线路，不作为身份层、加密层或依赖。** Cindy 不内嵌 Tailscale（不用 tsnet），
   也不要求用户安装。装了 Tailscale 的设备多一条可达地址，可以用来直连或发现对端；
   认证、授权和端到端加密仍由 device-link / agent-net 负责。理由见 §2。
3. **新建一层通用的「共享数据集」**，跑在现有 device-link / agent-net 之上。数据集按条目记录版本号，
   用建档回执保证幂等，用账号代次隔离不同账号。个人待办是第一个接入的数据集，以后的共享需求注册新数据集即可，
   不再各自写一套同步。
4. **建议第一期用「主力电脑」模型（单写者）**，不做多主。主力电脑离线时，其它电脑先用待发队列暂存修改，
   主力电脑重新上线后再提交（§4）。多主留作以后的选项，不在本期实现。

## 1. 需要用户裁决的问题

| # | 问题 | 建议 | 备选 |
| --- | --- | --- | --- |
| Q1 | `agent-net-plan.md` §4 记录过用户裁决，不使用「Tailscale 类」第三方网络库。本设计是否与之冲突？ | **不冲突，也不改动该裁决**：Cindy 不链接、不内嵌、不配置 Tailscale，只读取用户自己装好的 Tailscale 给出的本机地址和对端列表，把它当作一条已有的网络。传输和加密仍然是自研的 agent-net。 | 内嵌 tsnet 做组网：需要推翻 §4 的裁决，见 §2.3 |
| Q2 | Tailscale 是必需还是可选？ | **可选**。没装 Tailscale 的用户经现有中转同步，功能完整；装了的多一条直连路径。 | 必需：与「现有功能不退化」冲突，在中国大陆也不可行（§2.2） |
| Q3 | 同步模型：主力电脑（单写者）还是多主？ | **主力电脑**，与云端伙伴的先例一致；主力电脑离线时用待发队列补写（§4.3）。 | 多主加字段级合并：可以离线自由编辑，代价是要引入时钟与合并规则，并需要处理条目同时被删除和编辑的情况（§4.5） |
| Q4 | 主力电脑离线时，其它电脑能否修改？ | **能，先进入待发队列**，状态显示「待同步」；主力电脑上线后按版本号提交，版本冲突的条目交给用户处理。 | 只读：最简单，与云端伙伴的「主力电脑离线时只读」一致 |

另外有两个按数据集决定的小问题，见 §4.4（标签目录、提醒在哪台设备上触发）。

## 2. Tailscale 与现有网络的关系

### 2.1 现有能力（据仓库文档与代码）

| 层 | 现状 | 与本设计的关系 |
| --- | --- | --- |
| device-link V1 | 中转负责登录、在线状态与链路控制，`invoke / invoke-result / push` 可靠帧可以改走直连；被控端逐条核对远控开关、撤权名单和通道白名单，消息来源取自已认证的连接 | 同步消息走既有可靠帧，不改帧格式 |
| 直连 | WebRTC 数据通道，只收集 host 候选（不用 STUN/TURN），不通时回落中转，按序号去重，只执行一次 | 本机网卡的 Tailscale 地址（`100.64.0.0/10`）可能已经作为 host 候选，**需要验证**（P0） |
| agent-net V2 | 自研可靠 UDP 加 Noise IK，端到端加密；有官方、自建和本机中转；局域网用 IPv4 组播发现 | Tailscale 网络里没有组播，需要把对端列表作为额外的发现来源（P3） |
| Remote Resource | 手机通过 `personal-todos` 资源读写主机上的待办：基于 revision 的乐观并发，用 `creationRequestId` 防重复，写入后推送 changed | 第一期可以直接复用，作为写入主力电脑的入口 |
| 自建中转 | 前置代理模式可以由 `tailscale serve` 提供 TLS | 已经支持，不变 |

### 2.2 为什么不把 Tailscale 当主路径

- **曾试过并废弃。** `self-hosted-relay-plan.md` 的 v1 以 Tailscale 为主路径，后来废弃，原因有两条：Tailscale 的 iOS App
  不在中国大陆 App Store（tailscale/tailscale#19625），注册还需要海外账号。这两条现在仍然成立（未复查，见 P0）。
- **tailnet 成员不等于同一个 Cindy 账号。** tailnet 可能是公司网络或与他人共用。只要在 tailnet 里就信任，
  会绕过 Cindy 现有的账号归属和撤权机制。
- **WireGuard 不满足 agent-net 的端到端规则。** 规则要求两个 agent-net 节点之间的内容只有这两个节点能解密。
  Tailscale 加密的是设备到设备的隧道，同一台机器上的其它进程、同一 tailnet 的管理员所能做的事
  与 Cindy 的授权模型不同。所以 Tailscale 上跑的仍是 agent-net 的加密流量或 device-link 的可靠帧，不能把它当作明文通道。
- **手机只有一个 VPN 名额。** 手机上开着 Tailscale，就不能同时用其他 VPN。这应该由用户自己选择，不能是 Cindy 的前提。

### 2.3 为什么不内嵌 tsnet

如果内嵌 tsnet，每个 Cindy 节点都会成为一台 tailnet 设备。代价有四项：

1. 推翻 §4 的「不用第三方网络库」裁决。
2. 在手机上引入 Go 运行时，改变原生指纹，无法冷更新。
3. 需要用户的 Tailscale 账号或 auth key。
4. 中国大陆同样不可用。

收益只是用户少装一个 App。不建议这样做。

### 2.4 参考：OpenClaw 怎么用 Tailscale

以下据 docs.openclaw.ai 的 gateway/tailscale、remote、discovery、pairing 几页整理，未读源码。

- OpenClaw 是**单网关**：Gateway 是唯一的权威来源（文档原话是 single master），掌握会话、凭证和状态；
  其它设备都是连到它的客户端。它不做多主复制，文档里也没有冲突处理。
  所以它能参考的只是暴露与认证的做法，不能作为多设备复制的先例。
- 它调用用户本机的 `tailscale` 命令行，没有内嵌 tsnet。暴露方式有三种：
  - `off`（默认）
  - `serve`：只在 tailnet 内提供 HTTPS，Gateway 自己只监听 `127.0.0.1`
  - `funnel`：公网 HTTPS，必须开密码认证
- 用 `serve` 时，可以凭 `tailscale-user-login` 请求头加 `tailscale whois` 免登录，但仅限控制台。
  设备仍然要逐台配对，节点要单独审批能力；本机可能运行不受信任代码时，文档建议关掉这一项。
- 发现：局域网用 Bonjour，跨网络用广域 DNS-SD 加 MagicDNS 提示。文档明确说发现到的信息只是未认证的提示，
  不等于授权；手机经 tailnet 连接时必须用 `wss://` 或 Serve，不能用明文 `ws://`。

这些做法与本设计一致：

- Tailscale 只是一条网络路径。
- 发现到的信息不能作为凭据。
- 配对和授权仍由应用自己负责。
- 不开放公网入口（Cindy 不做 Funnel）。

## 3. Tailscale 线路的接入方式

用户已经装好并登录 Tailscale 时，Cindy 做三件事，其余一律不做：

1. **读取本机状态**：调用 Tailscale 的本机接口（LocalAPI，或 `tailscale status --json`），只读本机的 tailnet 地址、
   对端地址和对端在线状态。不写入任何配置，不调用 `serve`、`funnel` 或 `up`。
2. **增加候选地址**：
   - V1 直连：P0 实测 host 候选已经包含 `100.x` 地址（[记录](verification/2026-11-12-tailscale-direct-candidates.md)），
     问题反过来：只走 DERP 的 tailnet 候选比 Cindy 中转还慢（约 440 ms 对 80 ms）。所以 Desktop 只在 Tailscale 报告真直连
     （对应节点 `CurAddr` 非空）时保留 tailnet 候选，否则从 SDP 里剔除；规则正本见
     [`device-link-lan-first-direct.md`](dev-rules/protocol-compatibility/device-link-lan-first-direct.md)「Tailscale 候选策略」。
   - V2：把对端的 tailnet 地址作为 agent-net 的一个候选端点，走正常的 Noise 握手。
   - 握手的身份仍是设备证书或主人签名。Tailscale 给出的对端名字只用于显示，不作为准入依据。
3. **显示路径**：拓扑页把这条链路标为「直连（Tailscale）」（选中的候选对用了 tailnet 地址时，P3 已实现）。`remote-desktop.md` 已有约定：在 Tailscale 上不代表一定是直连，
   以实际选中的候选为准。

没装 Tailscale、Tailscale 没登录，或两台设备不在同一个 tailnet，都完全沿用原有路径。不提示，也不报错。

## 4. 同步模型

### 4.1 角色

- **主力电脑（home）**：数据集的权威副本和唯一写入者。默认是第一台启用同步的电脑，用户可以在任意一台电脑上手动更换。
  更换主力电脑的语义参照 cloud-companions §3.1：新主力电脑先从旧主力电脑取得完整快照，再接管写入；
  旧主力电脑不在线时，以本机副本为准接管，并提示用户「可能缺少最近的修改」。
- **副本（replica）**：其它电脑保存只读快照和变更游标，界面和 Agent 都从本地快照读，所以离线也能看。
- **手机**：不保存副本，仍然通过 Remote Resource 直接读写主力电脑（现有协议），见 §5。

主力电脑记录在哪里，需要选一个位置：

- 方案一：存在服务器的账号设置里。与伙伴的 `homeDeviceId` 同类，但要改服务端。
- 方案二（建议第一期采用）：存在数据集自己的元数据里，靠设备之间同步。不依赖服务端；
  只用自建中转的用户也能使用，符合 agent-net「自建中转全功能」的要求。

### 4.2 数据流

```text
副本电脑 UI / Agent ──写──▶ 本机待发队列 ──invoke──▶ 主力电脑 store.update（revision / creationRequestId）
                                                          │ 成功
                                                          ▼
                               主力电脑推送 changed(dataset, 新游标) ──▶ 各副本拉取增量 ──▶ 更新本地快照
```

- 写入：副本不在本地直接修改，而是把修改提交给主力电脑，入参和现在手机的 `update` 相同：
  - 带 `expectedRevision` 和 `creationRequestId`；
  - 版本号已过期时返回 `ALREADY_EXISTS`，副本把这一条标为冲突；
  - 同一个 `creationRequestId` 但内容不同时返回 `CONFLICT`，同样标为冲突。
- 读取：副本按游标拉取增量，返回自某个游标以来发生变化的条目和墓碑。游标落后太多，或已经越过墓碑保留期时，改为拉取全量快照。
- 现有存储正好够用：
  - 条目 id 是全局唯一的 `todo:<uuid>`；
  - `revision` 按条目递增；
  - 删除会保留 30 天墓碑；
  - `ingest` 有 `source:sequence` 回执和游标。
  所以副本提交可以直接用 `ingest`，source 记为 `replica:<deviceId>`，sequence 用副本的单调序号，
  这样补发多少次都只生效一次，主力电脑的存储格式也不用改。

### 4.3 离线

| 情况 | 行为 |
| --- | --- |
| 副本离线 | 读本地快照；修改进入待发队列，显示「待同步」；联网后按顺序提交 |
| 主力电脑离线 | 同上。界面明确显示「主力电脑『某某』不在线，修改会在它上线后同步」，并提供更换主力电脑的入口；不会自动更换（cloud-companions 规则 3） |
| 待发修改冲突（revision 过期） | 不覆盖。列表里显示「这条在别处改过」，给出两边的内容，由用户选择保留哪一份；Agent 拿到的是同样的冲突信息，处理方式同现在的 `ALREADY_EXISTS` |
| 同一条在别处已经删除 | 返回 `NOT_FOUND`，副本提示「已在别处删除」，可以选择恢复成一条新待办 |
| 账号切换 | 快照、队列和游标都按账号目录隔离；换账号后不读取、不提交，沿用 `personalTodoAccess.ts` 的账号代次检查 |

如果用户在 Q4 选择「只读」，表中待发队列的部分全部换成只读提示。

### 4.4 只在本机有效的字段（每个数据集都要声明）

个人待办有两类字段依赖各台电脑自己的状态：

- **标签**：`tagIds` 引用的是本机的任务标签目录 `task_tags`，各台电脑的目录不一定一样。
  - 建议：副本只显示主力电脑解析好的 `tags: [{id,name,color}]`，手机现在就是这样做的。
  - 在副本上编辑标签时，从主力电脑的标签目录里选择（快照里附带这份目录）。
  - 本机标签目录是否也做成共享数据集，以后单独决定。
- **提醒**：如果每台电脑都按截止时间触发提醒，一件事会响好几次。
  - 建议：只由主力电脑触发，经现有手机推送发出。
  - 备选：由用户最近一次活跃的设备触发。这需要记录活跃状态，不建议第一期做。

通用层要求每个数据集明确列出这类字段，不允许默认同步。

### 4.5 多主（不在本期做，记录以备以后决定）

如果以后要多主，每个字段用混合逻辑时钟加设备 id，后写入者胜；删除时保留墓碑，墓碑优先；
「完成 / 重开」这类状态操作作为操作序列合并。需要先解决两件事：

- 删除和编辑同时发生时，保留哪一边；
- 墓碑 30 天后会被清除，长时间离线的副本可能让已删除的条目复活。

本期的主力电脑模型可以平滑升级到多主：副本的提交本来就是带回执的操作，只是改由每台电脑各自应用。

### 4.6 子任务

子任务正在另一个会话里设计。同步层对条目结构不做假设，以整条为单位比较 revision。
只要子任务存放在父条目里，或者自己也是一个带 id 和 revision 的条目，就能同步，不需要额外处理。
如果子任务另起一个文件，就要作为同一数据集的第二个集合注册进来。

## 5. 通用接口

### 5.1 数据集注册（Desktop main）

```ts
interface SharedDatasetDefinition<Item, Update> {
  id: string;                     // 'personal-todos'
  schemaVersion: number;          // 条目结构的版本，新旧对端据此判断能否接收
  open(account): DatasetStore<Item, Update>;  // 宿主自己的存储，例如 personalTodoStore
  project(item): ReplicaItem;     // 同步给副本的字段白名单（不含 creationRequestId 等内部字段）
  deviceLocal: string[];          // §4.4 的只在本机有效字段，以及副本如何处理它们
  validateUpdate(input): Update;  // 未知字段返回 INVALID_PARAMS，沿用现有规则
  retention: { tombstoneDays: number };
}

interface DatasetStore<Item, Update> {
  changesSince(cursor): { items: Item[]; tombstones: Id[]; cursor; full?: boolean };
  submit(op: { source: string; sequence: number; update: Update }): Result<Item>; // 基于 ingest 回执，幂等
}
```

### 5.2 设备之间的协议

新增 device-link 通道 `maker:shared-datasets:*`。它和其它业务通道一样走可靠帧，由被控端逐条检查白名单。

| 动作 | 方向 | 说明 |
| --- | --- | --- |
| `manifest` | 副本 → 任意设备 | 返回本机支持的数据集、`schemaVersion`，以及本机记录的主力电脑 |
| `changes` | 副本 → 主力电脑 | 参数是 `{dataset, cursor}`，返回增量或全量 |
| `submit` | 副本 → 主力电脑 | 参数是 `{dataset, source, sequence, update}`，返回结果或错误码（与 Remote Resource 相同） |
| `changed` | 主力电脑 → 副本（push） | 参数是 `{dataset, cursor}`。副本收到后只重新拉取，不重放写操作 |
| `home-handover` | 新主力电脑 → 旧主力电脑 | 交接：取全量快照，并让旧主力电脑停止接受写入 |

另一种做法是复用 Remote Resource 通道。不建议这样做，因为 Remote Resource 面向界面投影（块原语、`fallbackMarkdown`），
没有游标和墓碑；手机继续用它，电脑之间用新通道。协议细节在实施时另写 `protocol-compatibility/shared-datasets.md`。

### 5.3 Agent

`cindy_helper` 的 `todos` 工具在副本电脑上同样能读写：读的是本地快照，写的是待发队列，返回结果会注明「已同步」还是「待同步」。
这满足 `agent-user-parity.md` 的要求：用户在任何一台电脑上能做的事，Agent 也能做。

## 6. 手机端

- 第一期不变：手机仍然通过 `personal-todos` 远程资源连接某一台电脑。
  区别是电脑端会把请求转给主力电脑，不管手机连的是哪一台，看到的都是同一份清单。
  如果手机连的就是主力电脑，就是现在的路径。
- 手机连的电脑不是主力电脑时，有两种处理方式：
  - (a) 手机改连主力电脑：manifest 告诉手机主力电脑是哪台；
  - (b) 由连接的电脑转发。
  建议用 (a)，不增加转发的出错环节；主力电脑离线时，手机显示副本快照，只读。
- 手机自己的离线待发队列和本地副本放到后面的阶段，需要手机端的存储与 JS 发布。
- 手机上的 Tailscale：如果用户自己开着，系统层面就多一条路，Cindy 不需要做任何处理；Cindy 不要求手机安装 Tailscale。

## 7. 安全与权限

- 只在同一个账号的设备之间同步。不用于共享任务或跨账号分享；跨账号分享以后另做数据集级授权，遵循 agent-net 的「按能力分享」规则。
- 每个请求都照常经过 device-link 认证、远控开关、撤权名单和通道白名单检查；消息来源取自已认证的连接。
  Tailscale 的身份信息不参与授权。
- 加密：
  - V2 链路端到端加密；
  - V1 经官方中转时，中转能读到内容，与现在手机读写待办相同；
  - 打开「只允许加密连接」后，同步只走 V2，不回落到 V1。
- 副本的快照和队列存放在 `userData/owners/<账号>/shared-datasets/<dataset>/`，文件权限 0600，原子写入；
  不写日志，不写入任何 Git 跟踪的位置。墓碑和回执的清理规则与主力电脑一致。
- 移除设备或撤销权限后，那台设备不再收到推送，提交会被拒绝；它本地的副本由那台设备在退出账号时清除。
  这与现在移除设备后本机数据的处理方式一致。

## 8. 用户需要做什么

| 场景 | 需要的配置 |
| --- | --- |
| 默认 | 无。在设置里打开「在多台电脑间同步待办」，这台电脑就成为主力电脑；其它电脑登录同一个账号后自动成为副本 |
| 想要更快，或想不经过中转 | 可选：在每台设备上安装并登录同一个 Tailscale 账号。Cindy 会自动识别，拓扑页显示「直连（Tailscale）」 |
| 不想经过官方中转 | 用现有的自建中转或本机中转，并打开「只用我的中转」；Tailscale 可以作为前置代理（已经支持） |

界面上只出现开关、主力电脑名称、同步状态和冲突项这些标签和数值，说明文字不放在界面上。

## 9. 兼容

- **开关关闭时**：行为和现在完全一样，每台电脑各有一份，手机连哪台就读写哪台。默认关闭。
- **新旧版本组合**：
  - 旧电脑没有 `maker:shared-datasets:*` 通道，新电脑通过 manifest 发现后，不把它当作副本或主力电脑，并提示它需要升级；
  - 旧电脑上的待办不受影响；
  - 新手机连旧电脑时，行为与现在相同；
  - 旧手机连新电脑时，仍用原有的 Remote Resource，字段白名单没有变化。
- **已发布的桌面 r3**：它会拒绝未知的 update 字段。副本提交沿用 `capabilities` 标记的做法，只发送对端声明支持的字段。
- **自建中转**：中转只转发可靠帧，不解析通道内容，所以不需要同步修改。

## 10. 分阶段

| 阶段 | 内容 | 完成标准 |
| --- | --- | --- |
| P0 验证 | ① 两台装了 Tailscale 的电脑分处不同网络时，V1 直连是否选中 `100.x` 的 host 候选（看 `getStats` 选中的候选对）；② agent-net 能否以 tailnet 地址为端点完成握手；③ 重新确认 Tailscale 在中国大陆 iOS 上的可用性 | 实测记录写入 `docs/verification/`；只在模拟环境里通过不算数 |
| P1 共享数据集层与个人待办 | `SharedDatasetDefinition`、`maker:shared-datasets:*`、主力电脑的登记和更换、副本快照与增量拉取、通过 ingest 幂等提交、冲突界面、Agent 工具改为可在副本上使用、协议兼容文档 | 两台电脑经官方中转和经自建中转各跑一遍：新建、编辑、完成、删除、冲突、换主力电脑；阻断对端后恢复；旧版对端混用 |
| P2 离线待发队列 | 按 Q4 的裁决实现；序号单调、重启后保留；冲突展示 | 主力电脑断网期间在副本上修改 10 条，恢复后只生效一次，冲突逐条展示 |
| P3 Tailscale 线路（V1 部分 2026-11-12 已实现：只读 CLI、候选策略、拓扑标注；V2 端点未做，agent-net 不变） | 读取 LocalAPI；把 tailnet 地址加入 V1 候选（如果 P0 证明需要）和 V2 端点；拓扑页标注 | 两台电脑不在同一局域网、不经过中转（阻断中转的数据转发）时能够同步；没装 Tailscale 时行为不变 |
| P4 手机 | manifest 告诉手机主力电脑；主力电脑离线时显示只读副本；以后再做手机端待发队列 | 手机连到非主力电脑时，看到的是主力电脑上的那份 |
| P5 第二个数据集 | 例如任务标签目录。用来验证接口足够通用 | 接入只需要提供一个定义，不改同步层 |

## 11. 未确认事项

- ~~V1 直连的 host 候选是否包含 Tailscale 网卡地址~~：2026-11-12 已实测确认包含（见验证记录）。
- agent-net V2 的 tailnet 端点与对端列表发现，P3 本次不做；Tailscale 上没有组播的问题仍待 V2 处理。
- OpenClaw 的结论只来自它的官方文档页，没有读源码。
- Tailscale 在中国大陆的现状沿用 10-28 文档的结论，没有重新查。

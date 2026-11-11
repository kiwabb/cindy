# 共享数据集（同账号电脑之间同步一份数据，新增 channel，2026-11-11）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。
> 设计正本：[共享数据集](../../shared-datasets-plan.md)；第一个使用方：个人待办（数据集 id `personal-todos`）。

同一账号的桌面之间共享一份数据：一台电脑是主力电脑（唯一写入者），其余是副本。实现与协议解析：
`packages/device-link/src/sharedDatasets.ts`（形状校验，不解释条目内容）、
`apps/desktop/src/main/shared-datasets/`（引擎与存储）。

## Channel 与动作

- invoke `maker:shared-datasets:v1`，单参数 `{ action, ... }`，只允许同账号**桌面**（`dispatch.ts` 拦截：`isSameAccountController` 且控制端平台为桌面，否则 `CHANNEL_NOT_ALLOWED`；同账号手机不能调用，手机无法 submit / handover；被撤销的控制端更早被通用门拒绝为 `ACCESS_REVOKED`；平台由对端自报，与 `changed` 推送同一道准入，未知值按手机处理）；已加入 `REMOTE_INVOKE_ALLOWLIST`，超时 45 秒（全量快照）。
  - `caps` → `{ version: 1, datasets: [{ id, schemaVersion, role: home|replica|off, homeDeviceId?, homeEpoch? }] }`；畸形条目丢弃，不让整条回复失败。
  - `snapshot { dataset, cursor? }` → 仅主力电脑应答：`{ cursor, unchanged: true }` 或 `{ cursor, items, extras? }`（`items` 为该数据集的原始存储条目，含墓碑；序列化上限 1.5 MB，超限报 `SHARED_DATASETS_TOO_LARGE`）。非主力 → `{ notHome: true, homeDeviceId?, homeEpoch? }`。
  - `submit { dataset, source: 'replica:<deviceId>', sequence, opId?, update }` → `{ result }` 或 `{ error: { code, message?, expectedSequence?, homeDeviceId?, homeEpoch? } }`。`source` 必须等于已认证连接的来源设备；`opId`（可选，≤64 位字母数字、`_`、`-`）是这条修改的稳定标识。主力电脑按 `source` 存回执（sequence + 哈希〔含 opId〕+ 结果）：同 sequence 同 opId 同内容返回原结果（幂等），同 sequence 但 opId 或内容不同、以及乱序，都回 `OUT_OF_ORDER`（带 `expectedSequence`），所以重排序号后的新修改不会被旧回执吞掉。副本提交的修改若指向已有条目，必须带 `expectedRevision`（副本总是以主力电脑的基准版本提交，不用本机乐观版本），缺少时回 `INVALID_PARAMS`，避免崩溃重放让无版本校验的操作（完成、删除、稍后）被应用两次。老版本主力电脑忽略 `opId`，退回按内容哈希匹配。`update` ≤ 256 KB。数据集错误码（个人待办：`CONFLICT / NOT_FOUND / INVALID_INPUT…`）作为正常回复，不是传输错误。
  - `handover { dataset, newHomeDeviceId, homeEpoch }` → 旧主力电脑转为副本，回 `{ ok: true }`。
- push `maker:shared-datasets:changed { dataset, cursor }`：主力电脑写入后只发给在线、未撤销、且已知跟随它的同账号桌面（`caps` 显示是它的副本，或对它发过 snapshot / submit），不群发所有桌面；接收端在 main 拦截（不转给 renderer），核对同账号与撤权后只触发重新拉取，不重放写操作；已加入 `UNLINKED_LEGACY_PUSH_CHANNELS`。
- 冲突与待发修改以 `opId` 为稳定标识（不是 sequence，sequence 会在新 epoch 重排）；同一条目的某次修改被拒时，队列里它之后的同条目修改一并转为冲突，由用户逐条选择。设为主力电脑时清除本机遗留的冲突。加入／交接时本机与对端同版本号但内容不同的条目记为 `DIVERGED` 冲突，不静默取一边。
- 写入口（`writeSharedDataset`）在引擎的同一把锁里读角色并写入，降级不会把刚写入镜像的修改冲掉。
- 主力电脑的记录在各电脑本地（`state.v1.json`：角色、`homeDeviceId`、`homeEpoch`、游标、extras）；epoch 大者为主力，平手取 deviceId 字典序小者。不依赖服务端。

## 个人待办数据集

- `schemaVersion: 1`；条目是 `personal-todos.v1.json` 里的原始待办（含标签 id 与墓碑），`extras` 是主力电脑的任务标签目录（副本的标签选择与显示按它解析）。
- 提醒只在主力电脑（与未开同步时）触发；副本不记已发提醒。
- 条目带过去（加入、降级）：已删除不带；已完成与稍后（`deferredUntil` 仍在未来）在创建后立即应用对应操作，幂等重试不重复。
- 手机的 `personal-todos` 远程资源不变（字段白名单不变），连上哪台电脑读写哪台电脑的这份清单；副本上手机的写入进待发队列并立即反映在本机镜像。

## 兼容矩阵

| 主力／发起方 × 对端 | 行为 |
| --- | --- |
| 新 × 旧桌面 | 旧端没有该 channel：`CHANNEL_NOT_ALLOWED`，新端视其为不参与（不当作副本或主力电脑），不报错、不提示数据丢失；旧端待办不受影响。 |
| 新 × 新桌面 | 正常同步。`schemaVersion` 不同的对端互不加入。 |
| 同步开关关闭（默认） | 不起定时器、不发请求；只应答 `caps`（`role: off`）与 `NOT_HOME`；待办读写与升级前完全一致。 |
| 新桌面 × 旧手机／新手机 | `personal-todos` 远程资源与字段白名单不变，行为不变。 |
| 回滚到旧版本 | 本机文件仍是普通 `personal-todos.v1.json`（副本上是镜像），旧版继续读写；副本上未同步的待发队列与冲突留在 `shared-datasets/` 目录里不再处理。 |

## 自建中转

无需同步修改。中转只转发加密的 invoke / invoke-result / push 帧，不解析 channel 与 payload（`packages/device-link-relay/src/hub.ts` 头部注释明确：隧道层 payload 原样转发，只理解连接层帧与路由头）；本改动只新增一个 invoke channel 与一个 push channel，不改帧格式、认证、版本或部署程序，也没有新的 relay 顶层字段。新客户端连旧中转行为与连官方中转一致。互通验证（`pnpm --filter @cindy/device-link-relay run interop`）见交付说明。

## 回归入口

`packages/device-link/src/__tests__/sharedDatasets.test.ts`、`apps/desktop/src/main/shared-datasets/__tests__/`；个人待办：`localDb/ipc/__tests__/personalTodoRemoteResource.test.ts`（副本写入进待发队列、标签按主力电脑目录）、`maker-ipc/__tests__/personalTodoReminders.test.ts`（副本不提醒）。

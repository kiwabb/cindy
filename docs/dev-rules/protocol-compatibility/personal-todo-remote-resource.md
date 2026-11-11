# 个人待办的手机远程资源（`personal-todos`，新增接口，2026-11-10）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

手机经同账号远控读写电脑上的个人待办，复用通用 Remote Resource，不新增 channel、不改 `allowlist.ts`：

- manifest 新增集合 `personal-todos`（`resourceKind: personal-todos`，`placement: hidden`，不进手机首页）；资源只有 `todos:me`。
- `maker:remote-resources:get` 返回块原语 `personal-todos`：`data.items` 为显式字段白名单（`id / revision / title / notes / deadline / status / deferredUntil / createdAt / updatedAt / completedAt`，`deadline` 只含 `kind / date / timeZone / at`），最多 500 条（未完成全留，已完成按时间补满）；`fallbackMarkdown` 为未完成标题清单，≤8000 字符。客户端 `primitives` 不含 `personal-todos` 时返回 `UNSUPPORTED_CAPABILITY`。
- `maker:remote-resources:invoke` 动作 `update`：输入即 `PersonalTodoUpdate`（`id / creationRequestId / expectedRevision / title / notes / deadline / operation / until`），未知字段 `INVALID_PARAMS`；成功返回 `result.todo`。错误码：过期 revision → `ALREADY_EXISTS`，条目不存在 → `NOT_FOUND`，内容不合法 → `INVALID_PARAMS`，账号变化 → `NOT_FOUND`。
- 任一入口（桌面界面、Agent 工具、手机）写入成功后宿主推送 `maker:remote-resources:changed`（`collectionId: personal-todos`），控制端只重读，不重放写操作。桌面 IPC `local-db:personal-todos:*` 仍拒绝 device-link。

兼容：旧主机的 manifest 没有该集合，新手机据此隐藏入口，不请求该资源；旧手机只展示 `placement: home-scope` 的集合，且未知集合、未知原语、未知动作不得影响首页与会话，因此不受影响。新主机对旧手机无新增负担。手机端需随 JS 发布（原语 `personal-todos` 加入富原语表，不触及原生指纹）。

自建中转：无需同步修改。中转只转发加密的 invoke / invoke-result / push 帧，不解析 channel 与 payload；本改动只在既有 `maker:remote-resources:*` channel 上增加集合与动作，不改帧格式、认证、版本或部署程序。

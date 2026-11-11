# 个人待办的手机远程资源（`personal-todos`，新增接口，2026-11-10）

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

手机经同账号远控读写电脑上的个人待办，复用通用 Remote Resource，不新增 channel、不改 `allowlist.ts`：

- manifest 新增集合 `personal-todos`（`resourceKind: personal-todos`，`placement: hidden`，不进手机首页）；资源只有 `todos:me`。
- `maker:remote-resources:get` 返回块原语 `personal-todos`：`data.items` 为显式字段白名单（`id / revision / title / notes / deadline / status / deferredUntil / createdAt / updatedAt / completedAt`，`deadline` 只含 `kind / date / timeZone / at`），最多 500 条（未完成全留，已完成按时间补满）；`fallbackMarkdown` 为未完成标题清单，≤8000 字符。客户端 `primitives` 不含 `personal-todos` 时返回 `UNSUPPORTED_CAPABILITY`。
- `maker:remote-resources:invoke` 动作 `update`：输入即 `PersonalTodoUpdate`（`id / creationRequestId / expectedRevision / title / notes / deadline / operation / until`），未知字段 `INVALID_PARAMS`；成功返回 `result.todo`。错误码：过期 revision → `ALREADY_EXISTS`，条目不存在 → `NOT_FOUND`，内容不合法 → `INVALID_PARAMS`，账号变化 → `NOT_FOUND`。
- 任一入口（桌面界面、Agent 工具、手机）写入成功后宿主推送 `maker:remote-resources:changed`（`collectionId: personal-todos`），控制端只重读，不重放写操作。桌面 IPC `local-db:personal-todos:*` 仍拒绝 device-link。

## 优先级 / 标签 / 提醒（新增字段，2026-11-11）

- `data.items[]` 追加 `priority`（0 无、1 低、2 中、3 高）、`reminder`（`default / off / before-15m / before-1h / before-1d`）与 `tags: [{ id, name, color, nameCustomized? }]`。`tags` 由主机按本机任务标签目录解析：目录里不存在的 id 丢弃（等同无标签），顺序同 `tagIds`；`nameCustomized` 仅在为 true 时出现，手机据此只对未改名的预设标签按自己的语言包本地化。目录读取失败时 `tags` 为 `[]`，不影响待办读取。`tagIds` 不上线：手机只展示、不编辑，解析后的 `tags` 已足够，且已删除标签的 id 不应泄露到手机。
- 块 `data` 追加支持标记 `capabilities: { organize: 1 }`。动作 `update` 追加可选输入 `priority`（0–3）、`tagIds`（字符串数组，条数与内容由主机存储校验）、`reminder`；形状不合法 → `INVALID_PARAMS`。已发布的桌面（r3）拒绝未知更新字段，所以手机只有在读到 `capabilities.organize >= 1` 时才发送这三个字段，读不到则在发送前剥掉；手机只发有变化的字段，编辑标题、备注、日期时不带它们，因此不会覆盖电脑上设置的值。本期手机不提供优先级、标签、提醒的编辑，只展示（优先级圈色与第一个标签）并保留。行里的标签名是主机按任务标签目录解析的，所以资源 revision 把解析结果算在内，任务标签目录增改删（`executeTaskTags` 经 `taskTagChanges.ts`）也会对 `personal-todos` 推一次 changed，让控制端重读。
- 兼容矩阵：旧主机 × 新手机：`data` 没有 `capabilities`，条目没有新字段，手机按无优先级、无标签显示，且永不发送新字段，行为同旧版；新主机 × 旧手机：多出的 `priority / reminder / tags / capabilities` 被旧手机的白名单解析忽略，无副作用，旧手机的更新不含新字段，主机照常接受；新主机 × 新手机：显示优先级圈与标签，且具备发送新字段的条件；旧主机 × 旧手机：不变。
兼容：旧主机的 manifest 没有该集合，新手机据此隐藏入口，不请求该资源；旧手机只展示 `placement: home-scope` 的集合，且未知集合、未知原语、未知动作不得影响首页与会话，因此不受影响。新主机对旧手机无新增负担。手机端需随 JS 发布（原语 `personal-todos` 加入富原语表，不触及原生指纹）。

自建中转：无需同步修改。中转只转发加密的 invoke / invoke-result / push 帧，不解析 channel 与 payload；本改动只在既有 `maker:remote-resources:*` channel 上增加集合与动作，不改帧格式、认证、版本或部署程序。

追加字段后自建中转仍无需同步修改：新增的只是既有 `get` 响应与 `invoke` 输入里的可选字段与 `capabilities` 标记，处于中转看不到的加密 payload 内，不涉及帧格式、认证、版本或部署程序。

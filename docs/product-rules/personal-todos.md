# 个人待办

> **状态**：fork（kiwabb/cindy）专有产品规则。上游 2026-11-08 移除了 V1 伙伴待办，fork 于
> 2026-11-11 合并上游时跟随移除，只保留个人待办。

个人待办是主人自己记的清单，只属于当前登录账号、只存在运行 Cindy 的这台电脑上，与伙伴无关。

## 桌面「待办」页

- 左侧导航一级入口「待办」打开 `/bots/todos`（`TeammateTodosView.tsx`），只显示个人待办；
  侧栏入口的数是未完成的个人待办数。
- 列表顶部原地新增（2026-11-11 主人确认原型）：标题里的「明天下午3点」这类日期就地识别，可撤销。
- 每条可设优先级（高／中／低，用勾选圈颜色表示）、一个标签（与任务共用同一份标签目录）、截止与
  提醒方式；可按截止时间、优先级、标签分组或不分组，组内按优先级、截止或添加时间排序。
- 状态分进行中／稍后再说／已完成；完成、重开、稍后、删除都在页内直接做。

## 各端入口

- 手机经同账号远控读写（`personal-todos` 远程资源，协议见
  [个人待办的手机远程资源](../dev-rules/protocol-compatibility/personal-todo-remote-resource.md)）。
- Agent 经 `cindy_helper` 的 `todos` 类工具读写，见 [Agent 与用户同权](agent-user-parity.md)。
- 存储位置与账号隔离见 [凭证与本地存储](../dev-rules/credentials-and-local-storage.md)「个人待办」行；
  个人更新通道的存储身份覆盖其持久化代码，见 [GitHub 桌面打包](../dev-rules/github-desktop-package.md)。

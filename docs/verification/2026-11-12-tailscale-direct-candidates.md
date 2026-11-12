# Tailscale 地址作为 V1 直连候选的实测（P0，2026-11-12）

对应 [`shared-datasets-plan.md`](../shared-datasets-plan.md) §10 的 P0 ①，以及 P3 的候选策略。

## 环境

- Windows（Clash TUN 开启，会接管 UDP）与 Mac，同一局域网 172.30.96.0/23；两台都运行 Tailscale 1.104，同一 tailnet。
- 两台之间的 Tailscale 只走 DERP：`tailscale ping` 显示 via DERP(sfo)，约 440 ms，没有直连路径。
- Cindy 中转从 Windows 往返约 80 ms；局域网直连正常。

## 结论

1. V1 直连的 host 候选里**包含** Tailscale 网卡地址（100.x），不需要「补进候选」。
2. 同一对设备上，100.x 的候选对如果被选中，数据就走 DERP，约 440 ms，比 Cindy 中转（约 80 ms）还慢。
   所以 P3 的做法不是「加入 tailnet 候选」，而是「只在 Tailscale 报告真直连时保留 tailnet 候选，否则剔除」。
3. 局域网候选不受影响，两台同网时仍选局域网直连。

## P3 实现后的读数（同日，同一台 Windows）

只读 `tailscale status --json`，约 94 ms；对端 Mac 在线但 `CurAddr` 为空、`Relay` 为 sfo ⇒ 判定为非直连 ⇒ tailnet 候选被剔除。
另一台对端（HarmonyOS）离线，同样为非直连。（评审修正后：只有 Tailscale 报告的地址才算 tailnet，且 Tailscale 读不到时策略不生效。）记录中不含地址与主机名。

## 未验证

- 两台电脑不在同一局域网、Tailscale 真直连（CurAddr 非空）时，经 tailnet 的直连通道的端到端实测。
- 默认路由策略（`default_public_and_private_interfaces`）在各平台上是否一定枚举到 Tailscale 网卡地址；实测只覆盖上述 Windows ↔ Mac。
- 手机端：不读 Tailscale、不过滤；共用 runtime 的 open 前帧暂存与含 Tailscale 地址段候选时的选中候选对查询随下次 Mobile JS 更新发布，不影响选路。
- Chromium 是否会把 Tailscale 地址以 mDNS 名隐藏（隐藏后策略无法识别，按局域网候选保留）；`default_public_and_private_interfaces` 下实测看到的是 IP。

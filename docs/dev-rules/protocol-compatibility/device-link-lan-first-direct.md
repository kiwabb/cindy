# Device Link 局域网优先直连

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

可靠链路的 `link-open/link-accept` 增加可选能力 `direct-link-v1`。双方均支持且已完成
现有授权与可靠握手后，字典序较小的 deviceId 后台发起 WebRTC DataChannel；信令通过
既有 relay `push` 的 `device-link:direct-signal` channel 发送，含 offer/answer/close、
随机通道 ID 及两端当前 transport stream。客户端验证账号范围、双方能力、链路就绪与
stream 匹配后才处理；信令不进入业务可靠 FIFO，也不走直连。超时或信令丢失由独立退避
重试恢复，普通业务继续走 relay，不产生新 invoke 白名单权限或服务端协议版本。

直连重试保留 5 / 10 / 20 / 40 / 60 秒的指数退避档位，每次在当前档位的 80%～100%
区间随机错峰（含 60 秒封顶档），避免多个 peer 同时失败后集中重新协商。平均间隔约为
原固定档位的 90%；稳定连接满 60 秒后重置退避，撤权、断链或停止时仍取消待重试。

直连容量是本机传输资源预算，独立于供应商组的执行并发上限。Desktop 一个数据进程的所有
客户端（含跨区域连接）合计最多 64 个实际协商中／已打开的 peer；同账号设备与供应商分享
各保留 8 个名额，余下 48 个共享，因此单类最多 56 个。Mobile 维持原有 16 个、不设分类预留。
分类不赋予权限：分享仍须通过原有 capability、可靠握手和许可检查，见
[`provider-sharing-direct-execution.md`](../../product-rules/provider-sharing-direct-execution.md)。
`directCapacity.ts` 是预算与排队判据正本，Main/WebView bridge 与生成的浏览器 runtime
同步支持桌面硬上限；平台只能选择不超过它的预算，不增能力位、不改 relay 信令格式。

满额时业务继续走 relay；有界等待队列按类内 FIFO、类间轮转补建，不驱逐健康通道。
释放名额后自动唤醒等待者，再次核验当前授权与 stream；入站 offer 最多保留 15 秒，
撤权／换代／过期后不得补建。失败尝试立即释放物理名额，重试状态不占直连容量。
每个客户端最多保留 256 个候选、同一数据进程最多 256 个等待者；无业务活动的失败／等待状态
在 5 分钟后回收（正在进行的请求例外），新业务可以再触发尝试。有等待者时每分钟检查长期
空闲通道：至少 5 分钟无收发、没有在途请求、接收处理或缓冲时才让出名额。无压力时保留已建立
的通道，分享许可续期不因本机空闲策略而换通道。
信令失联时，已经认证、完成可靠握手且健康的通道，在原同账号 grace 或分享 lease
剩余期内不参与这类空闲回收；共享池中其它在线客户端的等待者也不能提前打断该保留。
信令恢复后恢复原空闲公平规则；任一时钟到期、明确关闭／撤权或通道故障仍结束保留，
不续期、不扩大容量，也不允许离线建立新授权。等待者可能等到原期限结束或其它名额释放。
Desktop 还通过 `isPeerBusy` 接入 dispatch 的执行中请求和待发回包，不能把可靠帧已 ACK
误当作宿主业务已完成；这只阻止空闲回收，不延后 ACK 或阻塞后续 stop／steer／push。

匿名诊断仅记录固定 reason、kind、active/limit/queued、分类占用与预留数，以及完整 peer key 的 SHA-256 前 16 位；
每个 peer 的同一 reason 每分钟最多一次，不输出原始 scoped key、SDP、IP 或错误对象。
旧 Mobile 宿主没有 WebCrypto 时记 `peerHash=unavailable`，不退回明文 ID。容量满、队列满、
协商超时、网络失败、runtime 故障与空闲让出分别记录；不会把 `channel-closed` 猜成网络失败。
自建中转沿用已有签名 push 的不透明转发，不需改服务端；共享客户端测试、relay 测试和
`pnpm --filter @cindy/device-link-relay run interop` 同时验证。

本地容量／吞吐复现：`node scripts/direct-link-smoke.mjs <Chrome路径> --capacity`。
64 是本机浏览器压测后的初始桌面预算，不等于跨机器、长时间高负载或手机真机验收；
单 peer 帧／缓冲上限保持不变，更多 PeerConnection 会增加 CPU、内存和网络资源占用。
2026-11-02 的 Windows / Node 22.22.3 本机 Chromium 记录：64 条通道建立 541ms，
8 轮合计 52 MiB UTF-8 正文传输 3466ms，20ms 定时探针观察到最大延迟 78ms；第 65 条
释放后补建，其余 63 条保留原通道。这些是一次本机 fixture 测量，不作为生产性能保证。
另已通过共享客户端全套、桌面适配器与跨区域测试、自建 relay 测试／互通、两个独立
Electron 进程的 IPC/WebRTC smoke，以及 Desktop、Mobile 和共享包类型检查；真机长时压测待补。

数据通道 `device-link-v1` 只使用可靠有序 SCTP；同一完整 envelope 拆为不超过 16 KiB 的
二进制片，首字节 0/1 表示续片/末片，剩余字节是 UTF-8。单条最多 `MAX_FRAME_BYTES`，
重组有字节、分片数和超时边界；在原可靠层接收之前重组，序号、去重与 ACK 语义不变。
桥接在途字节与 SCTP bufferedAmount 一起参与背压，平台静默失效同样会触发原有中继回退。

## Tailscale 候选策略（2026-11-12，过滤仅 Desktop）

不改 wire、能力位、信令 channel 与服务端；只改本机对经过它的 SDP 里 `a=candidate` 行的取舍。

- **何时生效**：本机 Tailscale 正在运行且 `status --json` 可读；否则什么都不做（不剔除、不关闭）。SDP 里没有
  `100.64.0.0/10`／`fd7a:115c:a1e0::/48` 段候选时不读状态。一个地址只有出现在 Tailscale 报告的 `Self`／`Peer`
  `TailscaleIPs` 里才算 tailnet，恰好用这些地址段的局域网不受影响；局域网候选和 mDNS 名永远原样保留。
- **入站（accept／answer）**：拥有该地址的对端节点 `CurAddr` 非空且在线才保留，否则在 `setRemoteDescription` 前剔除。
  至少保留一条才算「获批」。
- **出站**：offer 对端未知，其它对端的状态不能代表它，所以总是带上本机 tailnet 候选，由 answer 决定；answer 仅在入站获批
  时才暴露本机 tailnet 候选；offer 收到 answer 后按其候选重新判定。
- **读取**：只执行 `status --json`（Windows 只从 `%ProgramFiles%`／`%ProgramW6432%` 下的安装目录找，不用裸名；macOS 为
  App 包、`/usr/local/bin`、`/opt/homebrew/bin` 与 PATH；Linux 为 PATH），输出上限 4 MB，每次刷新至多一个进程，成功与失败
  都缓存 30 秒，并发共用；不落盘、不轮询，日志只记数量，不记地址和主机名。状态读不到时不生效，不阻塞协商。
- **兜底与冷却**：剔除 SDP 行不能阻止不过滤的对端（旧 Desktop、手机）经本机 tailnet 套接字配对。runtime 仅在 SDP 含
  Tailscale 地址段候选时，于通道打开时用 `getStats` 取选中候选对中落在该地址段的地址（500 ms 超时，只在 runtime、
  桥接与 Desktop 策略之间的本机事件里传递，不进日志、wire 或拓扑），策略层用 Tailscale 报告的地址判定。未获批准的
  tailnet 候选对在可靠层之前关闭（诊断原因 `tailnet-unapproved`），业务走 relay；该 peer 冷却 10 分钟，冷却内双方
  tailnet 候选都被剔除，局域网直连照常建立。取不到数据按非 tailnet 处理，绝不关闭局域网链路。
- **open 前的帧**：open 事件可能被上述查询推迟；runtime 与策略层把 open 之前收到的帧按序暂存（有字节／条数上限），
  open 之后依次交付，桥接「open 前收到消息即关闭」的守卫保持不变。
- **拓扑**：已获批的 tailnet 直连在本机拓扑页标为「直连（Tailscale）」；该标记经本机 `peer-links` 快照的可选字段
  `viaTailnet` 传递，见 [`device-link-peer-links-snapshot.md`](device-link-peer-links-snapshot.md)，不进 wire。
- **手机**：不过滤、不显示标签、不读 Tailscale；共用的 WebView runtime 带有 open 前帧暂存和含 Tailscale 地址段候选时的
  选中候选对查询，结果不影响选路，随下一次 Mobile JS 更新发布。agent-net V2 不改，tailnet 端点留待 V2。
- **未验证**：Chromium 在默认路由策略下是否把 Tailscale 地址以 mDNS 名隐藏——被隐藏的候选不是 IP，策略无法识别、
  按局域网候选原样保留；真实 Tailscale 真直连的端到端通道也没有两台不同网络的机器实测。

旧端不声明能力，双方仍走 relay；只升级一端不会启用直连。Desktop 与 Mobile 均接入，
同账号远程供应商沿用这条共享路径；跨账号供应商分享和共享任务继续由 relay 逐帧授权。
不改数据库、服务端、Mobile 原生依赖或配置。Mobile 使用现有 WebView，iOS 的 WebKit
网络行为参考 [Apple TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)。
平台不可用或系统阻止局域网访问时沿用 relay，不能阻断业务。真实跨设备、iOS/Android
前后台及系统网络权限的发布验收必须另记实测证据；浏览器本机 smoke 不等同于真机通过。

# 2026-10-29 全面测试记录（main 63c815f，接 10-24 一轮）

> 负责人 05:38 布置：继续跑 10-24 没跑完的测试，找到 bug 修了开 PR 自己合，12:00 前停、跑完把占硬盘的全删。
> 本轮在 scratchpad worktree 里跑，主工作区不碰。上一轮记录：`docs/testing/2026-10-24/REPORT.md`。

## 一、结果一览

| 项 | 结果 |
|---|---|
| typecheck ×5 / lint（backend、admin、app） | ✅ |
| 单测（backend / shared / mock / admin / app 3358 例） | ✅ |
| 构建（backend、admin、app expo export） | ✅ |
| Prisma 迁移漂移 | 无 |
| 容器 e2e（普通）90 套 850 例 | ✅ 275 s |
| 容器 e2e 覆盖率（10-24 没跑的） | lines 89.1% / branches 78.5%，见二 |
| API 模糊 870 请求 | 0 发现 |
| Admin 浏览器：含已注销 / 关键词 / 翻页 / 事故状态 | ✅ |
| iOS 新包（Release，模拟器）：登录 / 注册（短信码从 Console Mock 取）/ 找回密码 / SOS 双端同步取消 / 求救演练 / 地图页 | ✅ |
| 安卓：登录 / SOS 同步 / 内存对照实验 | ✅，**但跑的是 10-24 装的包**（见四） |
| 安卓 native 堆缓涨（10-24 遗留） | 触发条件钉死（当前头盔 ski 剧本）；候选修复 PR #466 复测**无效、已关**（见三） |
| 评审代理读 36ac9c0..main 的 app diff | 无可复现的正确性 bug；两条低危见五 |

## 二、容器 e2e 覆盖率最低的模块

| 文件 | lines | 说明 |
|---|---|---|
| scripts/provision-batch.lib | 0% | 批量开通脚本，e2e 不跑 |
| backup-upload | 15% | 备份上传脚本，云端 cron 用 |
| push/jpush provider | 19% | 第三方，单测另有覆盖 |
| storage/cos provider | 38% | 同上（verify:cos 活体验收） |
| sms provider | 56% | 同上 |
| mqtt-consumer | 60% | 真 Broker 部分由 10-24 的 EMQX 认证/ACL 矩阵活体覆盖 |

业务模块（sos / devices / ingest / events / voice / admin）都在 85% 以上，没有要补的洞。

## 三、安卓 native 堆缓涨：对照实验与修复

10-24 长跑看到 App native 堆 ~20 MB/h 缓涨，当时钉到「账号下第二顶（非当前）头盔在发位置 + App 在前台」。本轮重做（模拟器 Pixel_8，`dumpsys meminfo` 的 Native Heap；App 前台停在设备页；每组只变一个条件）：

| 组 | 条件 | 结果 |
|---|---|---|
| A | 当前头盔 ski 2 s + 另一顶 riding 2 s 同时流 | ≈500 KB/min |
| B | 只有另一顶（非当前）riding 2 s | 8 min +272 KB（≈34 KB/min） |
| C | 只有当前头盔 riding 2 s | 8.5 min 持平（略降） |
| D | 只有当前头盔 **ski** 2 s（账号下只有它在线） | 12 min **+8.6 MB（≈0.7 MB/min）** |
| E' | D 的条件 + 候选修复（PR #466 的包，新进程） | 9 min +10.9 MB（≈1.2 MB/min） |
| D' | D 的条件，同一代包**不带**修复（新进程，和 E' 公平对照） | 4.75 min +6.0 MB（≈1.26 MB/min） |

结论：涨幅跟「**当前头盔跑大范围**」走，10-24 的「第二顶头盔」说法不对（当时第二顶跑的是 ski 剧本、而且很可能它才是当前头盔）。

机制（评审代理从代码指出，与数据吻合）：原生标签页不卸载看不见的页面，地图页从启动起一直挂着；`map.tsx` 的 `live` 查询和 `setTrack` / `setTrackTip` / `setHelmet` 三个 effect 都不看 `focused`，人停在设备页时当前头盔的每个定位仍注入看不见的 WebView：`helmet.setPosition` + `map.panTo`（跟随默认开）+ `drawTrack()` 整画布重画。滑雪剧本跑大范围时 panTo 要不停加载新瓦片；小圈骑行瓦片都缓存了，所以不涨。和 `amap-view.tsx` 顶部 10-20 那条「每来一个定位整条注入 → 每分钟 1.2 MB」是同一类。

候选修复（PR #466，已关不合）：三个 effect 加 `focused` 门控，回到地图页时因 `focused` 变化重跑一次补推。**复测结果：E' 和 D' 涨幅一样 → 这条路不是主因**（改动本身无害，iOS 上核过地图页在屏时跟随正常、切走 20 s 再回来位置最新；但不以修内存的名义合）。新进程前 10 分钟比老进程（D，跑了 4 小时）涨得更快（1.2 vs 0.7 MB/min），所以对照必须同为新进程。

**留给 A 线的线索**：涨只在 ski 剧本出现、riding 不涨，两种剧本的差别是 `altitude` 字段、速度、坐标跨度；地图 WebView 推点已排除；账号下只有 1 顶在线（换头盔提醒的 watcher 不订阅）也排除；下一步看 ski 载荷在 App 里的其他消费者（use-realtime `pushLocation` 合并写、设备页 / 安全页读 `device-location` 的地方、WS 消息解析本身），以及用 `dumpsys meminfo -d` / Perfetto 的 heap profile 直接看谁在 malloc。注意本轮所有安卓实验都在模拟器（arm64 镜像）上，真机未验。

## 三之二、tour 剧本连续多单求救（双端）

`SCENARIO=tour TOUR_CYCLE_POINTS=40 LOCATION_INTERVAL_MS=1000`（求救步每 40 s 一次，偶数轮摔倒 / 奇数轮实体键），另一顶头盔同时在流位置：

| 时刻 | 服务端 | 安卓 | iOS |
|---|---|---|---|
| 10:42:39 摔倒 | 建单 pending | 倒计时页「疑似摔倒·来自 helmet_r2_001」 | 同 |
| 10:43:19 实体键（倒计时中） | 合并规则：升级立即通知 → notified，Mock 短信 / 推送发出 | 结果页「求救短信已发出 · 联系人甲 已发送」 | 同 |
| 10:43:59 摔倒 | 新单 pending | 从结果页直接切到新倒计时（不叠页） | 同 |
| 10:44:39 实体键 | 升级 → notified | 结果页（我的滑动落在「关闭」上把页关了，之后新单照常再弹） | 结果页 |
| 10:45:20 摔倒 | 新单 pending | 倒计时页重新弹出 | 结果页 → 切到新倒计时 |
| 10:45:45 iOS 滑动取消 | cancelled | — | — |
| 10:46:00 实体键（无进行中单） | 建 manual_sos 单 pending | 倒计时页「手动求救」 | 同 |
| 10:46:40 摔倒（倒计时中） | 合并规则：只留档不建单 | 倒计时不变 | 同 |
| 10:47:00 到期 | 扫描任务 1 s 内 → notified，短信 / 推送发出 | 结果页「求救短信已发出」 | 同 |
| 10:47:20 实体键 → 10:48:20 到期 | 新单 → 到期 notified | 倒计时 → 结果页 | 同 |

没有叠页、没有串单、两端始终显示同一单同一秒数。

## 四、本轮的坑

- **安卓包 ABI**：本轮两次用 `-PreactNativeArchitectures=x86_64` 打包，而 Pixel_8 模拟器是 **arm64-v8a**，`adb install` 报 INSTALL_FAILED_NO_MATCHING_ABIS（当时输出被 `tail -1` 吞了没看见），安卓上一直跑的是 10-24 装的包。所以「安卓新包冒烟」本轮**没做到**；内存实验 A–D 在 10-24 包上做，但 map.tsx / amap-view 两版之间没有改动（只有 use-realtime.ts 改了 #443 合并写），机制结论成立；E' 用的是 main + 修复的 arm64 包。以后打包先 `adb shell getprop ro.product.cpu.abilist`。
- **容器 e2e 的 PG 就绪竞态**（已修 #465）：`pg_isready` 对镜像入口脚本初始化时的临时服务也返回就绪，脚本的 CREATE DATABASE 和入口脚本撞车 → PG 容器 Exited(3)。改成等 `helmet_ci` 能连上。
- scratchpad 在 /private/tmp，3 天没碰的文件会被 macOS 清掉（上一轮的脚本没了）；要留的脚本归档到 docs/testing/<日期>/scripts。
- iOS 模拟器的中文拼音输入法把普通文本框里的字母拦成候选（绑定页设备编号），工具限制，和 10-24 频道名一样。

## 五、评审代理的其余发现（未改，交 A 线）

1. `services/ble-link.ts` `setBleTargets`：解绑最后一顶时 `close("unbound")` 同步触发 `onClosed` → `ensureScanning()` 用还含旧设备的 `targets` 开了一轮 20 s 过滤扫描才停。不会连错设备（扫描回调重新取 `wanted()`），只是多扫一轮 + 日志误导。低危。
2. `api/realtime.ts:177-199`：「本轮第一次被拒」的快速重连额度在刷新请求因瞬时断网失败时也被消耗，第二次 4401 刷新成功后仍按 16–30 s 退避等。注释已自认，边角。
3. `(tabs)/_layout.tsx` + `use-switch-reminder.ts`：≥2 顶在线时每顶的每个定位写入让 TabsLayout 整体重渲染（5 个 Trigger 的样式对象重建）。JS 层每分钟 30–60 次重渲染，实验 C/D 显示它不是 native 堆的来源；想省的话把 hook 挪进一个 `return null` 的子组件。

## 六、没做的

- （tour 多单求救已跑，见「三之二」）
- 安卓新包（main 63c815f 不带修复）的冒烟：见四；E' 的包 = main + 修复，登录态沿用、设备页 / 地图页在 E' 里看过。

## 七、磁盘

本轮占用约 18 GB（worktree 8.1 GB、iOS DerivedData 7.4 GB、Docker 卷 / 容器、APK、截图），收尾用 `scripts/cleanup.sh` 全部删除，结束后 `df` 与开跑前基线对比见最终汇报。

# 2026-10-30 测试记录（main bd2c0aa，接 10-29 一轮）

> 负责人 04:25 布置：继续跑没跑完的测试，明天 08:00 前结束，遇 bug 自己开 PR 修并合，结束时把新占硬盘的全删。
> main 自 10-29 以来没有新提交、没有 open PR（CI 同款上一轮全绿，不重跑），本轮集中在 10-29 留下的唯一疑点：**安卓 native 堆缓涨的根因**。上一轮记录：`docs/testing/2026-10-29/REPORT.md`。本轮在 scratchpad worktree 里跑，主工作区不碰。

## 一、结果一览

| 项 | 结果 |
|---|---|
| 安卓 native 堆缓涨根因 | **钉死**：`ValueTransition`（components/motion.tsx）用 key 变化触发 Reanimated 的 entering / exiting；地图页海拔格用它，ski 剧本每个点海拔都变，隐藏的地图页每 2 s 一次进出场；Reanimated 4.5.1 每次都留一批 native 侧对象（见二） |
| 修复 | PR #468（`fix/value-transition-layout-anim-leak`）：两层常驻、轮流当前层，新值落进本来就藏着的那层，动画全在 UI 线程起；安卓 1.4 → 前 10 min 0.8、后 10 min 0.27 MB/min 并走平（完全不动画的地板 ≈0.5–0.6），iOS 1.3 → ≈0.65 MB/min |
| 升 reanimated 4.5.5 能不能修 | 不能：仍 ≈1.1 MB/min（4.5.3 的 withheld exiting 修复不覆盖）；已还原 4.5.1 |
| 全量 app jest / lint / tsc | 205 套 3358 例 ✅、`expo lint` ✅、`tsc` ✅（worker 退出告警 main 上本来就有） |
| 余量 | 修后双端仍 ≈0.5 MB/min，和本组件无关（见四），交 A 线 |

## 二、根因怎么找到的

**方法**：模拟器镜像是 user 版（不可 root），release 包 prebuild 后在 `AndroidManifest.xml` 的 `<application>` 里临时加 `<profileable android:shell="true"/>`（只改本地生成物、不提交），然后 `perfetto` 的 heapprofd 对 App 采样 8 min（配置 `scripts/heapprofd.cfg`：2 KB 采样间隔、每 60 s 一次 dump），`scripts/analyze-heap.py` 按 callsite 算「首末两次 dump 之间未释放的增量」并打印调用栈；Reanimated / worklets 的 `.so` 是从源码编的，用 `app/android/app/build/intermediates/merged_native_libs/.../libreanimated.so`（未 strip）+ NDK `llvm-symbolizer` 把 `?` 帧补成函数名。

**heap1（原版，设备页 ski 8 min）**：未释放 +9.1 MB，前 25 个 callsite 全在 Reanimated 这条链上，每个约 +100–250 个对象 ≈ 每个定位点一份：
- `UIManager::createNode` 建出来的 ShadowNode / `RawProps::toDynamic`（JS 提交建的节点被留住）
- `worklets::makeSerializableWorklet / makeSerializableObject / makeSerializableNumber`（JS 线程往 UI 线程传的动画对象、worklet）
- `AnimationFrameBatchinator::addToBatch`（rAF 回调）
- `ReanimatedModuleProxy::commitUpdates → cloneShadowTreeWithNewProps`（UI 线程样式更新的克隆）
- `LayoutAnimationsProxy_Legacy::pullTransaction / executeLayoutAnimationsRequests`

**heap2（中间版 plan B：JS 线程 withTiming + 按次挂卸快照层）**：+13.5 MB，栈和 heap1 一样 → 按次挂卸带 Reanimated 样式的视图、在 JS 线程按次造动画对象，都会留东西。

**heap3（ValueTransition 完全不动画）**：只剩 +2.7 MB（1 MB 是一次性大块；worklets 序列化约每 10 s 一份；RNSTabsHost / SafeAreaProvider 克隆）→ 本组件占约 70%，余量小而分散。

**为什么只有 ski**：riding 剧本海拔是「—」、速度在一段路里恒定，数值格不变、不触发过渡；ski 每个点海拔都变。**为什么 10-24 看成「第二顶头盔」**：当时第二顶跑的是 ski。

## 三、对照实验表（安卓 Pixel_8 arm64 模拟器，`dumpsys meminfo` Native Heap，App 前台停在设备页，当前头盔 ski 2 s 一个点；除注明外都是新进程、10 min）

| 组 | 包 | 条件 | 结果 |
|---|---|---|---|
| F1 | main（profileable） | 设备页 ski，heapprofd 中 | 121.2 → 126.5 MB / 7 min |
| G1 | main | **停在地图页**（focused） | GC 后 113.6 → 117.6 MB / 6 min → 和可见性无关 |
| H1 | reanimated 4.5.5 | 设备页 | 122.0 → 132.6 MB（≈1.1 MB/min） |
| H2 | plan B（JS 线程 withTiming + 按次挂卸快照） | 设备页 | 121.3 → 134.8 MB / 9 min（≈1.5 MB/min） |
| I | ValueTransition 完全不动画 | 设备页 | 112.6 → 117.6 MB / 9 min（≈0.5 MB/min，地板） |
| J | plan B + 每 2 min 在 UI 运行时造 30 万对象逼 GC | 设备页 | 121.1 → 136.9 MB / 9 min，没掉 → 「只是 UI 运行时没 GC」不成立（至少 young GC 不够） |
| **K** | **plan C（本 PR）** | 设备页 | **124.8 → 130.0 MB（≈0.5 MB/min）= 地板** |
| K2 | plan C2（C + layout effect 里 JS 侧先 set(0)） | 设备页 | 124.0 → 131.6 MB / 8 min（≈0.95，疑噪声；录屏看新值先闪再被旧值盖住，弃） |
| **L** | **plan D（本 PR：两层轮流当前层）** | 设备页 | **122.3 → 133.5 MB / 20 min：前 10 min ≈0.8 MB/min，后 10 min ≈0.27 MB/min，最后 6 min 基本走平（133.0–133.5）** |

iOS（iPhone 17 Pro 模拟器 Release，`vmmap --summary` physical footprint，同条件）：
| 组 | 包 | 结果 |
|---|---|---|
| G2 | main | 163 → 183 MB / 15 min，中间有平台期（≈1.3 MB/min） |
| H3 | plan B | 194 → 209 MB / 6 min（≈2.5 MB/min），39 min 到 229 MB 后走平 |
| K | plan C | 200.3 → 204.6 MB / 9 min（≈0.5 MB/min） |
| L | plan D（本 PR） | 热身后 199.8 → 209.5 MB / 15 min（≈0.65 MB/min） |

动画观感（双端地图页录屏逐帧：`adb screenrecord` / `simctl io recordVideo` → ffmpeg `-fps_mode passthrough` 抽帧）：
- plan C（两层常驻、快照层按值换内容、useEffect 里 tick）：iOS 正常；**安卓新值先闪一帧**再从下面滑上来——触发放在 useEffect 晚一帧。
- plan C2（改 useLayoutEffect + JS 侧先 `inProg.set(0)`）：**安卓更糟**——新值先画出来、再被旧值快照盖住、再动画：JS→UI 的共享值更新比 React 提交的挂载晚两帧。结论：凡是把新值提交进「可见」那层的写法都在和 UI 线程赛跑。
- **plan D（本 PR）**：新值渲染进从上次退场起就藏着的那层（不透明度 0、停在下方 25pt），旧值留在另一层退场；两端都是旧值原位淡出上移、新值从下淡入，不闪。

## 四、没做的 / 交 A 线

1. **余量 ≈0.5 MB/min**（双端，修后）：heap3 看是每 10 s 左右一份 worklets 序列化对象（不是每个定位点）+ 标签页宿主（RNSTabsHost）/ SafeAreaProvider 的节点克隆 + 偶发 1 MB 单块；来源待查（可能是安全页 / 设备页的 `useTintStyle`、`PulseDot`、或 30 s 轮询引起的整页重渲染）。方法同二，起点 `scripts/heapprofd.cfg`。
2. `CrossfadeIcon`（motion.tsx）是同一种 keyed entering / exiting 模式，只在状态翻转时触发（几分钟一次），本轮没改；若要彻底，可照 ValueTransition 的常驻两层改。
3. Reanimated 上游：**已报** software-mansion/react-native-reanimated#11088（2026-10-30，负责人拍板），最小复现仓库 <https://github.com/Dragolone/reanimated-layout-animation-leak>（Expo 57 空工程，500 ms 换值的 keyed entering/exiting，有开关对照：开 6 min 23.8 → 41.1 MB 单调，关 6 min 锯齿有界；heapprofd 栈和本 App 一致）。等上游回复后再决定要不要回收 ValueTransition 的改法。
4. dumpsys 的 Unknown（匿名 mmap）各轮都 ≈1.3 MB/min 涨、与改动无关，多半是 Hermes 堆扩张，没深究。
5. 只在模拟器量过；真机未验。

（下午长跑的结论见 §七：双端设备页都走平，余量是热身不是泄漏。）

## 五、本轮的坑

- 后台任务里起模拟器会被会话的进程组清理 SIGKILL（exit 137）：长驻进程用 `python3 subprocess.Popen(..., preexec_fn=os.setsid)` 脱离进程组。
- iOS 模拟器登录：勾选框和「登录」连点会丢第二下，中间 sleep 2 s；`simctl install` 同 bundle id 登录态会没。
- 对照实验要「一次只变一个条件、两组都是新进程」；打包 / 编译期间别录屏也别采样（CPU 争用）。
- 模拟器 `screenrecord` 实际只有 ≈20 fps（按画面变化出帧），抽帧用 `-fps_mode passthrough` 看真实帧，别用 `fps=60`（会复制帧、把一帧的闪看成三帧）；ffmpeg 9 没有 `-vsync`。
- iOS 模拟器录屏 `simctl io recordVideo` 是真 60 fps。

## 六、磁盘

本轮新占：worktree（含 node_modules）、安卓构建产物、iOS DerivedData、几份 APK、录屏帧、Docker 卷；收尾全删，模拟器卸包、安卓数据镜像再 wipe 一次回到 1.4 GB；最终 `df` 对比在收工汇报里。

## 七、下午：#471、双端长跑、iOS 模拟器预检（10-30 09:54–13:45）

**PR #471（已合，3f8ea6d）**：`CrossfadeIcon` 改成和 `ValueTransition` 一样的两层常驻（换图标 / 换色时不再按次挂卸）；解绑最后一顶头盔后 BLE 不再多扫一轮；WS 快速重连额度按「换到新 token」算（同一个被拒 token 不再重置退避）。单测 61 条过；iOS 目视安全页三枚 StatusChip 多次换档后终态无残影。

**长跑（合入 #468 的 main d999276 安卓包 / 3f8ea6d iOS 包，当前头盔 ski 剧本 2 s 一个点，App 前台停在设备页）**：

| 端 | 时段 | Native Heap / footprint | 斜率 |
|---|---|---|---|
| 安卓 Pixel_8 模拟器 | 09:54–10:38（44 min） | 122.6 → 127.8 MB | 0.14–0.22 MB/min，逐渐放缓 |
| 安卓 | 11:57–13:35（98 min，中间 10:38–11:57 本机睡眠、采样停） | 128.2 → 129.7 MB | **0.013 MB/min，走平** |
| iOS iPhone 17 Pro 模拟器 | 12:23–13:05 地图页（42 min） | 160 → 197.7 MB | ≈0.9 MB/min，阶梯式（地图 WebView 轨迹 / 瓦片在长，不是本轮对象） |
| iOS | 13:06–13:35 设备页（30 min） | 197.4 → 183.2 MB | **不涨反降**（地图 WebView 在回收；上午同页 main 包 ≈1.3 MB/min） |

结论：#468 之后双端设备页都走平；上午报告里「修后仍有 ≈0.5 MB/min 余量」是前 40 min 的热身（heapprofd 看到的是 worklets 序列化对象 + React 提交克隆 + RNSTabsHost 克隆，Hermes / UI 运行时晚回收），不是泄漏。地图页 iOS 的缓涨另案（WebView 内的轨迹和瓦片）。

**iOS 模拟器预检（账号 13800009002 / helmet_test_001，求救单经 app-relay 注入）**：填进 REGRESSION.md iOS 列的有 4.47、4.52、4.53、4.62、4.63、4.71、4.74、4.76、4.78、4.79、4.83、4.84、4.90、7.21、8.40、8.44（16 行；4.52 / 4.53 / 4.71 / 4.78 要停起后端，放在长跑之后做）。两个要负责人看的：
- **4.63**：首次登录恰好有单在倒数时，「允许发送通知？」已正确推迟到关掉结果页才弹；但 iOS 系统的「保存密码？以后 / 保存」钥匙串面板会在登录成功那一刻弹在倒计时环上（遮秒数，不遮「立即求救」和滑动取消）。登录表单的 textContentType 触发的系统行为，要不要在倒计时页顶住 / 登录页去掉自动填充语义——**负责人 10-30 定：先不改**（O10 同类）。
- **4.74**：有进行中的求救时注销——倒计时页盖在最上面走不到注销页，双端都只有单测（服务器半 B 线 16 已拦）。

**模拟器包的两个坑（已写进 DEVELOPMENT.md「iOS 模拟器」）**：`CODE_SIGNING_ALLOWED=NO` 的包钥匙串不可用（登录态只在内存、冷启动回登录页、队列不补传），要用 `CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=YES`；手工 `codesign` 加权利的包 launchd 拒绝 spawn。模拟器包的 API 地址是打包时从 `app/.env` 烤进去的，worktree 里指 dev 云端的话登本地账号会报「手机号或密码不正确」。

**脚本**：`scripts/gen-relay-queue.py`（8.44 的队列文件生成，10k / 30k 条）。

## 八、晚场：iOS 模拟器把能补的都补了（10-30 20:30–21:35，包 = main 00eeb4a）

又填了 REGRESSION.md iOS 列 26 行，其中 ✅ 19 行、◐ 3 行（4.48、7.15、8.30）、➖ 4 行（4.66、4.73、4.86、4.89，模拟器做不了，要真机）。修了 1 个 bug：**#474** 地图「选择查看的头盔」面板把服务端在线、本机没连上的头盔写成「离线 · 刚刚」，设备页 10-16 已改、面板漏了。

**做法**：`scripts/slow-proxy.py` 是这轮写的本地慢网代理——后端挪到 :3001（`PORT=3001`），代理占 :3000，规则文件 `slow-proxy.json` 改了即生效：`{"all": 秒, "rules": [{"match": "/cancel", "delay": 14}, {"match": "/confirm", "drop": true}, {"match": "/auth/refresh", "delay": 25, "once": true}]}`，并记下每个请求到达和发出的时刻，用来判断「请求在途」时的界面。求救单还是用 app-relay 注入；BLE 入队在 iOS 模拟器上走不了，用 `scripts/gen-relay-queue.py` 的队列文件或「我还是需要帮助」替代（4.58 / 4.59 / 8.29 都注明了）。

**要负责人看的**：
1. **7.15 / O35（待定）**：iPhone 上 2.64× 起倒计时页的字被固定行高裁成半截，滑动取消条文字消失；2.14× 能用。3.57× 结果页的「关闭」按钮会压住正文。封不封顶 2 倍还没定。
2. **8.30**：从没有 `install-marker` 的 3ab7c77 覆盖升级，会被当新装清钥匙串、登出一次，外观也回默认。#235 写明是已知代价、只影响内部测试包。REGRESSION 里 10-21 那条 ✅ 没走到这条路径，原因没核实。
3. **4.63 / 4.70（已定先不改）**：iOS「保存密码？」面板除了首登，「重新登录后取消」这条路上也会盖在倒计时上，要先点掉才滑得动。这条路本来就是赶着取消，多一步值得知道，但负责人 10-30 已定先不改。
4. **4.64（小问题，没改）**：求助先失败、后来请求又到了服务端时，「求救发送失败」的系统弹窗会留在已起来的倒计时页上，要手动点确定。系统 Alert 收不回来，要改就得换成页内提示。

**坑**：`simctl privacy reset notifications` 在 iOS 26.5 模拟器上报 Operation not permitted；卸载重装会连钥匙串一起清（App 自己的 #235 清的）；模拟器通知要**向右滑开**才拉得起 App，点正文和长按都没反应；iOS 没有动画缩放开关，4.80 用「减弱动态效果」看。

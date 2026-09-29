# RTSP 播放器双端真机 Spike 报告（决策 #37 第 ① 步）

> 2026-09-23，A 线（Wesley Mai）。分支 `spike/rtsp-player`，**未合入 main**。
> Spike 只回答一个问题：**这套技术栈能不能在双端真机上把头盔的 RTSP 流播出来。**
> 选型结论需负责人 / 汤总拍板，见 §5「待拍板」。
> ✅ **已拍板（2026-09-30，负责人）：§5 两项都接受，走路 A，见 DECISIONS 决策 #49。**

## 1. 结论（一句话）

**能。** `react-native-vlc-media-player`（内嵌 libVLC）在 Android 与 iOS 真机上都成功播放了符合
DEVICE_PROTOCOL §1.3 约定的 RTSP 流，与 RN 0.86 / Expo SDK 57 新架构（Fabric）兼容，无红屏、无崩溃。
**代价是包体：Android +40.9 MB、iOS +31.9 MB，且 Android 的 minSdk 必须从 24 抬到 26（放弃 Android 7.x）。**

## 2. 测试条件

无硬件，用 `tools/rtsp-mock/`（mediamtx + ffmpeg）起一条与 §1.3 同约定的流：

| 项 | 约定值（§1.3） | 测试流实测 |
|---|---|---|
| URL | `rtsp://192.168.176.1:8554/ch0` | `rtsp://192.168.1.111:8554/ch0` |
| 编码 | H.264 | h264 ✅ |
| 分辨率 / 帧率 | 1280×720 / 30fps | 1280×720 / 30fps ✅ |
| 音频 | 无 | 无 ✅ |
| 传输 | **强制 RTSP over TCP** | `-rtsp_transport tcp` ✅ |
| 鉴权 | 无 | 无 ✅ |

播放侧参数（`app/src/app/spike-rtsp.tsx`）：
`--rtsp-tcp`（§1.3 硬要求）、`--network-caching=150`、`--no-audio`、`--drop-late-frames`、`--skip-frames`。

> 差异说明：测试流跑在 Mac 的局域网地址上，真机走的是**普通 Wi-Fi**，不是头盔 SoftAP。
> 热点场景特有的两件事**本次 Spike 未覆盖**，见 §4。

## 3. 双端实测结果

| | Android（华为，arm64） | iOS（iPhone 真机，arm64） |
|---|---|---|
| 播放 | ✅ 出画 | ✅ 出画 |
| **首帧耗时** | **174 ms** | **694 ms** |
| 稳态 | 无错误、无 stopped | 40 s 观察窗内无错误、无 stopped、无二次缓冲 |
| 启动缓冲回调 | — | 17 次 `onBuffering` 集中在同一秒（VLC 0→100% 进度回调，非卡顿） |
| 原生库 | libvlc-all 3.6.3 (aar) | MobileVLCKit 3.5.1 (CocoaPods) |
| 新架构兼容 | ✅ | ✅ |

> 首帧两端差 4 倍属正常：iOS 侧 MobileVLCKit 初始化更重。两者都远优于硬件方自测的
> 「真机 VLC 延迟 2–3 s」（那是端到端延迟，不是首帧，口径不同，不可直接对比）。
> **端到端延迟本次没测**——mock 流是 `testsrc` 合成图，没有可对齐的时间基准。

## 4. 本次 Spike 没有覆盖的（真硬件到货后必测）

1. **SoftAP 场景**：手机连头盔热点 `X821cam` 后，Android 需 `bindProcessToNetwork`、
   iOS 需 `NEHotspotConfiguration`，否则系统会把流量走默认路由（有 4G 时尤其）。
   这是**独立于播放器选型**的一块工作量，两条路都要做。
2. **端到端延迟**：需要硬件出一路带可视时间戳的画面才能量。
3. **弱网 / 断流恢复**：热点边缘、头盔重启时的重连行为。
4. **长时间播放**：本次最长观察 40 s，没测发热、内存增长、后台切回。

## 5. 待拍板：两条路的成本对比

| | **路 A：`react-native-vlc-media-player`（本次实测）** | **路 B：自研 Expo 模块（iOS MobileVLCKit + Android media3-rtsp）** |
|---|---|---|
| App 端工作量 | **已验证可用**，接一个组件即可 | 需写一个 Expo 原生模块：两端各一个原生 View + 统一 JS API，**估 3–5 人天**，且 Android 侧 media3 的 RTSP 能力**还需再做半天验证**（media3 有 RTSP 模块并支持 H.264 over TCP interleaved，但已知限制较多，未实测） |
| Android 包体 | **+40.9 MB**（`libvlc.so`，arm64，APK 内不压缩） | **≈ +0.5 MB**（media3-exoplayer-rtsp，纯 Java/Kotlin，复用已有 ExoPlayer 栈） |
| iOS 包体 | **+31.9 MB**（MobileVLCKit arm64 切片，strip 后） | **+31.9 MB**（同样要 MobileVLCKit——AVPlayer 不支持 RTSP，绕不开） |
| **Android minSdk** | **必须 24 → 26**（libvlc-all 3.6.3 硬性要求），放弃 Android 7.0/7.1 | **保持 24** |
| 维护风险 | 三方库，npm 最后更新 2025-11-28，版本 1.0.98；新架构靠 interop layer | 自己的代码，但要自己跟 media3 / MobileVLCKit 升级 |
| 降级预案 | 同 #37：`rtsp://` 唤起系统 VLC（要求用户装 VLC，体验差，仅作兜底） | 同左 |

**A 线的建议**：先走**路 A** 把视频预览页做出来（#37 第 ② 步不再被选型阻塞），
把「+41 MB / minSdk 26」作为**已知欠账**记在上线前清单里；等预览页功能稳定、
真硬件联调通过之后，如果包体确实卡住上架或渠道要求，再用路 B 替换 Android 一侧
（JS 层 API 保持一致，替换成本可控）。理由：路 B 省的 41 MB 是真金白银，但它把
**3–5 人天 + 一个未验证的 media3 假设**压在关键路径上，而 MVP 现在缺的是功能不是体积。

**需要拍板的两件事**：

1. **minSdk 24 → 26**（放弃 Android 7.0/7.1）能不能接受？
   ——这是路 A 的硬门槛，影响的是设备覆盖率，属产品决策。
2. **包体 +41 MB（Android）/ +32 MB（iOS）** 能不能接受？

拍板后我再写 DECISIONS 条目。

> ✅ **2026-09-30 负责人拍板：两项都接受**（minSdk 24→26、包体 +41 MB / +32 MB），走路 A；DECISIONS 决策 #49 已由 B 线代记，包体欠账进上线前清单 #8。

## 6. Spike 产物与清理

- `app/src/app/spike-rtsp.tsx` —— Spike 页，**定案后随分支一起删**
- `app/src/app/(auth)/login.tsx` —— `__DEV__` 入口（slogan 下方 `· RTSP Spike ·`），同上一起删
  （放登录页而不是「我的」页：Spike 不需要账号，且云端 dev 目前没有常驻测试账号）
- `app/app.json` —— `expo-build-properties` 加 `android.minSdkVersion: 26`
- `app/package.json` —— `react-native-vlc-media-player: ^1.0.98`
- `tools/rtsp-mock/` —— 无硬件测试流，**保留**（真硬件到货前的回归都要用）

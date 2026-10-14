# DEVELOPMENT.md — 本地开发环境与常用命令

## 一次性环境安装（macOS）

1. **VS Code**：https://code.visualstudio.com 下载安装（日常写代码都在这里），并在扩展商店安装 **Claude Code** 插件（或直接在终端运行 `claude`）。用 Cursor 也可以，任选其一。
2. **Xcode**：Mac App Store 安装 → 打开一次 → 组件只勾选 iOS → 等待安装完成。仅作 iOS 构建工具链，平时不用打开。
3. **Android Studio**：https://developer.android.com/studio 下载 Mac Apple 芯片版 → 首次打开选 Standard → License 全部 Accept → 等 SDK 装完即可关闭。仅作 Android SDK/工具链。
4. **Homebrew**：https://brew.sh 按首页命令安装。
5. **命令行工具**：`brew install watchman cocoapods gh`
6. **nvm + Node 24**：
   ```bash
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   # 重开终端后：
   nvm install 24
   ```
7. **Docker Desktop**：https://docker.com 下载安装（本地跑 PostgreSQL + EMQX）。
8. **JDK 17**（Android 原生构建必需）：`brew install --cask temurin@17`，并在 shell 配置（`~/.zshrc`）加 `export JAVA_HOME=$(/usr/libexec/java_home -v 17)`。⚠️ 系统默认 Java 为 24/25 时 React Native 原生构建必定失败（JEP 472 限制），报错信息极具误导性：`A restricted method in java.lang.System has been called`——看到它先查 Java 版本。

## 克隆与安装

**⚠️ 仓库必须放在不含空格和中文的路径下**（例如 `~/Desktop/AI-Smart-Helmet-01WeiChuang`）。iOS 原生构建脚本无法处理带空格/中文的路径，会在编译末期报 `No such file or directory` 失败。

```bash
git clone <仓库地址>
cd AI-Smart-Helmet-01WeiChuang
nvm use          # 切到 .nvmrc 锁定的 Node 24
npm install      # 根目录一次装完所有 workspace（唯一 lockfile 在根目录）
```

**规则：只在仓库根目录跑 `npm install`。禁止在子目录用 yarn/pnpm，禁止生成第二个 lockfile。**

## 本地基础设施

```bash
docker compose up -d     # 启动 PostgreSQL(5432) + EMQX(1883, Dashboard 18083)
docker compose down      # 停止
```

- PostgreSQL 本地凭证：`helmet / helmet_local_dev`，库名 `helmet`（仅本地开发用）。
- EMQX Dashboard：http://localhost:18083（默认 admin/public）。

**首次启动后端前**（一次性）：

```bash
cp backend/.env.example backend/.env
# 编辑 backend/.env，按上面的本地凭证组装 DATABASE_URL：
# DATABASE_URL=postgresql://helmet:helmet_local_dev@localhost:5432/helmet
cd backend && npx prisma migrate dev   # 建表（要求 docker 里的 postgres 已启动）
```

- 后端起来后访问 http://localhost:3000/api/v1/health 应返回 `{"status":"ok","database":"connected"}`。
- 数据库表结构改动一律通过 `npx prisma migrate dev --name <名字>`（backend 目录）生成 migration，禁止手改库。

**已知坑：`prisma generate` / `migrate` 与后端 watch 进程抢文件**——生成器重写 `src/generated` 时可能把正在跑的 `start:dev` 绊倒（表现为后端悄悄退出、接口拒绝连接、或启动报 `Cannot find module dist/main`）。处理：停掉 start:dev → `rm -rf backend/dist backend/tsconfig.build.tsbuildinfo` → 重新 `npm run start:dev -w backend`。建议习惯：跑 generate/migrate 前先停后端。

**已知坑：残留后端进程会「劫持」EMQX 的认证/授权回调**（2026-08-15 实测定位）——EMQX 调后端 hook 用 keep-alive 连接池；若忘记关的旧后端进程还活着（哪怕已不监听 3000），池里的旧连接仍指向它，授权请求会打到旧代码上得到 404，EMQX fail-closed 全拒。症状：新后端日志「已连接 MQTT Broker」但紧跟「订阅失败」，设备连接被 Not authorized。处理：`ps aux | grep dist/main` 找出并 kill 所有残留 node 进程（含 `nest start --watch` 的父进程）后重启后端。同理，Mock 设备重开通（provision）后旧密钥即失效，旧 Mock 进程会每秒被拒刷屏——一并 kill。**补充（2026-08-16）**：kill 后端后 EMQX 池里的死连接同样会造成随后的「订阅失败：Unspecified error」，若上面的排查确认没有残留进程仍在刷，`docker restart helmet-emqx` 清池即愈（持久会话保证期间消息不丢，PUBACK 重投递）。

**已知坑：`start:dev` 的 Ctrl+C 偶尔不回提示符**（2026-08-16 验收实测）——npm → nest → node 三层信号转发慢，进程其实已退出（`ps` 查无）只是 shell 没重绘。按一下回车即恢复；勿因此以为后端没死而重复排查。

**已知坑：其他项目的 Docker 容器抢 3000 端口**（2026-08-16 验收实测）——本机 c3322 项目的 `c3322-node` 容器映射了 3000-3001 且设了自启，Docker Desktop 一重启它就把 3000 占走，后端启动报 `EADDRINUSE`。排查：`lsof -nP -iTCP:3000 -sTCP:LISTEN`（COMMAND 显示 `com.docke` 即是容器）；处理：`docker stop c3322-node`（要用那个项目时再 `docker start`）。

**连带坑：改 `PORT` 绕开端口冲突会让设备认证静默全拒**（2026-08-16 实测）——`emqx/emqx.conf` 的认证/授权回调 URL **写死 `host.docker.internal:3000`**，所以用 `PORT=3100 npm run start:dev` 换端口后，后端自身起得来、REST 也正常，但 EMQX 仍回调 3000（此时多半是别的项目的容器），设备与后端消费者一律 `Connection refused: Not authorized`，日志表现为无限「MQTT 重连中…」。两条路二选一：① 优先 `docker stop c3322-node` 腾出 3000 用默认端口；② 确需换端口则 `emqx/emqx.conf` 里两处 URL 同步改端口并 `docker restart helmet-emqx`，**用完记得 `git checkout emqx/emqx.conf` 还原**，勿把本地端口带进提交。

**已知坑：本地 `typecheck` 报一堆 App 路由类型错，CI 却是绿的**（2026-08-25 定位）——`app/.expo/types/router.d.ts` 是 Expo Router 的**本地生成物**（`.gitignore` 排除，不进仓库）。它由 `expo start` 刷新；若上次生成还停留在只有 spike 页面的时期，后来新增的 `/login`、`/register`、`/device/[deviceId]` 等路由就不在联合类型里，`router.push('/login')` 全部报 TS2345/TS2322。CI 跑 `npm ci` 后**没有这个文件**，Href 类型退化为宽松形式，因此不报错——所以这类报错是本地陈旧缓存的假阳性，不是 main 坏了。处理：跑一次 `npm run start -w app` 让它重新生成，或直接删掉 `app/.expo/types/router.d.ts`。判断依据：错误信息里的可选路由列表若只剩 `/explore`、`/spike-ble` 这些老页面，就是它。

**已知现象（非坑）：后端启动头几秒 MQTT 报「Not authorized」后自愈**——后端 MQTT 消费者在 HTTP 服务就绪前就开始连 EMQX，而 EMQX 认证回调恰恰要调后端 HTTP（自举鸡生蛋），头几次连接必然被拒；重连机制会在 HTTP 起来后自动连上并出现「已订阅」。看到最终「已订阅：helmet/+/status, …」即健康，无需处理。

## 常用命令（都在仓库根目录执行）

| 目的 | 命令 |
|------|------|
| 启动 App 开发服务器（日常 JS 开发） | `npm run start -w app` 后**在模拟器里手动点开已安装的 app**。⚠️ 不要按 `i`/`a`、不要扫码——当前 app 未装 expo-dev-client，那样会进被禁止的 Expo Go。首次或原生依赖变更后先用下面的 run 命令装一次 |
| 注册/找回密码时拿短信验证码（短信为 Console Mock 时） | 本地：看后端终端日志 `[MOCK SMS] → 138****0000 [verify_code] 您的验证码为123456…`；云端：`docker compose -f docker-compose.prod.yml logs backend \| grep verify_code`。配齐 `TENCENT_SMS_*` 后自动切真短信 |
| App 指到云端 development 环境（不依赖本机后端） | `app/.env` 设 `EXPO_PUBLIC_API_URL=https://dev-api.01weichuang.com/api/v1` 后重启 Metro；Mock 指云端：`MQTT_URL=mqtt://dev-mqtt.01weichuang.com:1883 DEVICE_ID=<id> DEVICE_SECRET=<密钥> npm run start -w mock-device`（凭证由云端 `provision:device` 开通，见 DEPLOYMENT.md §3） |
| 启动 Mock 头盔模拟器 | 先用下行命令开通拿到凭证，再 `DEVICE_ID=<id> DEVICE_SECRET=<密钥> npm run start -w mock-device`。**EMQX 已开启认证**：无凭证/错密钥会被 Broker 拒绝（Connection refused: Not authorized） |
| 启动 Mock 头盔（**中转模式**，模拟蓝牙版=MVP 唯一真机链路） | `TRANSPORT=app-relay API_BASE_URL=http://localhost:3000 RELAY_PHONE=<账号> RELAY_PASSWORD=<密码> DEVICE_ID=<id> npm run start -w mock-device`。不连 MQTT，改用 HTTP 批量提交 `/ingest/app-relay`（决策 #35）。**设备必须已绑定到该账号**，否则返回 404。可选：`RELAY_FLUSH_INTERVAL_MS`（批量间隔，默认 5000）、`RELAY_MAX_BATCH`（默认 20，Contract 上限 100）、`RELAY_OFFLINE_CYCLE=3`（每 3 次提交模拟断网一次，验证缓存与按原 eventId 补传）、`RELAY_SEND_OUT_OF_SCOPE=1`（把范围外事件也发出去，验证服务端留档告警）。**下行命令**（决策 #36）：自动经 WS 收 `device_command` 并按 `MOCK_CMD_RESULT=success\|failed\|silent` 回执 relay-ack（silent 演示超时 offline），与 MQTT 模式三态一致 |
| 启动 **BLE 头盔仿真器**（Mac 扮演头盔 GATT Server，按 v0.6 手册实现，硬件到货前自测 App BLE 中转全链路） | `python3 tools/ble-helmet-sim/helmet_sim.py --device-id helmet_94173f`（依赖 `pip install bless`；Mac 蓝牙需开启，可 `brew install blueutil && blueutil -p 1`）。deviceId 必须是当前账号**已绑定**的设备（云端常驻 `helmet_94173f`）。真机 App 登录后自动扫描 `Helmet-<后6位>` → 握手（读 deviceId/固件 → 对时 → 补传）→ Metro 日志出现 `[BLE] helmet_94173f 已连接`。交互命令（stdin）：`fall` / `sos` / `collision` / `obstacle` / `clear` / `loc` / `hb` 立即推一条对应事件（高危会等 App ACK，1.5 s 重发 ×3）；`offline N` 模拟离线期间产生 N 条跌倒事件压入 Flash，App 下次重连时走 0x07/0x08 补传并逐条 ACK 擦除；`disconnect` 模拟断连；`quit` 退出。设置下发（设备页音量/大灯）会真的写到仿真器内存表并按错误码回执（越界 → `ERR_PARAM_VALUE`）。**限制**：模拟器无 CoreBluetooth，只能真机测；bless 没有订阅回调，仿真器以「收到首个下行帧」视为已订阅 |
| 启动**无硬件视频测试流**（电脑模拟头盔 RTSP，与真机同约定 `:8554/ch0` H.264 720p30 TCP，A 线 RTSP Spike / 预览页开发用） | `tools/rtsp-mock/start_rtsp.sh`（依赖 `brew install ffmpeg mediamtx`；脚本打印本机 IP 与完整 URL，VLC 与 App 可同时拉；Windows 用同目录 `start_rtsp.ps1`，硬件原版）。真机换主机为 `192.168.176.1`（DEVICE_PROTOCOL §1.3），其余不变 |
| **蓝牙工程模式**（硬件联调：不登录、不上云，按钮逐条发指令、每帧 hex 与解释都显示、日志可分享） | App 登录页**长按「零一唯创」3 秒**进入，或设备详情 → 设备信息 → 蓝牙工程模式。测试清单与期望应答见 `docs/BLE_BENCH.md`（编号与按钮一致）。进入时暂停生产 BLE 链路，退出恢复。代码：`services/ble-bench.ts` + `services/ble/describe.ts` + `app/ble-bench.tsx` |
| 开通一台设备（生成 deviceId/密钥/绑定码） | `npm run provision:device -w backend`（可选参数指定 deviceId：`-- helmet_mock_002`；deviceSecret 只显示一次） |
| 批量开通设备（产线交接：CSV + 每台一张绑定二维码） | `npm run provision:batch -w backend -- --count 20`（产物在 `backend/provision-out/batch-<时间>/`：`devices.csv` 含 deviceId / deviceSecret / 绑定码 / 广播名 / 二维码内容，`qr/` 下每台一张 SVG（印刷）+ PNG（预览）；目录已 gitignore，交接后销毁。`--qr-base` 或 `BIND_QR_BASE_URL` 改二维码链接前缀，`--no-qr` 只出表；凭证规则与单台开通一致） |
| 创建管理后台账号 | `npm run create:admin -w backend`（可选用户名参数：`-- ops`；重置密码：`-- admin --reset`；密码只显示一次。需 backend/.env 配好 `ADMIN_JWT_SECRET`） |
| App 装到 iOS 真机/模拟器（含原生构建） | `npx expo run:ios`（在 `app/` 目录） |
| App 装到 Android 真机/模拟器（含原生构建） | `npx expo run:android`（在 `app/` 目录） |
| 启动后端（热重载） | `npm run start:dev -w backend` |
| 启动管理后台 | `npm run dev -w admin` |
| **拉完 main 先做**（2026-09-12 实测：漏做会让 e2e 注册全 500、app typecheck 假红） | ① `npx prisma migrate deploy` (在 `backend/`)——对方 PR 带的 migration 落到本机库；② `npm run build -w @helmet/shared`——刷新 dist 类型；③ 若 App 新增了路由，`npx expo start` 起一次让 `.expo/types/router.d.ts` 重新生成 |
| 修改 packages/shared 后 | `npm run build -w @helmet/shared`——共享类型/常量以 dist 产物被各端引用，改完必须重新 build 才生效（`npm install` 时会经 prepare 自动构建一次，新克隆无需手动） |
| 全部类型检查 | `npm run typecheck --workspaces --if-present` |
| 全部 lint | `npm run lint --workspaces --if-present` |
| 全部测试 | `npm test --workspaces --if-present` |

原生构建（`expo run:ios/android`）只在首次和新增原生模块后需要；日常改代码保存即热更新（Fast Refresh）。

## 真机调试

- **iPhone**：设置 → 隐私与安全性 → 开发者模式 → 打开并重启；用数据线连 Mac，首次需在手机上信任此电脑。
- **Android**：设置 → 关于手机 → 连点「版本号」7 次开启开发者选项 → 打开「USB 调试」；连线后允许调试授权。
- **原生依赖变更后所有开发包都要重建**（CNG：`npx expo prebuild` → `pod install` → xcodebuild / `gradlew assembleDebug`；**2026-09-23 起 iOS 用公司团队 `B3NHB45FS7` 签名，不再需要手删 `aps-environment`**）。只连 Metro 不重建会在进入用到该模块的页面时红屏 `Cannot find native module`。最近一次：**2026-10-14 合入 #102——新增 `react-native-vlc-media-player`（libVLC）+ 本地模块 `app/modules/helmet-wifi`，Android minSdk 升到 26，iOS 多了 Hotspot Configuration entitlement（实时视频预览，决策 #49，见下方「实时视频预览」）**，此后所有开发包都需要是 10-14 之后打的；前一次是 2026-10-08 新增 `@shopify/react-native-skia` / `expo-video`（开屏动画，#150），再前一次 2026-09-24 新增 `jpush-react-native` / `jcore-react-native`（极光推送，决策 #48）。

## Android 正式签名包（2026-09-21 起）

正式证书：`~/.helmet/lingyiweichuang-release.keystore`，别名 `lingyiweichuang`（RSA 4096，有效期至 2054-02，主体 = 邓白氏登记英文名 Shenzhen Lingyi Weichuang Technology Co., Ltd.）。
**口令只在负责人的密码管理器里**——不进 Git、不进 `.env`、不写任何脚本；需要时手工传给 gradle。
证书指纹：SHA1 `2E:36:B3:C2:11:88:82:8F:1B:E2:F1:AC:90:1E:34:12:3A:B4:29:D8`（高德「发布版安全码SHA1」填这个）。

`app/android/` 是 prebuild 生成物、不进 Git，所以**不改 `build.gradle`**（改了下次 prebuild 就没了），签名用命令行注入：

```bash
set -a; . ~/.helmet/android-release-keystore.env; set +a   # 凭证只从这里读，不写进命令历史
cd app/android
./gradlew assembleRelease \
  -Pandroid.injected.signing.store.file="$HELMET_RELEASE_STORE_FILE" \
  -Pandroid.injected.signing.store.password="$HELMET_RELEASE_STORE_PASSWORD" \
  -Pandroid.injected.signing.key.alias="$HELMET_RELEASE_KEY_ALIAS" \
  -Pandroid.injected.signing.key.password="$HELMET_RELEASE_KEY_PASSWORD"
# 产物：app/build/outputs/apk/release/app-release.apk
# 上架用 AAB 时把 assembleRelease 换成 bundleRelease
```

坑：

- 不加这四个 `-P` 时 release 会退回 Expo 默认 `debug.keystore`（口令明文 `android`，是工程模板自带的公共调试密钥，**不能上架也没有任何保护**）。正式包务必确认签名对：`apksigner verify --print-certs <apk> | grep SHA-1`。
- **换签名后手机上装不上**：Android 拒绝签名不一致的覆盖安装，华为上要先卸载旧的 debug 签名包再装。
- 密钥丢了无法补发，已上架的条目等于作废——文件与口令都要有异地备份。

**在 GitHub 上打包（2026-09-23 起，本机起不来 gradle 时用）**：Actions → 「Android APK」→ Run workflow（可改打进包里的后端地址，默认云端 dev）→ 跑完在该次运行的 Artifacts 下载 `helmet-app-<短 SHA>.apk`。仓库 secrets 里配了 `ANDROID_KEYSTORE_BASE64`（`base64 -i ~/.helmet/lingyiweichuang-release.keystore | pbcopy`）、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` 就用正式证书，否则退回 debug.keystore（只能测试装机）；高德 Key 从 `EXPO_PUBLIC_AMAP_*` 三个 secret 读，没配则地图页无法加载但其余功能正常。

✅ **2026-09-21 已实跑验证**：`assembleRelease` 用上述注入方式构建成功（3 分 19 秒，产物 221 MB），`apksigner verify --print-certs` 确认签名主体为公司英文名、SHA-1 = `2e36b3c2…29d8`，与证书一致。


### 让 CI 也出正式签名包（`.github/workflows/Android APK`）

工作流没配 secret 时退回 debug.keystore（只能测试装机）。配齐这四个就自动用正式证书，签名方式与本机完全一致：

| Secret | 值 |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -i ~/.helmet/lingyiweichuang-release.keystore` 的输出 |
| `ANDROID_KEYSTORE_PASSWORD` | 同 `~/.helmet/android-release-keystore.env` 的 `HELMET_RELEASE_STORE_PASSWORD` |
| `ANDROID_KEY_ALIAS` | `lingyiweichuang` |
| `ANDROID_KEY_PASSWORD` | 同上（store 与 key 口令相同） |

用 `gh` 设置（值直接从文件管道进去，不经过屏幕也不进命令历史）：

```bash
set -a; . ~/.helmet/android-release-keystore.env; set +a
base64 -i "$HELMET_RELEASE_STORE_FILE" | gh secret set ANDROID_KEYSTORE_BASE64
printf %s "$HELMET_RELEASE_STORE_PASSWORD" | gh secret set ANDROID_KEYSTORE_PASSWORD
printf %s "$HELMET_RELEASE_KEY_ALIAS"      | gh secret set ANDROID_KEY_ALIAS
printf %s "$HELMET_RELEASE_KEY_PASSWORD"   | gh secret set ANDROID_KEY_PASSWORD
```

地图相关的 `EXPO_PUBLIC_AMAP_JS_KEY` / `EXPO_PUBLIC_AMAP_JS_SECURITY_CODE` 也要配成 secret，否则 CI 出的包地图是空白的（值在 `app/.env`）。

拿到包后确认签名对：`apksigner verify --print-certs app-release.apk | grep SHA-1`，应为 `2e36b3c2…29d8`。

## 极光推送（App 侧，2026-09-24 起）

决策 #10 定极光为统一推送层、#48 定 App 侧接法。服务端只认 **alias = 用户 ID**（`backend/src/providers/jpush.provider.ts`），App 不上报 token。

- **原生配置全部由 `app/plugins/with-jpush.js` 生成**（CNG，别手改 ios/ android/）：Android 往 `app/build.gradle` 写 `manifestPlaceholders`（`JPUSH_PKGNAME/APPKEY/CHANNEL`）+ manifest 两条 meta-data；iOS 给 `AppDelegate.swift` 补三块（deviceToken → `JPUSHService.registerDeviceToken`；`extension AppDelegate: JPUSHRegisterDelegate`；`super.application(didFinishLaunching)` 之后记下 expo-notifications 的 `UNUserNotificationCenter` delegate 并在极光回调里转发回去）、bridging header 加 `#import <JPUSHService.h>` / `<RCTJPushEventQueue.h>`、Info.plist 加 `remote-notification` 后台模式。补丁靠锚点正则，**Expo 模板升级后 `app/plugins/__tests__/with-jpush.test.ts` 会先红**，prebuild 时锚点失效直接抛错不静默漏补。
- **为什么要转发 delegate**：极光初始化会把自己设成 `UNUserNotificationCenter.delegate`，把 expo-notifications 顶掉——不转发的话 SOS 锁屏本地通知的「取消 / 查看」按钮（`services/sos-alert.ts`）全废。
- **为什么不在 AppDelegate 里初始化极光**（社区插件 mx-jpush-expo 是这么干的）：SDK 必须等用户同意隐私政策后才能起（商店合规，THIRD_PARTY §6）。初始化在 JS `services/push.ts`：登录态钩子 `use-realtime.ts` 调 `startPush(userId)` → 读 `consent-store`，同意了就 `init + setAlias`，没同意就挂起等同意那一刻；同意的入口有三个：注册页勾选、登录页勾选（本机首次）、以及**已登录但本机未同意时的一次性弹窗** `components/privacy-consent-modal.tsx`（升级用户走这个，APP-04）；登出 `stopPush()` → `deleteAlias`。**监听必须先于 init 挂上**：Android 被杀状态下点通知启动 App，`init()` 里会回放缓存的那次点击。
- **AppKey** 在 `app.json` `extra.jpush.appKey`（公开值，JS 与插件共用一份）；Master Secret 只在服务器。
- **Android 厂商通道——华为（2026-10-08 起，上线清单 A-11）**：App 被杀后只有厂商通道能把 SOS 推送送到。`with-jpush.js` 在项目根有 `app/agconnect-services.json`（AGC 控制台「不包含密钥」版，不含 client_secret / api_key，进 Git）时自动接：项目级 `build.gradle` 加华为 maven 仓库 + `com.huawei.agconnect:agcp:1.9.1.301`，应用级加 `apply plugin: "com.huawei.agconnect"` + `cn.jiguang.sdk.plugin:huawei:6.2.0`（**版本必须与 jpush-react-native 自带的 JPush SDK 一致**，单测对照）+ `com.huawei.hms:push:6.13.0.300`，并把该文件拷进 `android/app/`；agcp 碰到模板里不带版本的 `classpath('com.android.tools.build:gradle')` 会报「is no set」，插件把那一行改写成带版本的（版本从 `react-native/gradle/libs.versions.toml` 的 `agp` 读，与原来解析到的一致）。没有这个文件只警告、照常 prebuild。**接入后所有 Android 开发包都要 `npx expo prebuild --platform android` 重建**。验收用华为真机：杀掉 App → 注入 SOS → 锁屏应收到「SOS 倒计时已开始」；在华为「自分类权益」批下来之前推送按资讯营销类处理（静默展示、限条数），批下来后由服务端在 `JPUSH_THIRD_PARTY_CHANNEL` 带上消息分类才会响铃弹横幅。AGC 里登记了 Expo 模板的公共调试签名指纹供开发包测试，**正式上架前要在 AGC 删掉那条**。小米通道等账号审核通过后同样方式加（`manifestPlaceholders` 的 `XIAOMI_APPID` / `XIAOMI_APPKEY`）。
- **APNs 环境要对齐**：App 侧 `production: !__DEV__`（Xcode Debug 包 = development，Release/TestFlight = production），服务端 `JPUSH_APNS_PRODUCTION` 要和装机包一致，不一致极光会静默丢或报 1011。
- **权限**：极光 SDK 的 manifest 带 `READ_PHONE_STATE` / 外部存储 / `GET_TASKS` / `ACCESS_BACKGROUND_LOCATION`，全部用 `app.json` `android.blockedPermissions` 屏蔽（`audit-app-config.test.ts` 钉住）。
- **本机怎么验**：dev 云端后端已切极光真发。登录后 Metro 日志看 `[PUSH] registrationID …` 与 `setAlias <userId>`；服务端触发 SOS（Mock `SCENARIO=fall`）→ 手机应收到「SOS 倒计时已开始」；分别在前台 / 后台 / 杀掉 App 三态各点一次通知，前两态应进倒计时页，被杀态应先冷启动再进（REGRESSION 4.6–4.8）。
- **已知未验证（2026-09-24 夜，无真机）**：① `RCTJPushModule` 是老式 NativeModule，靠新架构 interop 跑（`RCTBridgeProxy` 有 `launchOptions` / `enqueueJSCall`，理论上够）；② ~~Swift 转发写法能否编译~~ → ✅ **2026-09-24 00:0x 本机结果**：`xcodebuild` Debug（iPhone 14 Pro Max，公司团队）**BUILD SUCCEEDED**，AppDelegate 补丁与 bridging header 编译通过；`gradlew assembleDebug`（arm64）**BUILD SUCCESSFUL in 59s**，APK 内 `JPUSH_APPKEY/CHANNEL` meta-data 已解析、五个屏蔽权限确认不在包里（`aapt2 dump permissions`）。iPhone 装新包冷启动：`[PUSH]` 读到 AppKey（首版用 `expo-constants` 读 `extra` 在 dev-client 上为空，改为直接 `import app.json`），登录态钩子按预期打出「未同意隐私政策，推送 SDK 暂不初始化」——**SDK 真正 init / setAlias / 收推送三态要等真机上勾一次同意（登出→登录页勾选），未测**；③ 华为不走厂商通道时被杀后的到达率（THIRD_PARTY §6 厂商通道待注册）。

## 开屏动画（2026-10-08 起，`app/src/components/splash/`）

冷启动时盖在整个 App 上面的一层：骑行路线随镜头升起、凝聚成商标（约 2.2 秒），然后按情况接到页面上——没登录落到登录页；已登录有头盔，商标外画出电量环、扫描显出头盔、滑到设备页；已登录没头盔，引导卡从商标的位置立起来。设计原型是三份单文件网页（负责人 2026-10-08 定稿），这里是照它移植的。

**规则（负责人定）**：每次冷启动播完整的；由通知拉起、或播到一半进了求救页，不播 / 立刻收掉；设备列表没回来时按本机记住的上次结果播（`stores/launch-memory-store`），没有记录就在商标上最多等 1 秒、然后直接进页面。另外两条是实现时定的：用户选了浅色外观、或系统开了「减弱动态效果」时不做落位，商标停一下整层淡出（三种落位都是按深色页面设计的）。这一层挡着触摸，所以有一个 9 秒的总时限，到点无论如何让开。

**路线那一段是预录的，两个平台播的东西不一样。** 这一段每帧要画几千个点，在手机上逐帧用 JS 算出来再交给 Skia，光是调用的固定开销就占掉大半帧（模拟器实测 11.7 毫秒 / 帧，230 帧里 30 多帧超时）。画面是固定的，所以在电脑上用同一份画法代码（`route-scene.ts`，换成 CanvasKit 跑）先画好：

- **iOS 播矢量的预录帧**：每一帧录成 Skia 图片，打成 `app/assets/splash/route-frames.skpack`（133 帧，8.9 MB，进安装包后压到约 2.7 MB），App 里只管播放。iPhone 14 Pro Max 上是流畅的（2026-10-08，开发包、120 Hz：454–458 帧里超过 25 毫秒的 0–2 帧）。读不到这个文件时退回实时画，不会黑屏。
- **安卓播视频**：同样的 133 帧画成像素、压成 `app/assets/splash/route-video.mp4`（720 × 1840、每秒 60 帧、H.264，1.1 MB；片头垫 12 帧底色、片尾垫 6 帧），交给系统的播放器（`expo-video`：解码在它自己的线程里，画面由系统单独合成，不经过 App 的主线程）。原因是矢量帧在安卓这一档的显卡上画不动——华为 P30 Pro 实测（2026-10-08）一帧 89 毫秒（1080 × 2340），画布降到 720 宽还要 52 毫秒、360 宽 25 毫秒，路线段只有每秒 30 帧上下；画布上什么都不画时是满 60 帧，说明就是卡在画上。也试过 Skia 自带的视频对象：它在主线程上一帧一帧同步地等解码器（每帧 5–10 毫秒，还要求最低 Android 8），华为照样掉到 30 帧。视频放不了时（文件读不到、解码器不认、2.5 秒内第一帧没出来、叫它放了 0.7 秒还没走）退回矢量的预录帧——能播完，只是不流畅；四种情况都在模拟器上人为造出来试过。

```bash
cd app
npx tsx scripts/build-splash-frames.ts             # 重录矢量帧（iOS 用）
npx tsx scripts/build-splash-video.ts              # 重录视频（安卓用）；要先装 ffmpeg（brew install ffmpeg），约两分钟
python3 scripts/gen-splash-route.py <route.json>   # 路线和商标轮廓的数据（来自设计原型），一般不用动；生成的 route-data.ts 不要过 prettier
npx tsx scripts/splash-frames.ts <目录> 300,980,1500   # 把某几个时刻画成 PNG，改画法时对照着看
```

改了 `route-scene.ts` 的画法 / 参数、改了成标之前的节奏：**两个都要重录**（单测 `splash/__tests__/route-video.test.ts` 会核对两边是同一批、文件和代码里的约定对得上）。升级 `@shopify/react-native-skia` 之后矢量帧必须重录（图片格式跟着 Skia 版本走，`route-frames.test.ts` 会拦住）。`.skpack` 这个扩展名在 `app/metro.config.js` 里登记成了资源文件。

**安卓播视频这条路要知道的几件事**（`splash/route-video-layer.android.tsx`，iOS 那边是同名的空文件，代码里不出现 expo-video）：

1. **视频和盖在它上面的东西各走各的钟。** 开屏的时钟起步时先叫播放器开始放，读一次它的播放位置对表（片头垫了 12 帧底色，对表在这 0.2 秒里完成），之后视频按播放器的钟走，开屏的时钟按实际过去的时间走。对完表两边仍会差一两帧：视频的每一帧由系统按时刻直接送上屏幕，App 自己画的东西要晚一两帧才到。所以视频的**内容**做成了不怕这点误差的——矢量的实心商标一直留到片尾（盖在上面的商标原图是叠在一模一样的形状上显出来的），放完就停在最后一帧上（画布早一点晚一点接手都是同一个画面）。头一版视频按时把矢量商标撤掉，成标那一刻商标会暗一两帧，是逐帧检查录屏时抓到的。
2. **用 SurfaceView，不用 TextureView。** TextureView 是 App 自己把视频当一张贴图画，播放器提前送来的帧会被挤掉或重复：模拟器上 2.4 秒的路线段里有 7–13 帧重复；SurfaceView 四次录屏里一帧都没有重复。
3. **安卓模拟器上这一段的底色偏亮**（应该是 14,15,18，显示成 27,29,31），开头和成标那一刻各跳一下。这是模拟器合成 SurfaceView 的视频时没按「有限范围」换算——缓冲区上标的色彩空间是对的（`dumpsys SurfaceFlinger` 里是 `V0_BT709`），同一个模拟器换成 TextureView 颜色就对了。**看这一段的效果以真机为准。**
4. **画布到商标完成才接手，接手前要先悄悄画几帧。** 视频放着的时候画布是空的；显卡第一次画「商标完成之后的画面」要现编程序、现开缓冲，是 50–80 毫秒的一帧（模拟器），落在成标那一刻就是肉眼可见的一顿。开播前盖着底色预热的办法在已登录时不管用（主线程正忙，那两帧多半没真的画出来）。现在的做法是在路线刚开始的一小段（故事时间 150–230）让画布把那幅画面以 1/255 的不透明度画几帧：卡的那一下落在只有视频在动的时候，视频由系统单独合成、不受影响。成标时画布用 50 毫秒淡进来，淡入是在画布里面做的（整幅先画进一层再合上去），不能去调那块视图的透明度——透明度是 0 的视图系统根本不画。
5. **画布接手之后，视频那一层是挪到屏幕外，不是卸掉。** 卸掉它（连同放掉播放器）要在主线程上等解码器交还显示表面，是几十毫秒的一顿，正落在商标收小、品牌名浮出来的时候；挪走不用等，到开屏收场时才真的卸。必须挪走：视频的显示表面垫在窗口后面，留在原地的话后面画布淡出时露出来的是它而不是页面。片尾只垫 6 帧也是为了这个时刻——视频放完解码器自己就歇了，不用 JS 去叫停（那一刻 JS 正忙着搭页面，叫不动）。
6. 播放器是静音的、不申请音频焦点（这个 App 里正在响的可能是对讲或求救提示音），没有配 expo-video 的插件，所以不带后台播放的前台服务和画中画；由通知拉起（不播开屏）时不建播放器。
7. **播放器偶尔会在起步时报错**（华为 P30 Pro 上四十多次冷启动里遇到两次，`Unexpected runtime error`）。还没备好就报错时换一个播放器重试，最多两次，重试那一次都成了；都不行才退回矢量帧。
8. **资源文件不能只靠扩展名区分。** 视频最初叫 `route-frames.mp4`，和 `route-frames.skpack` 同名不同扩展名；安卓正式包里资源名不带扩展名，两个撞名，`mergeReleaseResources` 直接失败——调试包里资源走开发服务器，所以要到按正式方式编包才暴露。单测 `src/__tests__/audit-asset-names.test.ts` 拦这一类。
9. React Compiler 会把「不捕获任何变量的内联函数」提到模块顶层。这样的函数要是写在 worklet 里（比如 `createPicture(() => {})`），到了 UI 线程就成了「另一个线程的函数」，一调用就抛 `Tried to synchronously call a Remote Function`。

**为了不卡做了五件事**（都是 2026-10-08 量出来的，改这一块之前先看）：

1. 等页面搭好、JS 线程闲下来再起步。已登录时一启动各个标签页一起搭（地图的 WebView、手势库都在这时初始化），一次能占主线程上百毫秒。等的这段时间屏幕是一片深色，最多 1.5 秒，平时零点几秒。
2. 页面上重的内容（设备页的大图和列表、引导卡）在路线那一段期间先画骨架，到商标刚成形、画面静止的那一刻再搭（`useSplashHold`）。
3. 原生启动画面一出第一帧就收掉、换成这一层自己的深色底，然后在底色下面先把几帧有代表性的画一遍（显卡第一次用到模糊这类效果要现编程序）。
4. 画布每个 dp 最多用 2 个像素画，再放大铺满屏幕：路线带着好几层全屏模糊，3 倍屏按全分辨率画，GPU 的活是按 2 倍画的两倍多。商标完成之后那圈光的模糊层只开到商标那么大（`drawRouteScene` 里给 `saveLayer` 传了范围），不给范围就是整块画布陪着模糊三遍；出图逐像素比过，只有个别像素差 1 级。
5. **样式没变就别往原生推**（`splash/steady-style.ts`）。Reanimated 判断「这一帧样式变没变」是逐项比引用，样式里只要有 `transform`（每次求值都是新建的数组）就算变了，整份样式推给原生、走一遍界面树的提交。开屏那四秒里故事时间每帧都在变，跟着它的十几二十个元素（`SplashArrive` 包着的每一块、商标、品牌名……）大多数时候没动，却每帧都在推。把动画样式包一层 `steady(id, {...})`：数值没变就交回上一次那个对象。模拟器上主线程每帧的活，路线那一段从 3.1 毫秒降到 0.6，播完前的最后一段从 3.2 降到 1.9。**以后写跟着某个每帧都在变的值走的动画样式，带 transform 的都照这样包。**

**流畅度怎么量。** 每次播完会打几行 `[splash]` 开头的日志：路线段是怎么播的（安卓上依次是「视频备好，用了多久」「视频起步多久」）、一共多少帧、其中超过 25 毫秒的有几帧、出现在什么时刻。开发包里总是打；别的打包方式要在打包时带上 `EXPO_PUBLIC_SPLASH_LOG=1`，日志在 `adb logcat -s ReactNativeJS`。几点要知道：

- **调试包量不准，要用按正式方式打的包量。** 调试包的原生代码没开优化，Reanimated 每帧往原生推更新的那条路在华为 P30 Pro 上慢得多：同一段落位，调试包每次慢 11–16 帧，正式方式打的包 0–4 帧（见下表）；连播完后静止的设备页，调试包主线程每帧都要 10 毫秒上下。只把 JS 按正式方式打（`npx expo start --no-dev --minify`）不够，原生那一半还是调试的。
- 在手机上并排装一个正式方式打的测试包、不动上面的开发包：临时在 `app/android/app/build.gradle` 的 `release` 里加三行——`applicationIdSuffix ".perf"`、`versionNameSuffix "-perf"`、`manifestPlaceholders = [JPUSH_PKGNAME: "com.lingyiweichuang.app.perf"]`（极光的 provider 按这个占位符起名，不改会和开发包冲突装不上）——再放一个 `app/src/release/res/values/strings.xml` 改应用名，然后 `EXPO_PUBLIC_SPLASH_LOG=1 ./gradlew :app:assembleRelease -PreactNativeArchitectures=arm64-v8a`（默认用调试证书签名），编完把这几处改回去（`android/` 是生成的，不进 Git）。拉起：`am start -n com.lingyiweichuang.app.perf/com.lingyiweichuang.app.MainActivity`。它连的是 `app/.env` 里的后端；在里面登录等于同一个账号多了一份 App，量完 `pm clear` 或卸掉，别让两份同时去连头盔。
- 日志数的是开屏自己那一层（时钟、商标、文字、画布）的帧，**量不到安卓视频本身掉没掉帧**。视频看系统合成器的记录：播着的时候 `adb shell dumpsys SurfaceFlinger --list | grep SurfaceView` 找到那一层的名字，再 `dumpsys SurfaceFlinger --latency "<名字>"`，拿到最近 127 帧各自上屏的时刻，相邻两帧隔一个刷新周期就是没掉帧。有 `screenrecord` 的设备（模拟器）也可以录屏按原始时间戳逐帧看；华为没有这个命令。
- 想知道某一段慢在哪：`adb shell atrace --async_start -c -b 30000 -a <包名> gfx view`，冷启动，`atrace --async_stop -o /data/local/tmp/t.trace` 拉回来，看主线程每个 `Choreographer#doFrame` 里 `animation`（Reanimated 和画布在这里）、`traversal`、`MountItemDispatcher::mountViews` 各占多少。加上 `sched freq` 两类数据量太大，华为上 App 会卡在启动里出不来。
- 安卓上日志末尾常带一句「另有 1 帧慢在只有视频在动的时候（看不出来）」：是上面第 4 条故意放在那里的那一帧，不算进超时的帧数。
- 日志是「视频没放成，退回逐帧画」时，这台手机走的是矢量帧那条路，记下机型和前面那行「视频报错」的原因。
- Metro 认不出运行期间新增（或挪走又放回）的 `.android.tsx` / `.ios.tsx`，动了这类文件要重启 Metro；起 Metro 时不要带 `CI=1`，那样它不监听文件改动。

量到的结果（2026-10-08）。「慢的帧」= 开屏那一层超过 25 毫秒的帧，基本都是 33 毫秒的单帧，出现在商标成形之后：

| | 每次冷启动慢的帧 | 备注 |
|---|---|---|
| **华为 P30 Pro，正式方式打的包**，没登录，6 次 | 0–2（约 274 帧里） | 装包 / 清数据后的头一次 7 帧 |
| 同上，已登录、有头盔（云端测试账号），17 次 | 0–4（约 245 帧里） | 装包后的头一次 11 帧；刚登录完的头几次 3–12 帧 |
| 华为，视频那一段本身 | 147 帧，帧与帧都隔一个刷新周期，没有重复 | 合成器的记录；底色视频里 13,15,17、画布 14,15,18 |
| 华为，调试包，没登录 / 有头盔 | 12–16 / 11–16 | 原生没开优化，见上；不代表正式包 |
| 华为，安卓也播矢量帧的那一版（调试包） | 270 帧里 108–120 帧 | 路线段每秒 30 帧上下，所以才换成视频 |
| 模拟器（Pixel 8），调试包、JS 按正式方式打：没登录 / 有头盔 / 没头盔，各 6 次 | 0 / 1–4 / 0–5 | 同条件播矢量帧是 0 / 0–2 / 2–4；视频段录屏逐帧 5 次没有重复帧 |
| iPhone 14 Pro Max，开发包、120 Hz | 454–458 帧里 0–2 | 播矢量帧；下午这几处改动之后没有重新量 |

**页面要配合的地方**：登录页顶部的商标和标题、设备页的大图和连接状态、引导页的卡片和徽标，都包了一层 `SplashAnchor`（把自己的位置报给开屏，开屏代画它的时候先藏起来）；依次进场的内容包了 `SplashArrive`。设备页大图「长什么样」写在 `splash/hero-splash.ts`，页面和开屏画的替身共用——改了大图的颜色、位置、文案，要一起改。在 worklet 里用到的函数必须定义在用它的函数**前面**（闭包按源码顺序捕获，顺序反了运行时报 `undefined is not a function`）。

**原生侧**：新增了 `@shopify/react-native-skia` 和 `expo-video`（都是原生库，要重新打包才有；是否采用见 DECISIONS「待定决策」），`app.json` 里原生启动画面的图换成了一张透明图（纯深色底，同样要重新 prebuild）。iOS 用个人证书构建过、在 iPhone 14 Pro Max 上跑过（那一版还没有 expo-video；iOS 的代码不用它，但下次构建会把它一起链进去）。

### 没有头盔时的三步指引（`app/src/components/device-guide.tsx`）

一张卡走到底（改版原型「设备页 · 未绑定：一张卡走到底」，负责人 2026-10-08 晚定稿）。逻辑在 `services/device-guide.ts`（纯函数，有单测）：轮到哪件、哪件会自己打勾、一件事处理完之后那一段怎么演（`guideBeat`：光回不回徽标、出不出去点亮按钮）。改这一页的动作时记住几条：

- **只动位移、缩放、透明度**。上一版是三张卡轮换，换位置时每一帧都在改卡片的 `left / top / width / height / borderRadius`，卡片里的字和按钮每帧都要重新排版——负责人在真机上的反馈是「卡片切换动画太不流畅」。现在最前面那张卡的位置和大小从头到尾不变；后面压着的卡往前挪用位移加横向缩放，它左上角那行名字反着缩回去（不然字会被压扁）。
- **换到下一件的那一段只有一个时钟**（`beat`，0 到 1700 毫秒）：旧内容淡走、光回徽标、徽标应一下、新内容浮上来、光出去、按钮点亮，都从它算，时间表在文件顶上的 `BEAT`，数字照原型。起这个时钟的那几个共享值要在记结果（`mark`）**之前**设：共享值比页面重画早到动画线程，新内容搭上来的那一帧才已经是「还没浮上来」的样子，不会先整个闪出来一下。
- **勾和那道光是 Skia 画的**。勾是两条路径按比例裁出来（先圈后勾）；光和开屏落位时那道是同一个画法（虚线 + 模糊）。头一回画这道光显卡要现编程序，所以这一页一搭好就先几乎全透明地画几帧（和开屏同样的做法）。没有光在走时每次交回同一张空图，画布不重画。
- **画勾只在人看着的时候走**（`onStage`）：人不在这一页时把勾擦掉，回来重新画——这个过程一个账号只看得到一次。已经具备的那件事，等它的内容浮上来到位之后才开始画勾；「到位了没有」按上一件处理完的时刻（`guide-store` 的 `markedAt`）算，页面里换下一件的定时器和画勾用的是同一个算法（`untilSettled`），改一处要看另一处。
- 跟着每帧的时钟求值的样式照旧包一层 `steady()`（见上面开屏那一节）。

量法：模拟器上录屏逐帧看（`adb shell screenrecord` 加 `ffmpeg -vf fps=30`），再用 `adb shell dumpsys gfxinfo <包名> reset` / `dumpsys gfxinfo <包名>` 看这一段掉了几帧。2026-10-08 模拟器（Pixel 8，JS 按正式方式打）：三件事连着做完的整条链 574 帧里慢了 5 帧。**两台真机都还没看**；模拟器用的是电脑的显卡，说明不了手机。

## 实时视频预览（2026-09-30 起，决策 #37/#49）

入口：设备详情 →「实时画面」（路由 `/video-preview`）。约定见 DEVICE_PROTOCOL §1.3：热点 `X821cam` / `Aa123456`，`rtsp://192.168.176.1:8554/ch0`，H.264 720p30 无音频，强制 RTSP over TCP。

- **组成**：播放器 `react-native-vlc-media-player`（libVLC，参数沿用 Spike）；连热点与存截图是本地 Expo 模块 `app/modules/helmet-wifi`（Kotlin + Swift）；页面状态机在 `app/src/services/video-preview.ts`，页面只接线。
- **Android 连热点**：Android 10+ 用 `WifiNetworkSpecifier` 由系统弹窗确认连接，连上后 `bindProcessToNetwork`——不绑的话头盔热点没有互联网，系统把默认路由留在 4G，RTSP 走 4G 黑屏。Android 8/9 没有这个 API，页面转「手动连接」引导：去系统设置连好 → 点「已连接，继续」→ 绑定当前 Wi-Fi。
- **绑定的代价**：绑定期间本进程所有连接都走头盔热点，**App 连不上云端**（BLE 中转上传、WS、REST 都会失败，事件留在上行队列）。所以只在预览页前台持有，三种情况同步释放并立即补传：离开页面、退后台、**摔倒 / 求救事件入队**（`ble-relay-uplink.ts` 的 `onSosRelayEvent`，在上传发起前回调）。危险预警不打断预览（留档，不赶时间）。
- **iOS 连热点**：`NEHotspotConfiguration` + `joinOnce`，退后台约 15 s、锁屏或 App 退出时系统自动断开并删配置。不需要绑定。**需要 App ID 勾选「Hotspot」能力**（app.json 已加 entitlement `com.apple.developer.networking.HotspotConfiguration`；✅ 负责人 2026-09-30 已在 developer.apple.com → Identifiers → `com.lingyiweichuang.app` 勾上，旧描述文件随之失效，Xcode 自动签名下次构建会重新生成；命令行构建记得带 `-allowProvisioningUpdates`）。首次拉流会弹「本地网络」授权，拒绝了永远连不上，只能去设置里开。
- **截图**：从解码器取帧（VLC `snapshot`，PNG），不向头盔要 JPEG；再用模块存相册（iOS 只申请「添加照片」；Android 10+ 走 MediaStore 存到 `Pictures/零一唯创`，8/9 需要的存储权限被合规屏蔽，提示不支持）。
- **本页不发外网请求**：页面不引用 `@/api` 与 react-query（`audit-video-preview.test.ts` 钉住）。

### 无硬件怎么测（开发包，`__DEV__` 才生效）

先在电脑上起测试流：`tools/rtsp-mock/start_rtsp.sh`（彩条 + 时间戳，同 §1.3 约定）。然后用深链打开预览页（App 已登录）：

```bash
# ① 只测播放器：手机和电脑在同一个普通 Wi-Fi 下，跳过连热点
xcrun simctl openurl booted "app://video-preview?url=rtsp://<电脑IP>:8554/ch0&join=0"   # iOS 模拟器
adb shell am start -a android.intent.action.VIEW -d "app://video-preview?url=rtsp://<电脑IP>:8554/ch0\&join=0"   # Android 真机
# ② 连接 + 绑定整条路径（最接近真头盔）：用另一台手机开热点，名称 X821cam、密码 Aa123456，并关掉它的移动数据
#    （模拟头盔热点没有互联网）；电脑连上这个热点后起测试流，被测手机打开：
app://video-preview?url=rtsp://<电脑在该热点下的IP>:8554/ch0
```

iPhone 真机没有 adb：在备忘录里写下深链长按打开，或用 Safari 地址栏打开。不带 `url` 参数时就是正式行为（连 `X821cam`，拉 `192.168.176.1`）。

方式 ② 不想把另一台手机改名成 `X821cam` 的话，再加 `&ssid=<那台手机的热点名>&pass=<密码>`（2026-10-14 加，同样只在开发包生效）：`app://video-preview?url=rtsp://<电脑在该热点下的IP>:8554/ch0&ssid=<热点名>&pass=<密码>`。Android 上深链里的 `&` 要用单引号包住整个地址传给 `am start -d`，否则被设备的 shell 当成后台符吃掉。**Android 10 + iPhone 热点再加 `&wpa3=1`**：iPhone 热点是 WPA2/WPA3 混合，Android 10 把它归为 WPA3，按头盔协议的 WPA2 去请求永远匹配不上（系统弹窗一直转圈，30 s 后报「该应用已取消」）；`wpa3=1` 走模块的 `connectSae`（只在 Android 上有，真头盔纯 WPA2 不受影响）。

## 平台限制清单（持续维护）

> 记录 Week 2 Spike 及后续开发中实测到的 iOS / Android 系统限制。禁止静默降级——任何限制先记录在此并与负责人确认口径。

| 日期 | 平台 | 能力 | 实测限制 | 口径/结论 |
|------|------|------|---------|----------|
| 2026-10-14 | Android 10（华为 P30 Pro） | 视频预览连头盔热点：热点的加密方式 | 热点是 **WPA2/WPA3 混合**时（iPhone 个人热点默认就是），`WifiNetworkSpecifier` 按 WPA2 请求永远匹配不上（系统弹窗转圈到超时），按 WPA3 请求也不行；只有纯 WPA2 热点能 3 s 内列出并连上。Android 10 的匹配逻辑把混合加密一律当 WPA3 | **真头盔的热点必须是纯 WPA2（不开 WPA3 / 混合模式）**，已列入向硬件确认项；开发期用 iPhone 热点测要开「最大化兼容性」（变成纯 WPA2 + 2.4 GHz），深链见「无硬件怎么测」 |
| 2026-10-14 | Android（华为 P30 Pro / EMUI 10） | 视频预览连头盔热点（`WifiNetworkSpecifier` 系统选网弹窗） | ① 弹窗是 Settings 的另一个 Activity，一弹出 `AppState` 就变 `background`：预览页「退后台即释放头盔 Wi-Fi」的逻辑把 68 ms 前发出的请求撤回，弹窗报「出了点问题。该应用已取消选择设备的请求」，点掉回前台又重发，无限循环，真头盔也连不上；② `onUnavailable` 不区分用户取消 / 找不到 / 超时；③ App 侧 `requestNetwork` 超时到期撤回请求时，若弹窗还开着，系统同样显示上面那条错误，要用户再点一次 | ① **已修（#102 分支 10-14）**：phase 为 `joining` 时忽略 `background`（连上之前没绑任何网络，请求本身有 30 s 超时兜底）；连上时若 App 已在后台，照退后台处理、回前台再连。② 文案统一为「没有连上头盔 Wi-Fi…」，REGRESSION 9.10 的预期按此改。③ 待 B 线定：Android 10+ 有系统弹窗时是否取消 App 侧超时 |
| 2026-09-30 | Android | 头盔热点绑定（视频预览） | `bindProcessToNetwork` 让本进程所有连接走头盔热点，绑定期间 App 连不上云端（BLE 中转上传、WS、REST） | 只在预览页前台持有；离开 / 退后台 / 摔倒求救入队时同步释放并立即补传；页面文案告知「此时手机无法上网」。**设计口径，待真机实测确认** |
| 2026-09-30 | Android 8/9 | 程序化连 Wi-Fi、截图存相册 | `WifiNetworkSpecifier` 只有 Android 10+；存相册在 8/9 需要存储权限，而该权限因商店合规被 `blockedPermissions` 屏蔽 | 8/9 走「去系统设置手动连 → 已连接，继续」引导；截图提示不支持保存。决策 #49 已接受 minSdk 26 |
| 2026-09-30 | iOS | 连头盔热点（NEHotspotConfiguration） | 需要 App ID 开 Hotspot 能力；`joinOnce` 下退后台约 15 s / 锁屏系统自动断开；首次拉流弹「本地网络」授权，拒绝后连不上；部分 iOS 版本热点不在范围内时 `apply` 也回调成功 | 预览只在前台；用途说明已配；「apply 成功但没连上」靠 5 s 无画面提示兜底，不做 SSID 校验（校验要再开 Access Wi-Fi Information 能力）。**待真机实测确认** |
| 2026-10-08 | Android（华为 P30 Pro 实测） | 系统状态栏的深浅 | Android 上状态栏的时间、电量、信号默认一直是白色：原生主题里没有写 `windowLightStatusBar`，expo-router 57 也不再替 App 放一份 `<StatusBar style="auto" />`。App 内选浅色外观时白字压在浅色页面上，量到的对比度是 1.0 : 1，等于看不见。iOS 会自己跟着界面的深浅变，没有这个问题 | 根布局放一份 `<StatusBar>`，深浅取 App 自己的外观（`hooks/use-color-scheme`），不取系统的；放在最前面，扫码页、倒计时最后 10 秒各自的那一份后挂载、会盖过它，页面关掉再还回来。改后浅色下 8.1 : 1。开屏那几秒画面是深色的，浅色外观下根布局那一份（深色字）压在上面看不清：开屏遮罩里另放了一份 `style="light"`（`splash/splash-overlay.tsx`，后挂载、盖过根布局那一份），深色画面淡到一半时撤掉，状态栏回到根布局那一份——模拟器（Android 16）逐帧量过，真机还没看。回归见 REGRESSION 7.8、1.5.16 |
| 2026-10-08 | iOS（iPhone 14 Pro Max，iOS 26.6，开发包） | 挂着调试器往 App 里发命令 | 经 Metro 的调试通道对真机上的 App 执行 JS（`Runtime.evaluate`）时，一晚上两次把 App 带崩。两份崩溃记录一样：`EXC_BAD_ACCESS`，JS 线程，`hermes::vm::CodeBlock::getSourceLocation` ← `Debugger::runUntilValidPauseLocation` ← `Debugger::runDebugger`，再往下是 `expo::EventEmitter::emitEvent`——调试器的打断正好落在原生事件的回调里（求救页的警报音、扫码页），Hermes 的调试器自己解了空指针。同一页不挂调试器跑满一分钟没有问题；华为上没出过 | 是调试工具的问题，不是 App 的：崩溃记录里有 `Debugger::runUntilValidPauseLocation` 的，不用往业务代码上查；正式包里没有调试器。真机上用调试器（包括 React Native DevTools 的控制台）时，在警报音这类原生事件很密的页面上尽量别发命令；要在这种页面上取东西，先把动作排进 App 里自己跑，跑完回到安静的页面再取 |
| 2026-10-08 | 双端（地图 WebView） | 深色底图上的轨迹与标记颜色 | 压暗底图的滤镜会连带改掉品牌色：① Android 深色是给地图画布挂 `saturate(0.35) brightness(0.85)`，`AMap.Polyline` 和底图画在同一张画布里，轨迹被去掉六成多饱和度（量到 `#CCD49C`）；② iOS 深色是给整个地图容器挂 `invert(0.88) hue-rotate(180deg) …`，轨迹和 Marker 都被反色，原来靠「预反色」的颜色去凑——但反色 + 转色相保不住亮度，亮黄的原像是暗蓝，怎么凑都只能得到橄榄绿（负责人 iPhone：头像旁的颜色和轨迹不是品牌黄）。高德 JS API 2.0 的 DOM 结构（Chromium、WebKit 上一样）：`.amap-layers` 下面是一张底图画布 + `.amap-markers`（z 120）；`AMap.CustomLayer` 的画布是它下面单独的一层 `div.amap-layer`（z = 图层的 zIndex），视野每变一帧高德都会回调它的 `render`，静止时不回调 | ① 轨迹改画在 `AMap.CustomLayer` 的画布上（zIndex 100，在底图之上、Marker 之下），Android 的滤镜收窄到 `.amap-layers > canvas`（只压底图）；② iOS 深色改成在 `.amap-layers` 里盖一层只带 `backdrop-filter` 的透明层（z 1）：它只改压在下面的底图，上面的轨迹画布和 Marker 原色显示，「预反色」那套只留作系统不认 backdrop-filter 时的退路；iOS 深色明确要普通样式再自己压暗。验证：Android 模拟器 App 内；同一份 HTML 在 iOS 26.5 模拟器 Safari 里（深色新旧两条路、浅色）。**iPhone 真机的 WKWebView 还没看过**——如果真机上底图不压暗或黑屏，把 `BACKDROP_OK` 判成 false 就回到原来的画法。可复用的测试页脚本在 `helmet-ui-shots/map-webkit-harness/`（仓库外） |
| 2026-10-08 | Android 13+（Android 16 模拟器实测，真机待补） | 通知权限 · 首次登录 | expo-notifications 的 `getPermissionsAsync()` 在用户授权之前（包括系统授权框还开着的时候）报的就是 `denied`，不是 `undetermined`：库里只要系统的通知开关是关的就一律报 denied（`NotificationPermissionsModule` 的 API 33+ 一支；Android 13+ 新装的 App 通知默认关）。所以按「不是 undetermined 才算被拒」来判（评审 R-31 的修法）在 Android 13+ 上不成立——全新安装第一次登录，系统框下面已经弹好了 App 的「通知未开启」说明框，点了「允许」它也还在。华为 P30 是 Android 10，没有这个授权框，一直测不到。另外两点：① 第一次点「不允许」后系统紧接着再问一次通知权限——`ble-link.ts` 的 `requestBlePermissions()` 为前台服务的常驻通知另外申请了一次 `POST_NOTIFICATIONS`；② 在两个系统框之间的空当里调 `Alert.alert`，几个框都点完后这张说明框不在屏幕上（丢了） | 界面读通知权限之前先等登录后那一次申请有结果（`readNotifyPermissionAfterAsk`）；说明框等系统框都走完、App 连续在前台满 1 秒再弹（`whenForegroundSettled`）。全允许 / 全拒绝 / 先拒后允许 / 彻底拒绝后重启四种模拟器上验过（REGRESSION 8.6）。**被拒后连问两次是现状，没动**：去不去掉 ble-link 里那一次要负责人定，改它要真机复测。Android 13+ 真机、iPhone 都还没复验 |
| 2026-10-08 | 双端（开发包） | 屏幕常亮 | Expo 的开发工具在开发包里一直开着屏幕常亮（`withDevTools` 里的 `useKeepAwake`，标签 `ExpoKeepAwakeDefaultTag`）：App 窗口的 `KEEP_SCREEN_ON` 始终是开的，App 自己在地图页 / 对讲页 / 倒计时页开关常亮在开发包上看不出来——屏幕本来就不会灭 | 屏幕常亮类的回归（REGRESSION 3.16 / 6.11 / 倒计时页亮屏）真机上用正式包跑。开发包上要量：先经 Metro 的调试通道执行 `expo.modules.ExpoKeepAwake.deactivate('ExpoKeepAwakeDefaultTag')` 摘掉开发用的那一层，再看 `dumpsys window windows` 里 App 窗口的 `fl=KEEP_SCREEN_ON`（2026-10-08 模拟器这样量过，两页的开关都对） |
| 2026-09-23 | iOS | 换团队后装机 | 公司团队签名包无法覆盖安装个人团队签名的旧包：`application-identifier` 从 `LZ3H94F5LC.` 变 `B3NHB45FS7.`，系统 `rejecting upgrade` | 换签名主体必须先卸载旧 App 再装（App 数据与登录态会清空）。Android 换正式签名同理 |
| 2026-09-23 | iOS | 公司团队首次签名 | 团队下没有已注册设备时构建报 `Your team has no devices`；指定真机构建又报 `Device isn't registered`，`-allowProvisioningUpdates` 不会自动登记设备 | 先在 developer.apple.com → Devices 手工登记 UDID（本机 iPhone 14 Pro Max = `00008120-001808C93468201E`），再构建即可自动签发描述文件 |
| 2026-09-23 | 双端 | 实时通道 WS | iPhone 真机 Release 实测：WS 每 8–30 秒被网关以 `4401 访问令牌已过期` 断开并重连，日志刷屏、耗电、推送有间隙。根因不在服务端（从 Mac 直连同一账号 30s+ 稳定收消息），而在客户端 4401 后的处理：原来只发一个普通请求指望它 401 才触发刷新，而同一 token 在 REST 这边尚未判过期 → 请求 200、不刷新 → 拿着同一个 token 无限重连 | 4401 改为主动换新 token（`forceRefreshTokens`，2026-09-23 修）。修后真机复测：断线间隔从 8–30 秒拉到 **~10 分钟**（= access token 的 15 分钟有效期边界），每次 3–9 秒内自动恢复。**4401 不会完全消失**——网关按设计在 token 到期时断开，客户端换新 token 重连即可；真正修掉的是「拿着同一个过期 token 无限重连」。若要连边界上的几秒空窗也消掉，需要在 token 到期前主动刷新并重连（暂未做，SOS 侧另有冷启动补拉与 `/sos/active` 轮询兜底）。另一类 `code=1006 Socket is not connected` 是息屏后 iOS 挂起 App 的正常断开，回前台自动重连 |
| 2026-09-23 | Android（华为 P30 Pro / EMUI） | 通知 · 勿扰 | SOS 通道建成后 `dumpsys notification` 实测 `mBypassDnd=false`——代码里请求的 `bypassDnd: true` **没生效**：Android 要求应用单独取得「勿扰权限」（Notification Policy Access），普通应用装上默认没有，只能引导用户去系统设置里开。另：`mLockscreenVisibility=-1000`（跟随系统），请求的 PUBLIC 同样未强制 | **手机开勿扰时，锁屏 SOS 提醒会被静音**；锁屏是否显示正文跟随系统「敏感通知」设置。不静默降级：① 已记本行；② 首连提示与蓝牙引导卡后续增加「开勿扰权限」引导（待负责人定是否要打扰用户）；③ 对外口径补「请勿在骑行时开启勿扰」。SOS 通道铃声本身正常（`mSound=系统默认通知音`） |
| 2026-09-23 | Android（华为 P30 Pro） | 通知通道音效 | 给通道传 `sound: "default"` 时 expo-notifications 报 `Custom sound 'default' not found in native app`（每次启动一条 ERROR）——该字段期望的是打包进 App 的自定义音频资源名，不是「系统默认」的别名；实际回落到系统默认通知音，功能没坏但日志脏 | 通道不传 `sound` 即为系统默认（2026-09-23 已改）；要自定义铃声得把音频放进 expo-notifications 插件的 `sounds` 数组 |
| 2026-08-15 | iOS | 签名/推送 | 个人免费开发团队无法签 `aps-environment`（远程推送）entitlement；同一 Bundle ID 无法注册到第二个个人团队 | ~~开发期两人各用独立 Bundle ID~~ → ✅ **2026-09-23 已解除**：公司团队 `B3NHB45FS7`（Shenzhen Lingyi Weichuang Technology）到位，真机包改公司签名，`aps-environment` 正常签出、证书不再 7 天过期，APNs 与 TestFlight 解锁 |
| 2026-08-15 | Android（华为无 GMS） | 定位 | 冷启动首次锁星需 1–2 分钟，一次性 `getCurrentPositionAsync` 长时间挂起无反馈；锁星后 watchPosition 每 2s 稳定更新、精度可到 5m | 定位功能一律用持续监听 + 中间状态展示，禁止一次性等待（负责人已确认口径 2026-08-15） |
| 2026-08-15 | iOS + Android | RTC（TRTC） | 双机对讲互通、锁屏后台音频（iOS 已配 `UIBackgroundModes: audio`）、蓝牙耳机路由，双端真机全部通过 | 无限制发现；支撑 TRTC 选型定案（负责人已确认 2026-08-15） |
| 2026-08-15 | iOS + Android | BLE 后台 | 前台扫描/连接/断连检测双端通过；**后台断连检测未测** | Week 11 防丢开发前必须实测：iOS `bluetooth-central` 后台模式 + 华为激进杀后台 |
| 2026-09-16 | iOS + Android | BLE 中转链路（GATT 已落地） | iPhone 真机对 Mac 仿真头盔实测：前台按广播名扫描 1 s 内发现并完成五步握手（读 deviceId/固件 → 对时 → 补传查询），跌倒事件当秒 ACK；**但不带服务 UUID 过滤的扫描在锁屏/退后台后立即停止投递**（重连扫描 3 分钟无一次发现），改为按 FEE0 过滤后后台可继续扫描——因此**硬件广播包必须携带 FEE0 服务 UUID**（已列为向硬件确认项）。另：JS 重载/进程被杀后 iOS 系统层仍握着外设连接，头盔不再广播、扫描找不到；已处理为启动时先查 `connectedDevices([FEE0])` 复用、停止链路时 `manager.destroy()` 释放。**退后台实测（dev-client，打开系统设置）**：JS 很快挂起→链路以 `stopped` 断开，退后台前已 ACK 的事件正常上云；回前台自动重连并把头盔 Flash 里的事件补传，云端计为 `duplicate`（幂等），保命链路不丢事件——但后台期间不做实时中转（dev-client 无完整后台 BLE）。**锁屏 5 分钟实测（2026-09-16 05:01）**：链路在退后台时已断（JS 挂起），锁屏期间头盔（仿真器，广播带 FEE0）持续广播，手机**没有**在后台重连；此时推的跌倒事件进头盔 Flash（队列 1），云端无 SOS——即 **iOS 上 App 不在前台时摔倒不会实时通知，解锁回到 App 后才补传建单**（实测：回前台 3 s 内重连 → 0x07 查到 1 条 → 0x08 拉取 → ACK 擦除 → 上云建 SOS，全程 4 s）。**⚠️ 以上「锁屏不重连」结论已被推翻（同日 06:04 复测）**：根因是 SOS 页警报音在锁屏下崩溃（见下一行），不是系统挂起/回收。修复后 **Release 构建、用户从桌面启动、锁屏 5 分钟**：进程全程存活，BLE 链路不断，锁屏后 60 / 180 / 300 s 三次推跌倒均**当秒 ACK 并上云建 SOS**（云端 createdAt 06:00:18 / 06:02:09 / 06:04:15），位置包每 5 s 照常上传——**iOS 后台实时中转（决策 #41 低成本档）验证通过**，无需原生侧 ACK。仍需真机复验的边界：用户手动上滑杀掉 App（系统不再恢复，口径「App 未被手动关闭」）、系统因内存回收后 BLE 状态恢复能否拉起（`restoreStateIdentifier` 已配，未触发过）、dev-client 下不可用于判断后台行为。头盔 `deviceId` 与账号绑定不符时握手拒绝（`DEVICE_ID_MISMATCH`），不自动重试 | ① 硬件侧确认广播包含 FEE0（仿真器已按此实现）；② 后台保活双端实测清单：锁屏 5 min 后仿真器 `fall` 是否到云端、杀后台后重开是否自动重连并补传（`offline 3`）、华为省电模式白名单口径；结论补进本表 |
| 2026-09-16 | iOS（Release） | 锁屏/后台时 SOS 页警报音 | 摔倒事件在后台到达 → 推 SOS 页 → `alarm.play()`（expo-audio 同步方法）因 AVAudioSession 激活失败抛 `Session activation failed`，Release 构建未捕获 JS 异常 = `RCTFatal` 整 App 崩溃（崩溃报告 `app-2026-09-16-054443.ips`，三次背景测试全部同因）。此前误判为「系统回收进程」；dev-client 下只是红屏不致命，所以只在 Release 暴露 | ① SOS 页播放/暂停全部 try/catch，播放失败只记日志，倒计时与取消照常；② 播放前 `setAudioModeAsync({ shouldPlayInBackground: true, playsInSilentMode: true, interruptionMode: 'doNotMix' })` 让锁屏也能出声（`UIBackgroundModes: audio` 已配）；③ 规则：任何原生同步调用（expo-audio play/pause、Haptics、KeepAwake）在可能后台触发的路径上一律包 try/catch——Release 无红屏兜底 |
| 2026-09-17 | iOS（Release） | 锁屏 SOS 告警声 + 手动杀 App | ① 崩溃修掉后复测：锁屏下 SOS 页正常推出，但 `alarm.play()` 每秒都被 iOS 拒绝（`Session activation failed`，后台 App 不允许从零激活音频会话），用户**听不到警报声**；改用 expo-notifications 本地通知（时效性、默认铃声）后锁屏横幅 + 系统通知声实测可见可闻（12:24）。② 用户从任务栏上滑杀掉 App 后：头盔事件进 Flash，60 s 内系统不拉起（`restoreStateIdentifier` 只覆盖系统回收，不覆盖用户手杀），云端无 SOS，重开 App 才补传——与华为一致 | ① 锁屏告警口径 = 系统通知声（可被静音键/勿扰压掉）；要穿透静音需 Apple **Critical Alerts** entitlement，公司账号到位后申请（记 THIRD_PARTY 待办）；警报音只在前台/刚退后台可用；② 对外口径「手机随身且 App 未被手动关闭」双端成立 |
| 2026-09-16 | Android（华为 P30 Pro / EMUI / Android 10） | BLE 中转后台保活 + 扫描过滤 | ① 按 FEE0 过滤的扫描 20 s 内**扫不到** Mac 仿真头盔（iPhone 前台/后台都能扫到），改全量扫描后 6 s 命中——过滤匹配在部分安卓栈/广播包组合上不可靠；② 未加省电白名单、息屏、HOME 退后台：靠本地 Expo 模块 `helmet-link-service` 的前台服务（`connectedDevice` 类型 + 常驻通知），进程 6 分钟全程存活，息屏后 60 / 180 / 300 s 三次跌倒当秒 ACK 并上云建 SOS（07:03:37 / 07:05:45 / 07:07:43）；前台服务是 EMUI 不杀的前提，白名单是更长时间的保险 | ① 链路层：过滤扫描 20 s 无命中自动切全量扫描按名匹配，命中后下一轮回到过滤（iOS 后台仍需过滤）；② Android 上链路启动即起前台服务、停止即撤，设备页显示「后台运行」行，未加白名单时红色提示点击拉起系统对话框；③ **息屏 1 小时长跑（07:09–08:10，未加白名单）**：进程同一 pid 全程存活，每 10 min 一次跌倒 6/6 当秒 ACK 并上云建单；④ **深睡挂起网络（08:10–12:37 实测）**：无 adb 活动 4 小时，BLE 照常 ACK，但 App 的 HTTP 全部发不出去（上行队列溢出 >1000，旁路日志也断），adb 一碰手机恢复 6 秒——EMUI 深睡挂起后台网络，长跑期间每 10 min 的 adb 轮询恰好把它唤醒了。**修复**：高危事件入队即持 `PARTIAL_WAKE_LOCK` + Wi-Fi 高性能锁 90 s（`helmet-link-service.holdNetwork`），队列无高危事件即释放；复测（13:00–13:15 息屏零 adb）：位置包在睡眠期间确实积压 174 条，13:15 推跌倒 → 持锁 → **当秒上云建单**并顺带冲掉积压。**加省电白名单 + 「休眠时始终保持网络连接」后复测（13:21–13:36 息屏零 adb）：后台 HTTP 依旧挂起（15 min 零上传），跌倒仍靠持锁当秒上云**——EMUI 的这两个开关对本 App 无效，不必再引导用户去开「保持网络」；位置轨迹在深睡期间靠「位置包到达时若距上次成功上传 >5 min 就持锁 20 s 并立即 flush」分批补偿（**深睡中 JS setInterval 不触发**，必须由 BLE 事件驱动，复测 14:02–14:17：每 5 min 一次爆发 66 条，3/3 准时；跌倒仍当秒上云）。深睡刚醒的第一个 HTTPS 请求常见 `SSLException: Read error` / `SSLHandshakeException`（23:41 / 23:49 两次），8 s 内重试即成功；曾因此让一条跌倒拖到下个 5 min 窗口才上云（23:41 → 23:44:20），已改为「队列有高危事件时每个 BLE 事件都立刻重试」（commit 83e35d1）。结论：华为深睡下**保命事件实时（失败也在下一个位置包 5 s 内重试）、轨迹最多延迟 5 min**，电量代价每 5 min 醒 20 s。**手动清后台（最近任务上滑，2026-09-17 00:18 实测）**：进程与前台服务一起被杀，`START_REDELIVER_INTENT` 在 EMUI 上不会拉回；此后头盔事件进 Flash，60 s 内无任何重连，云端无 SOS——直到用户重新打开 App 才补传。对外口径必须写明「App 未被手动关闭」；可在 App 内提示华为用户在最近任务里「锁定」本应用 |
| 2026-10-06 | iOS + Android | BLE 扫描模式的切换规则（代码评审后定，**尚未真机复验**，REGRESSION 8.4） | 上面两行的真机结论对「后台能不能做全量扫描」方向相反：iOS 后台只投递带 FEE0 过滤的扫描；华为 P30 上按 FEE0 过滤扫不到仿真头盔、只有全量能命中。原实现是「过滤 20 s 无命中 → 全量」，但切过去之后**再也不回过滤**（注释里写的「命中后下一轮回到过滤」只在命中时成立）：头盔没开机时 App 在前台多待 20 秒，之后锁屏，iOS 上头盔再上电也永远连不上；Android 息屏后系统暂停无过滤扫描，同样连不上 | ① 两种扫描**交替**，各 20 s，命中即停；② **iOS 不在前台时不切全量**，一直过滤扫描；③ **Android 前后台都交替**——过滤在这台华为上不可靠，只做过滤的话退后台后永远连不上；息屏期间轮到全量的那 20 s 被系统暂停、白扫，下一轮过滤接上；④ 两端在**离开前台的那一刻**若正在全量扫描，立刻从过滤重开一轮（Android 上是为了不让随后可能被冻住的 JS 定时器停在全量那一轮）；⑤ 停链路时复位。**仍然成立的缺口**：过滤匹配不上的 Android 机型在**息屏期间**无法发现刚上电的头盔（过滤扫不到、全量被系统暂停），要亮屏才行——真头盔的广播包能否被华为的过滤匹配，等硬件到手实测（DEVICE_PROTOCOL §10 第 2 条「广播包必须带 FEE0」是前提）。实现在 `app/src/services/ble-link.ts` 的 `unfilteredAllowedNow` / `onAppStateForScan` |
| 2026-10-07 | 双端 | **飞行模式 / 被杀 + 无网类场景只能用正式包（Release）测**：expo-dev-client 开发包每次从 Metro 拉 JS，无网冷启动停在开发者选择页、提示连不上服务器（iPhone 4.16 实测）。iPhone 正式包：`xcodebuild -workspace app.xcworkspace -scheme app -configuration Release -destination "id=<设备 UDID>" -derivedDataPath ~/Library/Developer/Xcode/DerivedData/helmet-app-release -allowProvisioningUpdates DEVELOPMENT_TEAM=<团队> CODE_SIGN_STYLE=Automatic build` → `xcrun devicectl device install app --device <id> …/Release-iphoneos/app.app`，同包名覆盖安装保留登录态；旁路日志（`EXPO_PUBLIC_BLE_LOG_URL`）在正式包里照常生效，但无网期间产生的日志丢弃、不补发。华为靠 `adb reverse` 走 USB 连 Metro，关 Wi-Fi 不影响开发包，不需要正式包 |
| 2026-08-16 | iOS + Android | 高德地图数据覆盖 | **高德底图只覆盖中国大陆**，境外（如悉尼）只有粗略轮廓——海外开发时定位到自己真实位置永远是"一片空白"，非 Bug | 海外开发/测试地图功能用两个办法：① Mock 头盔剧本（骑行/滑雪坐标都在国内）驱动主链路；② 模拟器假定位（Android Extended Controls→Location / iOS Features→Location）设到深圳。真实用户在国内不受影响 |
| 2026-08-16 | iOS | react-native-amap3d 新架构 | `moveCamera` 等命令走旧架构 `viewRegistry![reactTag] as! MapView` 强转，RN 0.86（旧架构已移除）下必现闪退；Android 端借 interop 层可用 | 该库判死，地图定案 WebView + JS API（决策 #33）；后续任何"只维护"状态的旧原生库选型前先查新架构命令通道实现 |
| 2026-08-17 | 双端（React Compiler） | 空转 state 强制重渲染 | `const [, tick] = useState(0)` + `setInterval(() => tick(n=>n+1))` 这种"值不读只为触发重渲染"的写法**不生效**——Compiler 判定无依赖变化，直接 memo 掉整个渲染（SOS 倒计时停在首帧，真机实证） | 定时刷新的展示值必须让 state **真正参与渲染计算**：存时间戳 `now` 并在渲染期算派生值；且 effect 内不要同步 setState（`react-hooks` 规则会报错） |
| 2026-09-10 | iOS（macOS 构建机） | codesign 报 `resource fork, Finder information, or similar detritus not allowed` | 仓库放在被 **iCloud 云盘同步的桌面/文稿**目录时，构建产物被文件提供程序打上 `com.apple.fileprovider.*` / `FinderInfo` 扩展属性，codesign 拒签（先是 Pods 框架，后是 App 本体；`xattr -cr` 清了会再被打上）。另：从 VS Code 等浏览器下载的 App 内派生的进程写文件会带 `com.apple.provenance`，该属性不可删但 codesign 不拒 | ① 构建输出挪到 iCloud 之外：`xcodebuild … -derivedDataPath ~/Library/Developer/Xcode/DerivedData/<name>`（或干脆把仓库放 `~/dev` 等非同步目录）；② 用 `xcodebuild -allowProvisioningUpdates` 直接构建 + `xcrun devicectl device install app` 装机，绕过 `expo run:ios` 不生成描述文件的问题；③ 同一 Bundle ID 只能属于一个 Team——B 机器用 Personal Team 时本地把 `PRODUCT_BUNDLE_IDENTIFIER` 改成 `com.dravenzhong.helmet.local`（ios/ 不进 Git，不影响 A） |
| 2026-09-10 | iOS | prebuild 重生成签名相关文件 | 每次 `expo prebuild` 后工程 DEVELOPMENT_TEAM 丢失（直接 xcodebuild 报 requires a development team） | teamId 固化在 app.json `ios.appleTeamId`（**2026-09-23 起 = 公司团队 `B3NHB45FS7`**），xcodebuild 再补 `DEVELOPMENT_TEAM=… CODE_SIGN_STYLE=Automatic` 保险。~~构建前删 aps-environment~~ 已随公司账号到位取消 |
| 2026-09-10 | 双端 | App 退后台 JS 定时器暂停 | 「每秒减一」式倒计时（短信重发 60s）退后台冻结，回前台从暂停处继续，实际等待时间被拉长（iPhone 真机实证） | 一切倒计时/计时展示改「截止时间戳 + 墙钟算剩余」：回前台首个 tick 自动校准（sos-active 与 (auth) 两页已统一此口径） |
| 2026-09-08 | 双端（React Compiler） | hook 返回对象属性不可赋值 | `player.loop = true`（expo-audio useAudioPlayer 返回值）被 lint 判 `This value cannot be modified` | 改用方法调用或重放策略（sos-active 每秒 `seekTo(0)+play` 实现循环警报） |
| 2026-09-08 | 双端（CNG/prebuild） | expo install 自动追加 config plugin | `npx expo install` 会把带插件的库自动加进 app.json plugins；再手工加带参数的同名项即重复，先出现的无参项吃掉配置（ble-plx 的 `isBackgroundEnabled`/中文权限文案失效，prebuild 后 Info.plist 无 `bluetooth-central`，实测） | 加插件参数前先查 plugins 是否已被自动追加，只保留唯一带参数项后重新 prebuild 并核对 Info.plist/AndroidManifest |
| 2026-08-16 | 双端（React Compiler） | useImperativeHandle | 本项目开启 `reactCompiler: true` 后，`useImperativeHandle`（forwardRef 与 React 19 ref-prop 两种写法都试过）**ref 永不挂载**——`ref.current` 恒为 null，命令式句柄整体失效（真机 logcat 实证） | 需要命令式接口的组件改用「controllerRef prop + useEffect 赋值」模式（见 `app/src/components/map/amap-view.tsx`）；prop 名必须以 `Ref` 结尾，否则 react-hooks/immutability 报错 |


## 设计素材管线（产品图 → App 资产）

> 2026-08-17 落账（设备卡头盔图实战沉淀）。以后新素材照此流程,不要重新摸索。

**生图提示词硬性要求**（发给任何生图软件时必须带上,决定后续处理是"一行命令"还是"疑难杂症"）:

> 纯色平坦背景(flat solid background)、无渐晕(no vignette)、无地面投影(no ground shadow)、无光晕(no glow);产品 3/4 左前视角、影棚打光、构图居中占画面约 70%、无文字无水印无人物

背景色随意（会被抠掉）,关键是"平"——边缘色标准差 <2 即合格,脚本会自检并告警。

**处理流程**:

```bash
# 原图放 design/,输出到 app/assets/images/,文件名带版本号(vN 递增,见坑 3)
python3 design/cutout.py design/helmet-xxx.png app/assets/images/helmet-xxx-v1.webp
# 输出末尾必须是「边缘45px最大alpha 0(合格)」
```

**三个已踩实的坑（勿再踩）**:

1. **有损 WebP 会压漂 alpha**:quality 模式下 alpha=0 的区域会被压成几十,深色主题下呈半透明"鬼影方块"。资产一律 `lossless=True`（两张 720px 约 200KB,可接受）。
2. **本机 conda(anaconda) 的编译扩展不可信**:PIL `ImageDraw.floodfill` 在大图上静默失效（填 0 像素不报错）、cv2/scipy 与 numpy ABI 失配直接抛错。图像处理的连通域/洪泛用 `design/cutout.py` 里的纯 numpy 实现。
3. **expo-image 按 URI 磁盘缓存**:同名文件换内容,App 里看到的还是旧图（Reload 也没用）。资产更新必须改文件名（vN 递增）并同步改 require。
4. 图上带烘焙背景直接进卡片 = 必穿帮:色号对得再准,按压高亮时容器变色图片不变,方形图块立现。**必须透明底**。

**卡片显示规格**: 128pt(@3x=384px),源图 720px 留余量;深色头盔靠生图时的轮廓光与深色卡片分离。

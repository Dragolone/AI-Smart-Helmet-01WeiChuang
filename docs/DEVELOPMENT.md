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
| 开通一台设备（生成 deviceId/密钥/绑定码） | `npm run provision:device -w backend`（可选参数指定 deviceId：`-- helmet_mock_002`；deviceSecret 只显示一次） |
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

## 平台限制清单（持续维护）

> 记录 Week 2 Spike 及后续开发中实测到的 iOS / Android 系统限制。禁止静默降级——任何限制先记录在此并与负责人确认口径。

| 日期 | 平台 | 能力 | 实测限制 | 口径/结论 |
|------|------|------|---------|----------|
| 2026-08-15 | iOS | 签名/推送 | 个人免费开发团队无法签 `aps-environment`（远程推送）entitlement；同一 Bundle ID 无法注册到第二个个人团队（`com.dravenzhong.helmet` 已归属队友团队，另一台 Mac 开发期临时用 `com.zixim.helmet.spike`） | 开发期两人各用独立 Bundle ID；APNs 验证与签名统一等公司 Apple Developer 账号（负责人已确认 2026-08-15） |
| 2026-08-15 | Android（华为无 GMS） | 定位 | 冷启动首次锁星需 1–2 分钟，一次性 `getCurrentPositionAsync` 长时间挂起无反馈；锁星后 watchPosition 每 2s 稳定更新、精度可到 5m | 定位功能一律用持续监听 + 中间状态展示，禁止一次性等待（负责人已确认口径 2026-08-15） |
| 2026-08-15 | iOS + Android | RTC（TRTC） | 双机对讲互通、锁屏后台音频（iOS 已配 `UIBackgroundModes: audio`）、蓝牙耳机路由，双端真机全部通过 | 无限制发现；支撑 TRTC 选型定案（负责人已确认 2026-08-15） |
| 2026-08-15 | iOS + Android | BLE 后台 | 前台扫描/连接/断连检测双端通过；**后台断连检测未测** | Week 11 防丢开发前必须实测：iOS `bluetooth-central` 后台模式 + 华为激进杀后台 |
| 2026-09-16 | iOS + Android | BLE 中转链路（GATT 已落地） | iPhone 真机对 Mac 仿真头盔实测：前台按广播名扫描 1 s 内发现并完成五步握手（读 deviceId/固件 → 对时 → 补传查询），跌倒事件当秒 ACK；**但不带服务 UUID 过滤的扫描在锁屏/退后台后立即停止投递**（重连扫描 3 分钟无一次发现），改为按 FEE0 过滤后后台可继续扫描——因此**硬件广播包必须携带 FEE0 服务 UUID**（已列为向硬件确认项）。另：JS 重载/进程被杀后 iOS 系统层仍握着外设连接，头盔不再广播、扫描找不到；已处理为启动时先查 `connectedDevices([FEE0])` 复用、停止链路时 `manager.destroy()` 释放。**退后台实测（dev-client，打开系统设置）**：JS 很快挂起→链路以 `stopped` 断开，退后台前已 ACK 的事件正常上云；回前台自动重连并把头盔 Flash 里的事件补传，云端计为 `duplicate`（幂等），保命链路不丢事件——但后台期间不做实时中转（dev-client 无完整后台 BLE）。头盔 `deviceId` 与账号绑定不符时握手拒绝（`DEVICE_ID_MISMATCH`），不自动重试 | ① 硬件侧确认广播包含 FEE0（仿真器已按此实现）；② 后台保活双端实测清单：锁屏 5 min 后仿真器 `fall` 是否到云端、杀后台后重开是否自动重连并补传（`offline 3`）、华为省电模式白名单口径；结论补进本表 |
| 2026-08-16 | iOS + Android | 高德地图数据覆盖 | **高德底图只覆盖中国大陆**，境外（如悉尼）只有粗略轮廓——海外开发时定位到自己真实位置永远是"一片空白"，非 Bug | 海外开发/测试地图功能用两个办法：① Mock 头盔剧本（骑行/滑雪坐标都在国内）驱动主链路；② 模拟器假定位（Android Extended Controls→Location / iOS Features→Location）设到深圳。真实用户在国内不受影响 |
| 2026-08-16 | iOS | react-native-amap3d 新架构 | `moveCamera` 等命令走旧架构 `viewRegistry![reactTag] as! MapView` 强转，RN 0.86（旧架构已移除）下必现闪退；Android 端借 interop 层可用 | 该库判死，地图定案 WebView + JS API（决策 #33）；后续任何"只维护"状态的旧原生库选型前先查新架构命令通道实现 |
| 2026-08-17 | 双端（React Compiler） | 空转 state 强制重渲染 | `const [, tick] = useState(0)` + `setInterval(() => tick(n=>n+1))` 这种"值不读只为触发重渲染"的写法**不生效**——Compiler 判定无依赖变化，直接 memo 掉整个渲染（SOS 倒计时停在首帧，真机实证） | 定时刷新的展示值必须让 state **真正参与渲染计算**：存时间戳 `now` 并在渲染期算派生值；且 effect 内不要同步 setState（`react-hooks` 规则会报错） |
| 2026-09-10 | iOS（macOS 构建机） | codesign 报 `resource fork, Finder information, or similar detritus not allowed` | 仓库放在被 **iCloud 云盘同步的桌面/文稿**目录时，构建产物被文件提供程序打上 `com.apple.fileprovider.*` / `FinderInfo` 扩展属性，codesign 拒签（先是 Pods 框架，后是 App 本体；`xattr -cr` 清了会再被打上）。另：从 VS Code 等浏览器下载的 App 内派生的进程写文件会带 `com.apple.provenance`，该属性不可删但 codesign 不拒 | ① 构建输出挪到 iCloud 之外：`xcodebuild … -derivedDataPath ~/Library/Developer/Xcode/DerivedData/<name>`（或干脆把仓库放 `~/dev` 等非同步目录）；② 用 `xcodebuild -allowProvisioningUpdates` 直接构建 + `xcrun devicectl device install app` 装机，绕过 `expo run:ios` 不生成描述文件的问题；③ 同一 Bundle ID 只能属于一个 Team——B 机器用 Personal Team 时本地把 `PRODUCT_BUNDLE_IDENTIFIER` 改成 `com.dravenzhong.helmet.local`（ios/ 不进 Git，不影响 A） |
| 2026-09-10 | iOS | prebuild 重生成签名相关文件 | 每次 `expo prebuild` 后:①entitlements 重新带上 aps-environment(个人团队签不了,构建报 Push Notifications capability);②工程 DEVELOPMENT_TEAM 丢失(直接 xcodebuild 报 requires a development team) | ①构建前删 entitlements 里 aps-environment 两行(公司账号到位后不再需要);②teamId 已固化进 app.json `ios.appleTeamId`(LZ3H94F5LC),xcodebuild 再补 `DEVELOPMENT_TEAM=… CODE_SIGN_STYLE=Automatic` 保险 |
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

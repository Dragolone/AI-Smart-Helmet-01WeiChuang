# STORE_LISTING.md — 应用商店上架与 App 备案材料（草稿）

> 状态：**草稿，2026-10-02 B 线起草，待负责人定稿**。标「待定」的由负责人或汤总拍板；标「待 A」的由 A 线提供。
> 相关：THIRD_PARTY §9–12（软著 / 备案 / 隐私政策 / 演示账号）、DEPLOYMENT §8.1（正式环境域名）、`deploy/legal/`（四份法律页面）。
> 正式环境域名以 `api.01weichuang.com` 为准，切换前商店里的地址先用 `dev-api.`，切换后统一改（DEPLOYMENT §8.1 第 9 步）。

## 1. 基本信息（双端通用）

| 项 | 值 |
|---|---|
| 应用名称 | 零一智行（2026-10-15 定稿；图标下显示名、商店名、备案名三处必须一致） |
| 副标题（App Store ≤ 30 字） | 智能头盔骑行安全助手（待定） |
| 包名 / Bundle ID | `com.lingyiweichuang.app`（双端相同） |
| 版本 | 1.0.0 |
| 开发者 / 主体 | 深圳零一唯创科技有限公司（App Store 显示英文登记名 Shenzhen Lingyi Weichuang Technology Co., Ltd.） |
| 类别 | 主类别「工具」（与极光登记的「实用工具」一致）；次类别「导航」（待定） |
| 支持的设备 | 仅 iPhone、仅竖屏（`app.json` 未开 `supportsTablet`，上传前在 App Store Connect 确认未勾 iPad） |
| 隐私政策网址 | `https://api.01weichuang.com/legal/privacy` |
| 用户协议网址 | `https://api.01weichuang.com/legal/terms` |
| 个人信息收集清单 | `https://api.01weichuang.com/legal/collection` |
| 第三方信息共享清单 | `https://api.01weichuang.com/legal/sharing` |
| 技术支持网址（App Store 必填） | `https://01weichuang.com`（公司官网；需有联系方式，待确认官网上有） |
| 联系邮箱 | zhongqilong@01weichuang.com（待定：是否换客服专用邮箱，与隐私政策同步） |
| 客服电话 | 待定（国内商店多数必填） |

## 2. 商店文案

**一句话简介（国内商店「简介」≤ 15–20 字）**

> 智能头盔配套 App，摔倒自动求救

**应用描述**

> 零一智行 App 是零一唯创智能头盔的配套应用，让每一次骑行都多一份安心。
>
> 【摔倒检测与紧急求救】头盔检测到疑似摔倒时，手机立即弹出 60 秒倒计时；倒计时结束未取消，自动向你设置的紧急联系人发送求救短信。也可以长按头盔按键或在 App 内一键求救。
>
> 【危险预警留档】头盔识别到后方来车、前方障碍等风险时，App 实时提醒并保存记录，可随时回看。
>
> 【定位与骑行轨迹】地图实时显示头盔位置，支持 1/6/24 小时轨迹回放、位置分享与导航跳转。
>
> 【设备管理】扫码绑定头盔，查看电量与在线状态，调节大灯、音量、跌倒检测灵敏度、雷达预警距离等设置。
>
> 【实时画面】连接头盔 Wi-Fi，在手机上查看头盔摄像头的实时画面，并可截图保存。
>
> 【队友对讲】创建频道、邀请码加入，骑行途中按住说话。
>
> 使用说明：本应用需配合零一唯创智能头盔使用。头盔通过蓝牙将事件转发至手机，摔倒后自动求救需要手机在身边、蓝牙保持连接、App 处于运行状态且手机有网络。本应用不能替代 120、110 等公共紧急服务。

最后一段是决策 #35 的前提（与用户服务协议 §二.2 同一口径），**不要删**——商店描述与实际能力不符是常见驳回理由，也是投诉风险。

**关键词（App Store ≤ 100 字符，逗号分隔）**

> 头盔,智能头盔,骑行,摔倒检测,紧急求救,SOS,电动车,摩托车,滑雪,轨迹,定位,对讲,安全

**更新说明（1.0.0）**：首个版本。

## 3. 截图

| 平台 | 尺寸 | 数量 | 说明 |
|---|---|---|---|
| App Store | 6.9 英寸 1320×2868（或 6.5 英寸 1284×2778） | 3–10 张 | 只需 iPhone；用 iPhone 14 Pro Max 截的是 1290×2796，属 6.7 英寸，App Store Connect 接受作 6.9 英寸档 |
| 国内安卓商店 | 1080×1920 或同比例，竖屏 | 3–5 张 | 各家要求略有差异，以后台提示为准 |
| 图标 | 1024×1024（Apple）、512×512（安卓） | 1 | 由 `app/assets/images/icon-brand.png` 导出，不带圆角和透明 |

**建议截图顺序（用演示账号 + 正式环境 Mock 数据截）**：① 设备页（电量、在线、今日骑行）② 地图实时位置 ③ 轨迹回放 ④ SOS 倒计时页（用「演练模式」截，不会真发通知）⑤ 安全事件列表 ⑥ 设备设置。截图里不要出现真实手机号与真实位置（演示数据为 Mock 坐标，可用）。

## 4. 审核备注与演示账号

演示账号做法见 THIRD_PARTY §12（普通账号 + 绑 Mock 设备 + 跑 `ski` 剧本 + 紧急联系人填公司备用号）。账号密码入密码管理器，**不写进本文件**。

**App Review Information → Notes（中英两段都贴）**

> 本应用需配合零一唯创智能头盔使用。已提供演示账号，账号内已绑定一台演示设备并有模拟骑行数据，可查看设备状态、地图轨迹、安全事件与事故记录。在「安全」页可进入「演练模式」体验 60 秒求救倒计时（演练不会发送任何通知）。语音对讲需两台设备同时登录方可体验。蓝牙连接与实时视频预览需连接实体头盔，无硬件时相关页面会提示未连接，属正常表现。
>
> 后台模式说明：bluetooth-central 用于 App 在后台时继续接收头盔的摔倒与求救事件，这是本应用的核心安全功能；audio 用于语音对讲在锁屏或切到其他应用时保持通话。
>
> This app works with the Lingyi Weichuang smart helmet. The demo account has a simulated helmet bound with sample ride data, so you can view device status, map tracks, safety events and accident records. Use "Drill mode" on the Safety tab to try the 60-second SOS countdown without sending any notification. Voice intercom requires two signed-in devices. Bluetooth connection and live video preview require the physical helmet; without it those screens show "not connected", which is expected. Background modes: bluetooth-central keeps receiving fall / SOS events from the helmet while the app is in the background (core safety feature); audio keeps intercom calls alive when the screen is locked.

**Apple 常见审核点（已核对代码）**

| 条款 | 现状 |
|---|---|
| 5.1.1(v) 应用内注销账号 | ✅ 「我的」→ 注销账号（输入密码确认，撤销会话、解绑设备、删联系人、退出频道） |
| 5.1.1 权限用途说明 | ✅ 中文用途说明齐全（蓝牙 / 相机 / 相册 / 麦克风 / 本地网络 / 添加照片）。⚠️ 还带着一条手机定位说明（上线前清单 #7，负责人决定保留）——审核若问，答「预留给后续版本用手机定位补位，当前版本不申请」；被驳回就按 #7 删掉插件 |
| 2.5.4 后台模式 | `bluetooth-central` 与 `audio`，理由写在上面的备注里 |
| 4.2 最低功能 | 依赖硬件的 App 允许上架，靠演示账号与 Mock 数据展示功能 |
| 出口合规（加密） | 只用系统 HTTPS，属豁免。建议 A 线在 `app.json` 的 `ios.infoPlist` 加 `ITSAppUsesNonExemptEncryption: false`，免得每次上传都要回答 |
| 中国大陆上架 | 需填 App 备案号（§6） |

## 5. App Store「App 隐私」问卷（按代码实际行为填）

**是否用于追踪（Tracking）**：否。没有广告 SDK、没有跨 App 追踪，不需要 ATT 弹窗。

| 数据类型（Apple 分类） | 是否收集 | 用途 | 与身份关联 | 依据 |
|---|---|---|---|---|
| 联系信息 → 电话号码 | 是 | App 功能 | 是 | 注册手机号 |
| 联系信息 → 姓名 | 是 | App 功能 | 是 | 昵称（选填） |
| 位置 → 精确位置 | 是 | App 功能 | 是 | 头盔上报的位置与轨迹 |
| 联系人 | 是 | App 功能 | 是 | 用户手动填写的紧急联系人（Apple 对「手动录入他人号码」是否算这一类没有明确说法，保守起见勾上） |
| 用户内容 → 照片或视频 | 是 | App 功能 | 是 | 头像 |
| 用户内容 → 音频数据 | 否 | — | — | 对讲语音只实时传输、不存储，按 Apple 定义不算「收集」 |
| 用户内容 → 其他用户内容 | 是 | App 功能 | 是 | 对讲频道名称 |
| 标识符 → 用户 ID | 是 | App 功能 | 是 | 账号 ID（亦作推送别名） |
| 标识符 → 设备 ID | 是 | App 功能 | 是 | 极光推送注册 ID |
| 其他数据 | 是 | App 功能 | 是 | 摔倒 / 求救 / 危险事件及判定参数、头盔状态与设置 |
| 健康与健身 / 财务 / 浏览记录 / 搜索记录 / 诊断 / 使用数据 | 否 | — | — | 无统计、崩溃上报、支付 SDK |

问卷答案要和隐私政策、`deploy/legal/collection.html` 一致；以后加了统计或崩溃上报 SDK，三处一起改。

## 6. App 备案（腾讯云控制台 → 备案 → 新增 App）

主体沿用公司已备案主体，安卓、iOS 各一条。

| 字段 | 值 |
|---|---|
| App 名称 | 零一智行 |
| 服务内容 / 类别 | 工具类：智能头盔配套（设备管理、骑行轨迹、紧急求救） |
| 平台 | Android / iOS |
| 包名 / Bundle ID | `com.lingyiweichuang.app` |
| Android 签名公钥、证书 MD5 | ✅ 已齐（Wesley 10-04 导出）：负责人桌面 `01/06_服务器与密钥/零一唯创-Android备案证书信息.txt`，「签名 MD5 值」填无冒号那行 |
| iOS 公钥 / SHA-1 | ✅ 已齐（Wesley 10-14 导出）：同目录 `零一唯创-iOS备案证书信息.txt`。iOS 的「签名 MD5 值」一栏**填 SHA-1**（腾讯云文档原话：苹果版填证书 SHA-1），不是文件里那行 MD5 |
| 服务域名 | `api.01weichuang.com`（DNS 三条 A 记录先加，DEPLOYMENT §8.1 第 1 步） |
| 服务器 IP | 111.230.157.151（腾讯云广州） |
| 是否涉及前置审批 | 否（非新闻、出版、医疗、金融等类目；本应用不是医疗设备，用户协议 §二已写明） |
| 负责人 | 法人龙俊洁或指定人员；手机号接收管局核验短信 |

## 7. 国内安卓商店

| 商店 | 账号 | 硬性材料 | 备注 |
|---|---|---|---|
| 华为应用市场 | AppGallery Connect 企业开发者 | 软著、App 备案号、营业执照、隐私政策网址 | 华为推送也在 AGC 配置，需要登记正式签名 SHA256 |
| 小米应用商店 | 小米开放平台企业账号 | 软著、备案号 | 小米推送同账号开通 |
| OPPO 软件商店 | OPPO 开放平台 | 软著、备案号 | OPPO 推送通常要求先上架 |
| vivo 应用商店 | vivo 开放平台 | 软著、备案号 | vivo 推送通常要求先上架 |
| 应用宝 | 腾讯开放平台 | 软著、备案号 | 可用同一腾讯云主体 |
| 荣耀应用市场 | 荣耀开发者服务平台 | 软著、备案号 | 荣耀推送单独注册 |

**各家共同的隐私合规检测项（已核对）**：
- ✅ 首次启动 / 登录前先展示并勾选同意隐私政策，未同意不初始化推送 SDK、不申请权限（决策 #47 / #48）
- ✅ 不申请读取电话状态、外部存储、正在运行的应用列表、后台定位（`android.blockedPermissions`）
- ✅ 应用内可注销账号
- ⬜ **应用内能查看两份清单**：华为、小米检测时常要求在 App 内（一般在「我的 → 隐私」）能打开个人信息收集清单和第三方信息共享清单。网页已有（`deploy/legal/collection.html` / `sharing.html`），App 里还要加两个入口，属 A 线的小改动（`legal/[doc].tsx` 目前只认 privacy / terms 两种）
- 权限申请时机与用途说明以 `deploy/legal/collection.html` 第二节为准，商店后台「权限说明」照抄

## 8. 提交前最后核对

- [ ] 正式包 `EXPO_PUBLIC_API_URL=https://api.01weichuang.com/api/v1`
- [ ] 服务器 `JPUSH_APNS_PRODUCTION=true`（iOS 正式包）
- [ ] 四个法律网址都能打开，商店后台、极光后台填的是 `api.` 域名
- [ ] 演示账号能登录、设备在线、地图有轨迹、紧急联系人是公司备用号
- [ ] 截图里没有真实手机号与真实位置
- [ ] App 备案号已填（Apple 与各安卓商店）
- [ ] 软著证书已上传（安卓商店）
- [ ] App Store 选「审核通过后手动发布」，真头盔测通再点发布

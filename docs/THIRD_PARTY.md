# THIRD_PARTY.md — 第三方账号与资质清单

> 本文件是第三方账号/Key 的**唯一状态台账**，每周对表更新。申请主体统一为**深圳零一唯创科技有限公司**（91440300MAK7XEPD38）。
> 相关决策：#34（云厂商统一腾讯云 + 域名备案复用）、#22（TRTC 选型）、#24（双 Bundle ID）、#33（地图库定案）。
> 最后更新：2026-09-22

## 状态总览

| # | 项目 | 状态 | 阻塞谁 | 负责人 |
|---|------|------|--------|--------|
| 1 | 腾讯云账号（企业实名） | ✅ **已完成**（主账号 100047478294，企业认证 2026-05-31，2026-09-06 确认可复用） | — | 负责人 |
| 2 | 云服务器（腾讯云轻量 2C4G） | ✅ **已购买并部署完成（2026-09-06）**：helmet-dev，广州，2核4G/90GB/6Mbps，1 年 816 元，到期 2027-09-06；三子域名解析 + HTTPS + Mock 接入全部验收通过 | — | 负责人 |
| 3 | 对象存储 COS | ✅ **已开通并接入（2026-09-16）**：桶 `helmet-media-1415122735`（广州 / 单 AZ / 私有读写 / SSE-COS），子账号 `helmet-cos` 仅授 `QcloudCOSDataFullControl`；后端 `TencentCosProvider` 真桶自检 5 项通过；**云端 `deploy/.env` 待填** | 视频上传入口待硬件确认上传方式 | 负责人 |
| 4 | 腾讯云短信（签名 + 模板） | 🔄 服务已开通（2026-09-09）；资质/签名/模板待提交（承诺书待盖章）；后端腾讯云实现已就绪等六项配置 | 注册验证码 + SOS 短信真发（现为 Console Mock，不阻塞） | 负责人 |
| 5 | Apple Developer 公司账号 | 🔄 **2026-09-22 注册已提交，Apple 审核中（Enrollment ID `XD2C5LWH7J`）**：D-U-N-S 576655751；验证人 = 法人龙俊杰（long@01weichuang.com / 15014036340）。下一步：等审核邮件 → 付 ¥688 → 可能来电核实 | iOS TestFlight 分发、APNs 远程推送、Critical Alerts | 负责人 |
| 6 | 推送：极光 + 安卓厂商通道 | ⬜ 待申请 | App 被杀后收不到推送（现只有本地通知） | 负责人 |
| 7 | 高德地图 Key | ✅ 企业认证已完成（2026-09-06）；企业主体三把 Key 已建并换入（2026-09-17，测试额度）；**商用授权 = 付费年包 ¥5 万/年，上线前待汤总拍板（买 / 换图商）** | 不阻塞开发 | 负责人 → 汤总 |
| 8 | 腾讯云 TRTC 应用 | ✅ **已完成（2026-09-10）**：应用在公司腾讯云账号下（SDKAppID 1600157223）；云端 `deploy/.env` 已填，进房凭证接口实测返回 userSig | — | 负责人 |
| 9 | 软件著作权（App） | 🔄 **材料已备好（2026-09-10）**：软件名「零一唯创App V1.0」（汤总定名），源程序 60 页 + 说明书 14 页 + 填表信息在负责人桌面 `01/软著/`；待版权中心网站提交 + 申请表盖章 | 安卓商店上架硬性要求（30 个工作日，可加急） | 负责人 |
| 10 | App 备案（工信部） | ⬜ 待办：腾讯云控制台「备案」→ 新增 App，主体沿用公司；**前置=正式包名定稿**（建议 `com.lingyiweichuang.app`，安卓包名段不能以数字开头故不能用 01weichuang） | 苹果 / 安卓商店上架均查备案号（1–2 周） | 负责人 |
| — | ~~域名 + ICP 备案~~ | ✅ **已消除**（决策 #34） | — | — |

> 图例：⬜ 未开始 ｜ 🔄 进行中 ｜ ✅ 已完成/已消除

## 逐项明细

### 1. 腾讯云账号（企业实名）

全部云侧资源的前置。一次企业实名后，服务器 / COS / 短信 / TRTC 共用同一账号、同一控制台、同一份发票。
✅ **已确认（2026-09-06）**：公司网站所在腾讯云主账号 100047478294 已完成企业实名（深圳零一唯创科技有限公司，2026-05-31，微信公众号认证），直接复用。账号下已有：1 台轻量应用服务器（公司网站）、3 个域名、1 个已完成 ICP 备案、1 个 TRTC 应用。

### 2. 云服务器 — 腾讯云轻量应用服务器

- **规格**：2C4G 起步（CLAUDE.md 口径：服务器配置不是架构依赖，不够就升配）
- **跑什么**：Docker Compose 起 NestJS 后端 + PostgreSQL 16 + EMQX，即 `development` 环境
- **为什么急**：B 线开发项已全部清零，代码全在本地。没有服务器就无法与硬件团队远程联调、A 线无法连非本机后端、Week 11–12 无演示环境
- ✅ **2026-09-06 部署完成**：实例 helmet-dev（111.230.157.151，通用型 2核4G/90GB/6Mbps，Docker CE 镜像，1 年 816 元，到期 2027-09-06）；`dev-api` / `dev-admin` / `dev-mqtt` 三条 A 记录已解析，Caddy 自动签证书成功；验收清单 #1–#5 通过（health 200、Admin 可登录、Mock 经 1883 接入并在线、错密钥被拒）。App 端把 `EXPO_PUBLIC_API_URL` 指到 `https://dev-api.01weichuang.com/api/v1` 即可联调。防火墙 1883 当前全网放通，硬件方出口 IP 确定后收紧

### 3. 对象存储 COS

事故视频/图片存储 + 预签名 URL（有效期 10 分钟，API.md §9 定稿）。

- ✅ **2026-09-16 开通并接入**：公司主账号 100047478294 下开通 COS（企业用户首 6 个月免费标准存储容量包；免费包只抵存储，外网下行流量另计）。
- **桶**：`helmet-media-1415122735`，地域广州 `ap-guangzhou`（与服务器同区），**单 AZ**（多 AZ 无资源包可抵且开启后不可关）、**私有读写**、服务端加密 **SSE-COS**、版本控制/日志/极智压缩均关闭。
- **子账号**：`helmet-cos`，仅「编程访问」，仅关联 `QcloudCOSDataFullControl`（对象读写删列，不能删桶/改桶配置）。密钥存密码管理器，**不进 Git、不发聊天**。⚠️ 首把密钥曾在对话中出现过，正式上线前在访问管理里为该子账号新建密钥、删除旧密钥后再填云端。
- **后端**：`TencentCosProvider`（`cos-nodejs-sdk-v5`，本地签名不联网）；`TENCENT_COS_SECRET_ID / SECRET_KEY / BUCKET` 齐全即切换，`TENCENT_COS_REGION` 缺省广州；否则回落 Mock。业务代码零改动。
- **验收命令**：`npm run verify:cos -w backend`（上传临时对象 → 签名可读 → 无签名 403 → 篡改 403 → 过期 403 → 删除）。本地 2026-09-16 通过；**云端填好 `deploy/.env` 后在 backend 容器内再跑一次**：`docker compose -f docker-compose.prod.yml exec backend npm run verify:cos`。✅ **云端 2026-09-17 12:55 已填并自检通过（5 项）**；同日云端已重新部署到 main（含 #57/#58/#60/#62/#64，四条迁移应用成功）。🔴 上线前给子账号 `helmet-cos` 换新密钥（现用密钥曾进过聊天）。
- **待定**：① 视频文件怎么进桶（头盔 Wi-Fi 直传 / 经 App 中转）待硬件确认（EVENTS.md 4.9 ⚠️），确定后再加上传签名接口；② **云端保留期待负责人确认**（候选 90 天到期删除，见 DECISIONS.md 待定表），定案后用主账号在控制台配生命周期规则，并确认超期媒体的接口表现。
- **费用参考**（广州标准存储，按量）：存储约 0.1 元/GB/月、外网下行约 0.5 元/GB、上传免费；MVP 规模预计每月 0–10 元。不开 CDN。

### 4. 腾讯云短信

- **用途**：SOS 倒计时到期后的真实短信通知（保命链路对外一环）
- **要申请两样**：短信**签名**（需营业执照，1–2 工作日）+ 短信**模板**（需预留变量：设备名 / 触发时间 / 位置链接）
- 后端 `SmsProvider` 已改为**模板式**（2026-09-09）：`TencentSmsProvider` 已实现，`deploy/.env` 配齐六项即切换真发，否则 Console Mock（验证码打印在日志）：`TENCENT_SMS_SECRET_ID` / `TENCENT_SMS_SECRET_KEY`（子账号 API 密钥，只授 QcloudSMSFullAccess）/ `TENCENT_SMS_SDK_APP_ID`（应用管理，1400 开头）/ `TENCENT_SMS_SIGN_NAME` / `TENCENT_SMS_TEMPLATE_VERIFY_CODE` / `TENCENT_SMS_TEMPLATE_SOS_ALERT`
- **申请进度（2026-09-09）**：短信服务已开通（企业认证，赠 200 条）；签名与模板待提交——需先在「实名资质管理」建企业资质（营业执照 + 《安全合规使用承诺书》盖章件，承诺书已填好待汤总盖章）。⚠️ 签名过审后运营商实名报备另需 7–10 工作日，真短信最快约两周后可发；期间开发用 Mock
- **签名**：`零一唯创`（公司简称，类型「公司」，场景勾验证码 + 通知）
- **模板一 · 注册验证码**（对应 `verify_code`，变量顺序 {1}{2}）：`您的验证码为{1}，{2}分钟内有效，请勿泄露给他人。`
- **模板二 · SOS 紧急通知**（对应 `sos_alert`，变量顺序 {1}{2}{3}）：`您的联系人{1}佩戴的智能头盔于{2}触发紧急求救，位置：{3}，请尽快联系确认。`——{1} 佩戴者昵称（后端截 10 字）、{2} 触发时间 `MM-DD HH:mm`、{3} 坐标文本（约 18 字符，⚠️ 腾讯云变量默认限 12 字符，**申请说明里注明 {3} 为位置坐标/链接需放宽至 ≥ 40 字符**；决策 #30 临时分享链接就绪后换成短链）
- 模板文案与决策 #28 口径一致（「秒级检测、倒计时确认后自动通知」）

### 5. Apple Developer 公司账号（Organization）

- **现状**：公司专用 Apple ID 已建（凭证入密码库）、管理人实名通过，卡在 **D-U-N-S 邓白氏建档**：查询工具无记录、自助申请失败（新公司）。**2026-09-08 已向 Apple Developer Support 发工单**；**2026-09-09 苹果回复（案例 102956478091，支持人员 Lynette）**：回复该邮件补四项信息（本地企业名称、电话、工作电话、工作邮箱；**只能用罗马字母**），即授权 Apple 向 D&B 提交建档；D&B 可能致电工作电话核实，须备好营业执照；建档完成后 D&B 通知。**2026-09-11 邓白氏（海南邓白氏）来邮：订单 10212210956843，须 9-14 15:00 前在 dnbportal.cn 完成企业核验并申请编码；2026-09-12 10:01 已提交企业核验（待核验，联系人钟祺龙，邮箱 3840404902@qq.com，英文名 Shenzhen Lingyi Weichuang Technology Co., Ltd.）。企业核验 12:05 通过；**编码申请已提交（申请编号 d2026091210082070466041，待审核，5 个工作日通道）**。9-17 审核员退回简称格式（改为「零一唯创科技」/「Lingyi Weichuang Technology」）当日改完；**9-17 18:38 邓白氏编码审核通过、已交付：D-U-N-S = 576655751**（深圳零一唯创科技有限公司 / Shenzhen Lingyi Weichuang Technology Co., Ltd.）。下一步（2026-09-18 核对苹果官方口径后修正，原写的「同步 5–14 工作日」过于悲观）**：苹果帮助页明写「**拿到 D-U-N-S 编码后至多 2 个工作日** Apple 即可从 D&B 收到你的信息，之后就能以公司身份注册」（<https://developer.apple.com/help/account/membership/D-U-N-S/>）。编码 9-17（周四）18:38 交付 → **9-21（周一）即可开始在 developer.apple.com/enroll/duns-lookup 查询**（该页需登录公司 Apple ID，查询时必须填**完整法定名称** Shenzhen Lingyi Weichuang Technology Co., Ltd. + 注册地址，不能用简称/商号，否则会报「未列为法律实体」）；查到后 Apple Developer App 填 Organization Details → 付 ¥688 → Apple 审核（电话核实统一指向法人龙俊洁 15014036340）。**若两周后（约 10-01）仍查不到**：发邮件给 D&B <https://support.dnb.com/?CUST=APPLEDEV> 催同步
- **流程**：D-U-N-S 建档 1–7 工作日出编码 → 回 Apple Developer App 填 Organization Details → 付 ¥688 → Apple 审核（可能电话核实公司）
- ✅ **2026-09-20 邓白氏已同步到 Apple**（比口径早一天），Enroll 页可查到机构。**邓白氏登记信息（以后填软著 / 商店 / 备案的英文名与地址照此抄）**：
  - D-U-N-S：576655751
  - Legal Entity Name：Shenzhen Lingyi Weichuang Technology Co., Ltd.
  - Headquarters Address：Room 402, Building 3, Pingshan Craftsman Park, No. 33 Cuijing Road, Zhukeng Community, Longtian Sub-district, Pingshan District, Shenzhen, CN 518118
  - **2026-09-20 Enroll 填表进度**：机构信息已填（网站 01weichuang.com、电话 15014036340、机构邮箱 zhongqilong@01weichuang.com 已 Verified）；Signing Authority 关闭，验证人 = 法人龙俊杰（Junjie Long / Legal Representative / 15014036340）。**两个坑**：① 验证人邮箱**必须是公司域名**（@01weichuang.com），QQ 邮箱报 Invalid Email Address / lgEmail 未完成——需先给法人开公司邮箱；② 反复 Back 重填触发 **Work email verification is blocked**，Apple 要求联系支持或等约 24 h。**已于 2026-09-20 通过 developer.apple.com/contact →「会员资格和帐户 → 计划注册」提交中英双语工单，案例 ID 102969682223**（内容：请求解除工作邮箱验证限制 + 确认验证人邮箱是否必须公司域名）。下次一次填完，别多点 Verify。
  - ✅ **2026-09-22 工作邮箱验证已解封，注册表一次填完提交，进入审核（Enrollment ID `XD2C5LWH7J`）**。验证人邮箱用法人公司邮箱 `long@01weichuang.com`。
  - 下一步：等 Apple 审核邮件（发到公司 Apple ID 邮箱与 zhongqilong@01weichuang.com）→ 付 ¥688 → 可能来电核实（15014036340，法人接）→ 到位后 TestFlight 给硬件装 iPhone 包、APNs 补验、申请 Critical Alerts
- **阻塞**：iOS 真机现用个人开发证书（7 天过期需重装）；TestFlight 分发、APNs 远程推送、Bundle ID 统一都等它
- **公司信息**：深圳零一唯创科技有限公司 / 91440300MAK7XEPD38 / 深圳市坪山区龙田街道竹坑社区翠景路33号3栋坪山工匠园402
- **后续动作**：账号下来后统一正式 Bundle ID（改 `app.json` → `npx expo prebuild --clean`），并同步更新高德 iOS Key 的 Bundle ID 绑定

### 6. 推送：极光 + APNs + 安卓厂商通道

- **极光**：统一接入层，注册开发者账号即可
- **APNs**：依赖第 5 项，公司账号下来才能签远程推送 entitlement（决策 #24 实证）
- **安卓厂商通道**（小米/华为/OPPO/vivo）：各需一个开发者账号 + 应用包名登记，统一挂到极光后台；华为等厂商杀后台激进，不走厂商通道推送到达率会明显下降
- 后端已有 `PushProvider` 薄接口 + Console Mock

### 7. 高德地图 Key

- **个人 Key 已到位**（2026-08-16），地图 Spike 已完成、地图库已定案 WebView + JS API（决策 #33），A 线地图页已实现——**开发不再被阻塞**
- ✅ **企业认证已完成（2026-09-06）**：对公打款回填通过，账号主体已为深圳零一唯创科技有限公司
- **需要的 Key**（见 `app/.env.example`）：Web端(JS API) Key + 安全密钥 = **地图主 Key**；Android Key（包名 + SHA1）、iOS Key（Bundle ID）保留备查
- ~~剩余动作：在企业主体下重新创建 Web端(JS API) Key 换入~~ → **2026-09-17 发现企业账号「未获得技术服务使用许可」是付费年包**（基础版 ¥50,000/年、高级版 ¥100,000/年，2024.7.16 新定价起企业主体商用授权与正式配额依赖它）。**MVP 期间维持个人 Key（JS API 不绑包名/SHA1，Bundle ID 切换对地图零影响）**，不阻塞任何开发/演示。
- 🔴 **上线前待汤总拍板（经营成本项）**：① 购买高德基础版 ¥5 万/年（合规 + 配额一次解决）；② 换腾讯位置服务/百度地图（评估企业免费配额与商用条款；地图层是独立组件，换 JS API 底图约一周）；③ 个人 Key 商用——违反条款、有封 Key 风险，不建议。~~可先在企业账号试建 Web端(JS API) Key~~ → ✅ **2026-09-17 企业账号已建三把 Key**（应用「AI头盔」：Web端(JS API)+安全密钥 / iOS `com.lingyiweichuang.app` / Android 包名 + debug.keystore SHA1），**Web Key 已换入 `app/.env`**（模拟器地图验证通过；旧个人 Key 以注释留在 `.env` 备回滚，Key 值只在密码管理器/私聊，不进 Git）。控制台明示：未购许可前 Key「仅供短期、少量测试」——上线前决策不变。Android Key 现绑的是 Expo 默认 `debug.keystore` 指纹，**正式签名证书生成后要回控制台改「发布版 SHA1」**。

### 8. 腾讯云 TRTC

- 选型已定案（决策 #22），后端 UserSig 自实现官方 HMAC-SHA256 算法，不引 SDK 依赖
- ✅ **补验通过（2026-08-16）**：Developer A 提供个人测试应用凭证，填入 `backend/.env` 的 `TRTC_SDK_APP_ID` / `TRTC_SECRET_KEY` 后实测「注册 → 建频道 → 取进房凭证」全链路，`POST /voice/channels/:channelId/token` 正常返回 `sdkAppId` / `roomId` / `userSig`（216 字符）/ `expiresAt`（24h）。**Week 9–10 遗留项①清零**
- 正式应用待公司资质就绪后在同一腾讯云账号下创建，**换 Key 零代码改动**（仅改 env）
- ✅ 对讲已切服务端签发 UserSig；**2026-09-17 删除 spike-* 页与 `EXPO_PUBLIC_TRTC_SDKAPPID/SECRETKEY`（SecretKey 曾随 Spike 页进客户端包）**，App 不再持有任何 TRTC 密钥

## 域名与 HTTPS（决策 #34）

公司主域名 `01weichuang.com` 已在腾讯云完成 ICP 备案。**已备案主域名的子域名，在主体与接入商均相同时无需单独备案**，加 DNS 解析即可使用 80/443。

| 子域名 | 指向 | 端口 | 阶段 |
|--------|------|------|------|
| `dev-api.01weichuang.com` | NestJS 后端（REST + WebSocket） | 443 | development |
| `dev-mqtt.01weichuang.com` | EMQX Broker | **8883（MQTT over TLS）** | development |
| `dev-admin.01weichuang.com` | 管理后台静态站 | 443 | development |
| `api` / `mqtt` / `admin.01weichuang.com` | 同上 | — | production（Week 11–12） |

**HTTPS 证书**：公司网站已有证书，但若为单域名证书则**不覆盖上述子域名**，需另行处理：

- 腾讯云 SSL 控制台可免费签发 DV 证书，但**免费档仅支持单域名**——按上表逐个子域名各申请一张（免费，可申请多张）
- 或使用泛域名证书 `*.01weichuang.com` 覆盖全部（腾讯云泛域名证书需付费；Let's Encrypt 泛域名免费但需 DNS-01 验证 + 自动续期）
- **MQTT over TLS 复用同一张证书**：EMQX 监听 8883 时加载 `dev-mqtt` 对应的证书链

## 与硬件团队的关联项

域名定下来后，需同步给硬件团队（张森淼）确认，属联调清单：

1. ⏸️ **MQTT 接入地址**：`dev-mqtt.01weichuang.com:8883`（MQTT over TLS）——4G 模组是否支持 TLS、CA 证书如何预置。**决策 #35 后延至硬件扩展 4G 时确认**；MVP 走 BLE 中转（HTTPS），联调只需 `dev-api` 域名
2. ~~**头盔 BLE 数据协议**~~ ✅ v0.6 定稿（决策 #38）；遗留修正、广播 FEE0 等见 DEVICE_PROTOCOL §10 A/B
3. DEVICE_PROTOCOL.md §10 A–E 余项 19 条（2026-09-18 已整理发张森淼：`docs/HARDWARE_SYNC_2026-09-18.md`）

## 建议办理顺序

| 优先级 | 事项 | 理由 |
|--------|------|------|
| **本周** | 云端 `deploy/.env` 填 TRTC 测试 Key | 本地已补验通过；云端留空时对讲凭证接口返回 503 |
| **本周** | 重提 D-U-N-S 建档 | 周期最长的剩余项，解 iOS 全链路 |
| **Week 9 前** | 腾讯云短信签名/模板、极光 + 厂商通道、COS | 都是「换 Provider 实现」，晚接不影响开发 |

## 9–10. 软著与 App 备案（2026-09-10 新增）

**App 正式命名（汤总 2026-09-10 拍板）**：上架名与显示名 **「零一唯创」**（品牌 App，不限定为头盔专用，后续公司其他产品可并入）；软著名「零一唯创App V1.0」；商标由公司自行注册（建议「零一唯创」文字 + 「01」图形分开注册，第 9/42/38 类）。**2026-09-11 更新**：公司先注册 **「零一」** 与 **「零一唯创」** 两个文字商标；骑行头盔 App 的最终显示名待定（候选「零一护航」「零一骑安」，不急，改名只动 app.json 两行）。

- **软著**：中国版权保护中心 <https://register.ccopyright.com.cn/> 在线填表（照 `01/软著/软著申请表填写信息.md` 逐项抄）→ 上传源程序/说明书 PDF + 营业执照 → 打印申请表盖章。免费 30 个工作日；加急找代理 5–10 个工作日。证书是安卓各商店上架的硬性材料。
- **App 备案**：腾讯云控制台「备案」→ 新增 App（安卓、iOS 各一条），填 App 名「零一唯创」、包名 / Bundle ID、服务域名 `api.01weichuang.com`、服务器 111.230.157.151。主体已备案，只做 App 新增，1–2 周。**前置**：A 线把 `app.json` 的 `name` 改为「零一唯创」、`android.package` / `ios.bundleIdentifier` 改为 `com.lingyiweichuang.app`（需 `npx expo prebuild --clean`，高德平台 Key 绑定同步更新）。
- **上架其余材料**（交付前一周准备）：隐私政策 + 用户协议网页（挂官网）、各尺寸截图、审核演示账号（建议后端加「审核白名单手机号固定验证码」配置）、安卓各商店企业开发者账号（营业执照 + 对公打款）。

- **Apple Critical Alerts entitlement（2026-09-17 新增待办）**：锁屏 SOS 告警目前走普通本地通知（系统通知声，静音键/勿扰会压掉）；要穿透静音需向 Apple 申请 `com.apple.developer.usernotifications.critical-alerts`，公司 Apple Developer 账号到位后提交（说明用途：摔倒/求救 60 s 倒计时提醒）。

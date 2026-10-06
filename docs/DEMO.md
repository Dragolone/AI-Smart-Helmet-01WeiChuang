# DEMO.md — MVP 演示脚本（Week 12 交付物）

> 给演示者（负责人 / 汤总汇报 / 客户到访）的操作脚本：每一步写「做什么 → 应该看到什么」，非开发背景也能照做。
> 演示环境 = 云端 development（`dev-api` / `dev-admin.01weichuang.com`，DEPLOYMENT.md），常驻 Mock 头盔 24 小时在线；真头盔到货后把「Mock 头盔」换成真机，步骤不变（CLAUDE.md Mock Data Strategy）。
> 本脚本只覆盖软件侧；摔倒/危险判断由头盔算法给出，演示中由 Mock 剧本或 App 演练模式模拟触发。

## 0. 演示前 15 分钟检查

| # | 检查 | 命令 / 位置 | 应看到 |
|---|------|-------------|--------|
| 1 | 后端在线 | 浏览器开 `https://dev-api.01weichuang.com/api/v1/health` | `{"status":"ok","database":"connected"}` |
| 2 | Mock 头盔在线 | 管理后台 → 设备 → 搜 `helmet_94173f` | 在线 ✅、电量在变、最近心跳 < 90s |
| 3 | 两台手机装好 App 且已登录 | iPhone + 安卓各一台（开发证书包 7 天过期，演示前一天重装） | 首页设备卡显示 Mock 头盔 |
| 4 | 手机联网、蓝牙开、通知权限已允许 | 系统设置 | — |
| 5 | 演示账号 | 密码管理器「演示账号」条目（手机号 + 密码）；App 端账号已绑定 `helmet_94173f`（绑定码 `94041564`） | — |
| 6 | 紧急联系人 | App → 我的 → 紧急联系人：填一个**演示者自己的手机号** | 列表里有 1 条 |
| 7 | 短信通道 | 当前是 Console Mock：短信内容打在后端日志，不会真发（THIRD_PARTY §4 过审后自动变真发） | 演示时打开日志窗口：`docker compose -f docker-compose.prod.yml logs -f backend \| grep -E "MOCK SMS\|MOCK PUSH"` |

**备用方案**：云端故障时切本地——Mac 上 `docker compose up -d`（PG + EMQX）→ `npm run start:dev -w backend` → Mock `npm run start -w mock-device` → App `.env` 指到 Mac 局域网 IP（DEVELOPMENT.md）。

## 1. 故事线（约 20 分钟）

### 1.1 注册与绑定（2 分钟）

1. App 登录页 → 注册 → 输入手机号 → 点「获取验证码」 → **后端日志窗口出现 `[MOCK SMS] … 您的验证码为 123456`** → 填码、设密码 → 注册成功进首页。
2. 首页「绑定设备」→ 扫码（演示卡片上的二维码）或手输 `helmet_94173f` + `94041564` → **设备卡出现：在线、电量、固件版本**。
   - 讲解点：验证码/绑定码都是服务端签发；换绑后旧绑定码作废；扫码格式已定给硬件印制（DEVICE_PROTOCOL §11）。

### 1.2 实时位置与轨迹（3 分钟）

1. 底部「地图」→ **头盔 Marker 沿深圳湾绿道每 10s 移动一次**，底部抽屉显示速度/里程。
2. 抽屉上拉 → 「历史轨迹」→ 选 1H → **回放最近一小时的路线，可拖进度、倍速**。
3. 点「分享位置」→ 系统分享面板（微信等）；点「导航到头盔」→ 拉起高德 App。
   - 讲解点：位置 5s 一点入库、WebSocket 实时推送、轨迹保留策略预留；MVP 不做 App 内导航（决策 #32）。

### 1.3 摔倒 → 60 秒倒计时 → 自动通知（5 分钟，核心）

**方式 A（推荐，服务端真实链路）**：让 Mock 头盔发一次「疑似摔倒」：

```bash
# 服务器上（或提前 5 分钟做，剧本启动后第 5 个位置点触发一次）
cd AI-Smart-Helmet-01WeiChuang/deploy
sed -i 's/^MOCK_SCENARIO=.*/MOCK_SCENARIO=fall/' .env && docker compose -f docker-compose.prod.yml up -d mock
```

1. 约 50s 后（5 个位置点）→ **两台手机同时弹出 SOS 倒计时页：60、59、58…，警报音 + 振动**；锁屏状态下为通知横幅。
2. 演示「取消」：点「我没事」→ **倒计时停止，「安全」→「查看记录」→「SOS 记录」里多一条「已取消」**。
3. 再触发一次（把 `MOCK_SCENARIO` 改回空再改为 `fall`，或用方式 B），这次**不点取消**：
   - 到 0 → 页面变「已通知紧急联系人」；
   - **后端日志出现 `[MOCK SMS] → 138****xxxx [sos_alert] 您被设为紧急联系人的骑行者，其零一唯创智能头盔刚刚发出紧急求救，请立即致电确认其安全。`**（固定文案，不含昵称和位置，决策 #46）（短信过审后这里就是真短信）；
   - SOS 记录详情（「安全」→「查看记录」→「SOS 记录」点进去）：触发时间、位置小地图、通知结果逐条（短信/推送、成功/失败）。
4. 演示「SOS Now」：倒计时中点「立即求救」→ 立刻通知，不等 60s。
   - 讲解点：倒计时由**服务器**计时——App 被杀、手机没电都不影响到期通知（当场可以杀掉 App 再看后端日志）；重复上报不重复建单；对外口径「秒级检测、倒计时确认后自动通知」（决策 #28），蓝牙版前提「手机随身且 App 未被手动关闭」。

**方式 B（不动服务器）**：Mac 上用中转模式 Mock（模拟蓝牙版手机中转链路）：

```bash
TRANSPORT=app-relay API_BASE_URL=https://dev-api.01weichuang.com RELAY_PHONE=<演示账号> RELAY_PASSWORD=<密码> DEVICE_ID=helmet_94173f SCENARIO=fall EMERGENCY_AFTER_POINTS=2 npm run start -w mock-device
```

**方式 C（纯 UI，不通知任何人）**：App → 安全中心 → 「SOS 演练」——只演示倒计时页与警报音。

### 1.4 危险事件（2 分钟）

```bash
sed -i 's/^MOCK_SCENARIO=.*/MOCK_SCENARIO=risk/' .env && docker compose -f docker-compose.prod.yml up -d mock
```

1. **安全中心事件列表每 80s 置顶一条「后方来车 · 高危」**，2 个点后自动「已解除」；点开看距离/方向/置信度与原始 payload。
2. 事件详情「录像」→ 视频就绪事件已关联（COS 真桶就绪，预签名链接 10 分钟有效；上传方式待硬件）。
   - 讲解点：软件只接收算法结论并留档，不做判断；头盔本地蜂鸣/振动毫秒级，App 展示是第二道。

### 1.5 设备设置下发（2 分钟）

1. 设备详情 → 蜂鸣音量拖到 70 → **状态流转：下发中 → 已送达 → 已生效**（Mock 默认回执 success）。
2. 把 `.env` 的 `MOCK_CMD_RESULT=silent` 重建 mock 后再拖一次 → **30s 后显示「未送达 / 设备离线」，旧值不变**。
   - 讲解点：「绝不把未执行显示为成功」是铁律；蓝牙版走 WS 下行 + BLE 写入 + 回执，业务层与 4G 版等价（决策 #36）。

### 1.6 网络对讲（2 分钟，两台手机）

1. 手机 A：对讲 → 创建频道 → 显示 6 位邀请码；手机 B：加入 → 输码 → **两端成员列表互见昵称头像**。
2. 按住 PTT 说话 → 另一端听到；戴蓝牙耳机切换音频路由。
   - 讲解点：腾讯 TRTC，凭证服务端签发（App 不持密钥）；依赖手机蜂窝网络，硬件电台为双模兜底。

### 1.7 管理后台（2 分钟）

浏览器开 `https://dev-admin.01weichuang.com`（管理员账号见密码管理器）：

1. 概览：设备/在线/用户/今日事件/进行中 SOS（15s 自动刷新）——刚才的 SOS 会在这里。
2. 事故 / SOS：按状态筛选，看到 1.3 产生的两条（已取消、已通知）。
3. 事件历史：`invalid=true` 切到校验失败留档视图——讲「脏数据不丢、不进业务」。
4. 设备详情：最近 10 条事件 + 当前生效设置（1.5 下发的音量 70）。

## 2. 演示后复位

```bash
cd AI-Smart-Helmet-01WeiChuang/deploy
sed -i 's/^MOCK_SCENARIO=.*/MOCK_SCENARIO=/; s/^MOCK_CMD_RESULT=.*/MOCK_CMD_RESULT=success/' .env
docker compose -f docker-compose.prod.yml up -d mock
```

演示账号的事故记录保留即可（后台视角的历史数据也是演示素材）。

## 3. 常见状况

| 现象 | 处理 |
|------|------|
| 倒计时页没弹出 | 看 App 右上角「连接中断」药丸是否亮：亮=WS 断了，下拉刷新安全中心（REST 兜底会把进行中 SOS 拉出来）；再看后端日志有没有 `SOS … 已建单` |
| 地图空白 | 海外演示高德底图只覆盖中国大陆（DEVELOPMENT.md 平台限制）；Mock 路线在深圳不受影响 |
| iOS 装不上 / 打不开 | 个人开发证书 7 天过期：重新 `xcodebuild … install`（DEVELOPMENT.md 真机调试）；公司账号下来后走 TestFlight |
| 对讲进房失败 503 | 云端 `.env` 的 `TRTC_*` 未填或 Key 失效（THIRD_PARTY §8） |
| 后端 502 | `docker compose … ps` 看 backend 是否重启中；发布时会有 3s 排空窗口（`/health` 返回 draining） |

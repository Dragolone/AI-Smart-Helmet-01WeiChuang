# DEPLOYMENT.md — development/production 环境部署手册

> 目标读者：负责人/开发者本人。从一台空的腾讯云服务器到全部服务跑通,每步都写「执行什么 → 应该看到什么」。
> 架构不变式:与本地完全同一套代码,只是 Docker Compose 多起了 backend 和 gateway 两个容器(CLAUDE.md 环境规划)。
> 域名与证书口径见决策 #34;MQTT 暂 1883 明文(TLS 待硬件确认,见 §8)。

## 1. 拓扑总览

```text
                      互联网
                        │
        ┌───────────────┼──────────────────┐
   443/80 (HTTPS)   1883 (MQTT,防火墙限源) 22 (SSH,限自己IP)
        │               │
  ┌─────▼─────┐   ┌─────▼─────┐
  │  gateway  │   │   emqx    │──认证/ACL 回调──┐
  │ Caddy+Admin│   │  EMQX 5   │                │
  └─────┬─────┘   └─────┬─────┘                │
        │ /api,/ws      │ MQTT                  │
  ┌─────▼───────────────▼─────┐                │
  │        backend :3000       │◄───────────────┘
  │  NestJS(REST+WS+MQTT消费) │      http://backend:3000（容器网络）
  └─────────────┬─────────────┘
          ┌─────▼─────┐
          │ postgres  │  ← 无宿主端口,仅容器网络可达
          └───────────┘
```

| 域名 | 指向 | 用途 |
|------|------|------|
| `dev-api.01weichuang.com` | gateway→backend | App 的 REST + WebSocket(wss 自动) |
| `dev-admin.01weichuang.com` | gateway | 管理后台 SPA + 同源 /api 转发 |
| `dev-mqtt.01weichuang.com` | 服务器 IP:1883 | 外部设备/Mock 的 MQTT 接入 |
| (容器内) `mock` | emqx:1883 | **演示常驻 Mock 头盔**(profile demo,§3 ⑦),与外部设备同认证同 Topic,只是不出公网 |

HTTPS 证书由 Caddy 自动申请、自动续期(Let's Encrypt),不需要手动管理;失败预案见 §7。

## 2. 前置条件

1. **服务器**:腾讯云轻量应用服务器 2C4G 起,Ubuntu 22.04(选 Docker CE 应用镜像可跳过 §3 第 1 步),地域广州/深圳。
2. **DNS**:DNSPod 给 `01weichuang.com` 加三条 A 记录 → 服务器公网 IP:`dev-api`、`dev-admin`、`dev-mqtt`。**先解析再部署**(Caddy 起来就会验证域名签证书)。
3. **防火墙**(腾讯云控制台防火墙页,不是服务器内 iptables):

| 端口 | 协议 | 放通范围 | 用途 |
|------|------|---------|------|
| 22 | TCP | 建议限自己 IP | SSH |
| 80 | TCP | 全部 | ACME 证书验证 + 跳转 https |
| 443 | TCP | 全部 | API/Admin/WS |
| 1883 | TCP | **限硬件团队与开发者出口 IP** | MQTT 明文,联调期临时口径 |
| 18083 | — | **不开**(容器只绑 127.0.0.1) | EMQX Dashboard 走 SSH 隧道 |

## 3. 首次部署(约 20 分钟;**development 已于 2026-09-06 按本节部署完成**:helmet-dev 111.230.157.151,广州,2C4G/90GB/6Mbps,到期 2027-09-06;**2026-09-18 更新到 main 365fbad:排空/网关拦截/日志轮转/备份 cron 全部生效,§4 #8/#9 已验收**)

```bash
# ① 装 Docker(镜像自带则跳过;验证:docker compose version 有输出)
curl -fsSL https://get.docker.com | sh

# ② 拉代码(仓库私有:先在服务器 ssh-keygen 生成密钥,把公钥加为仓库只读 Deploy Key;
#    国内到 GitHub 只有几十 KB/s,用 --depth 1 浅克隆,否则大概率中途断开)
ssh-keygen -t ed25519 -C "helmet-dev-server" -f ~/.ssh/id_ed25519 -N "" && cat ~/.ssh/id_ed25519.pub
ssh-keyscan github.com >> ~/.ssh/known_hosts 2>/dev/null
git clone --depth 1 git@github.com:Dragolone/AI-Smart-Helmet-01WeiChuang.git
cd AI-Smart-Helmet-01WeiChuang/deploy

# ②' 切国内源(2026-09-06 实测必做:apt 走 debian 官方源 25 分钟没装完,切腾讯云内网源后整轮构建 < 2 分钟)
#    只改服务器本地副本、不提交;之后 git pull 前 git stash、拉完 git stash pop
sed -i '/^RUN apt-get update/i RUN sed -i "s#deb.debian.org#mirrors.tencentyun.com#g" /etc/apt/sources.list.d/debian.sources' ../backend/Dockerfile
sed -i '/^RUN npm ci/i RUN npm config set registry https://registry.npmmirror.com' ../backend/Dockerfile ../mock-device/Dockerfile Dockerfile.gateway

# ③ 配置环境变量
cp .env.example .env
# 编辑 .env:域名三项按需改;ACME_EMAIL 填真实邮箱;
# 其余每个密钥独立执行 openssl rand -hex 32 生成(禁止复用);TRTC 两项可先留空
vim .env

# ④ 渲染 EMQX 配置(把 EMQX_INTERNAL_TOKEN 填进回调 URL)
sh render-config.sh          # → 已生成 deploy/generated/emqx.conf

# ⑤ 构建并启动(首次构建 5-10 分钟)
docker compose -f docker-compose.prod.yml up -d --build

# ⑥ 看启动日志,等 backend 出现「已订阅:helmet/+/status, ...」
docker compose -f docker-compose.prod.yml logs -f backend
# 注:头几秒 MQTT 报「Not authorized」后自愈是已知现象(自举时序),看到「已订阅」即健康
```

**创建管理员与开通设备**(与本地同一套脚本,在容器内执行):

```bash
docker compose -f docker-compose.prod.yml exec backend npm run create:admin       # 密码只显示一次
docker compose -f docker-compose.prod.yml exec backend npm run provision:device   # deviceSecret 只显示一次
# 第二顶常驻 Mock（真机多设备回归，2026-10-08）：再开一台 → 填 MOCK2_DEVICE_* → COMPOSE_PROFILES=demo,demo2 → up -d --build mock2
# 第三顶常驻 Mock（汤总体验用，2026-10-14）：同上换成 MOCK3_DEVICE_* / demo3 / mock3；剧本别设 fall、sos（会周期性真发求救短信）
# 第四顶常驻 Mock（负责人自测用，2026-10-14）：MOCK4_DEVICE_* / demo4 / mock4，剧本 tour：每轮 12 分钟依次演 8 条各不相同的安全事件
#   （后方来车 / 左右侧车辆 / 前方行人 / 远近障碍物 / 后方不明目标，三档等级，4 条带录像，各自到点解除）、摔倒（下一轮换手动求救）、
#   休眠→唤醒、蓝牙断开；每轮一次求救到期会真发短信，只绑自测账号。MOCK4_TOUR_CYCLE_POINTS 可改轮长（≥40 个点）
# 第五、六顶常驻 Mock（负责人看多头盔界面用，2026-10-15）：MOCK5_DEVICE_* / demo5 / mock5、MOCK6_DEVICE_* / demo6 / mock6，剧本留空（riding）
# 注意：`up -d --build mock2` 会连带重建 backend。原先 backend 重启那十几秒里 EMQX 会把授权结果缓存成「拒绝」（订阅 cmd 失败、
# 事件 not_authorized）；2026-10-17 起授权回调不可达时由 emqx/acl-fallback.conf 兜底，不再需要事后 `restart mock2`
docker compose -f docker-compose.prod.yml exec backend npm run provision:batch -- --count 20   # 产线批量开通:CSV + 二维码,产物在容器 /repo/backend/provision-out/
docker compose -f docker-compose.prod.yml cp backend:/repo/backend/provision-out ./provision-out   # 拷出后交接,两边都销毁
```

**⑦ 常驻演示 Mock 头盔**(CLAUDE.md「演示环境常驻 Mock 设备跑剧本,保证随时可 Demo」;compose 服务 `mock`,与外部真机/Mock 同认证同 Contract):

```bash
# 把 ⑥ 开通的凭证填进 deploy/.env,并打开 profile
sed -i "s|^MOCK_DEVICE_ID=.*|MOCK_DEVICE_ID=<deviceId>|; s|^MOCK_DEVICE_SECRET=.*|MOCK_DEVICE_SECRET=<deviceSecret>|; s|^#COMPOSE_PROFILES=demo|COMPOSE_PROFILES=demo|" .env
docker compose -f docker-compose.prod.yml up -d --build      # 多起一个 mock 容器,随机重启、自动重连
docker compose -f docker-compose.prod.yml logs -f mock       # 应持续「已发送 location_update」
```

- 剧本 / 上报间隔 / 命令回执三态用 `MOCK_SCENARIO` / `MOCK_LOCATION_INTERVAL_MS` / `MOCK_CMD_RESULT`(见 `.env.example`),改后 `up -d` 重建 mock 即生效。
- 常驻 Mock 每 10s 一个位置点 ≈ 8.6k 点/天,MVP 期间 PG 无压力;需要清理时走服务层(CLAUDE.md Database Rules),不裸删表。
- 不想常驻:`.env` 里注释回 `#COMPOSE_PROFILES=demo`,再 `docker compose -f docker-compose.prod.yml rm -sf mock`。

## 4. 验收清单(逐条过,全绿才算部署完成)

| # | 操作 | 预期看到 |
|---|------|---------|
| 1 | 浏览器开 `https://dev-api.01weichuang.com/api/v1/health` | 挂锁图标(证书有效)+ `{"status":"ok","database":"connected"}` |
| 2 | 浏览器开 `https://dev-admin.01weichuang.com` | Admin 登录页正常渲染 |
| 3 | 用 §3 创建的管理员登录 Admin | 进入概览页,统计数字为 0 或初始值 |
| 4 | 本地 Mac 跑 Mock 指到云端(已开常驻 mock 的话,这步只需再验「错密钥被拒」):`MQTT_URL=mqtt://dev-mqtt.01weichuang.com:1883 DEVICE_ID=<id> DEVICE_SECRET=<密钥> npm run start -w mock-device` | Mock 日志「已连接」并持续「已发送 location_update」;错密钥则被拒(Not authorized),证明认证生效 |
| 5 | Admin 设备列表刷新 | 该设备在线,电量在变 |
| 6 | App 端 `EXPO_PUBLIC_API_URL=https://dev-api.01weichuang.com/api/v1` 重启 Metro,注册→绑定→地图页 | 全流程可用,地图上看到 Mock 头盔移动(WS 走 wss 自动) |
| 7 | `docker compose -f docker-compose.prod.yml restart backend` 后重复 #1 | 服务自动恢复,health 正常(重启接管:含 SOS pending 恢复逻辑)。重启期间 `curl` health 先见 `503 {"status":"draining"}` 再恢复 200(SIGTERM 排空,审计 DBOPS-07) |
| 8 | `curl -s -o /dev/null -w '%{http_code}' -X POST https://dev-api.01weichuang.com/api/v1/internal/emqx/authenticate` | **404**——EMQX 回调只走容器网络,公网被网关拦下(审计 MQTT-03);同时 Mock 仍在线(容器内回调不受影响) |
| 9 | `sh backup.sh`(§5 备份) | 末行 `✓ 已上传 backups/helmet_<时间>.dump(x MB)…`;COS 控制台**备份桶**内 `backups/` 出现该对象（dev 未分桶时在媒体桶,日志带 ⚠️ 行） |
| 10 | `docker inspect helmet-backend-1 --format '{{json .HostConfig.LogConfig}}'`(容器名以 `docker compose ps` 为准) | `max-size: 20m / max-file: 5`——日志轮转生效,不会写满盘 |

## 5. 日常运维

```bash
cd AI-Smart-Helmet-01WeiChuang/deploy

# 发布更新(拉代码→重建变更的镜像→滚动重启;migration 在 backend 启动时自动应用)
git pull && docker compose -f docker-compose.prod.yml up -d --build

# 看日志 / 看状态
docker compose -f docker-compose.prod.yml logs -f backend
docker compose -f docker-compose.prod.yml ps

# EMQX Dashboard(本地 Mac 执行,浏览器开 http://localhost:18083,账号 admin/.env 里的密码)
ssh -L 18083:localhost:18083 <user>@<服务器IP>

# 数据库备份:每日自动 → COS(上线前清单 #6 ①;脚本 deploy/backup.sh,上传逻辑 backend/src/scripts/backup-upload.ts)
sh backup.sh                       # 手动跑一次:pg_dump -Fc → 管道进 backend 容器上传到 COS backups/,并清理超过保留期的旧份
#   备份桶与媒体桶分开（2026-10-14）：deploy/.env 填 TENCENT_COS_BACKUP_BUCKET（控制台新建一个私有桶，helmet-cos 子账号的权限对全账号的桶都有效，不用另授）；
#   没填时备份落到媒体桶、日志里打 ⚠️——媒体换链接接口按设备上报的路径签名，备份与视频同桶等于给设备一条通往整库导出的路
crontab -e                         # 加一行(每天 03:00 北京时间=19:00 UTC,按服务器时区调整):
#   0 3 * * * /home/ubuntu/AI-Smart-Helmet-01WeiChuang/deploy/backup.sh >> /home/ubuntu/helmet-backup.log 2>&1
#   ⚠️ 日志别写 /var/log：cron 以 ubuntu 用户跑，那里没写权限，重定向失败会让整条任务不执行（2026-09-18~22 踩中，4 天无备份）
#   ⚠️ 服务器无 MTA，cron 失败输出被丢弃、不会通知任何人；验收看 ~/helmet-backup.log 最后一行「备份完成」或 COS backups/ 最新对象时间
# 可选环境变量(写在 crontab 行首):BACKUP_RETENTION_DAYS(默认 30)、BACKUP_KEEP_MIN(至少保留几份,默认 7)、BACKUP_LOCAL_DIR(同时留本地副本)
# 备份失败脚本非 0 退出并打印 ✕ 行;上传脚本拒绝非 PGDMP 输入——pg_dump 失败不会上传空文件。COS 保留期由脚本清理,不依赖桶生命周期规则

# 恢复演练 / 事故恢复(用隔离库先演练一次再动生产)
docker compose -f docker-compose.prod.yml exec -T postgres pg_restore -U helmet -d helmet --clean --if-exists --no-owner < helmet_<时间>.dump
#   备份文件从 COS 控制台（备份桶 TENCENT_COS_BACKUP_BUCKET）下载,或 backend 容器内用同一套凭证取回;恢复后跑 §4 #1/#3/#5 验证计数与关系
```

- **容器日志轮转**(上线前清单 #6 ②):compose 所有服务 `logging: json-file max-size 20m × max-file 5`(`x-logging` 锚点),改动后 `up -d` 重建才生效;更久的历史不靠容器日志。
- **对外拨测告警**(上线前清单 #6 ③,✅ 2026-09-22 已开通 UptimeRobot,账号 zhongqilong@01weichuang.com,HTTP/S 类型即可——`/health` 故障返回 503):UptimeRobot(免费档 5 分钟一次)或腾讯云「云拨测」新建 HTTP(s) 监控 → URL `https://dev-api.01weichuang.com/api/v1/health`、方法 GET、关键字匹配 `"status":"ok"`、失败 2 次告警到邮箱/微信;production 上线时把 `api.01weichuang.com` 再加一条。`/health` 返回 `503 draining` 只在发布重启的几秒内出现,拨测间隔远大于它,不会误报。

- 改了 `deploy/.env` 里的 `EMQX_INTERNAL_TOKEN`:重跑 `sh render-config.sh` 再 `up -d`(backend 与 emqx 都要重启)。
- 改了 `emqx/acl-fallback.conf`(授权回调不可达时的本地 ACL,DEVICE_PROTOCOL §3.1),或第一次部署带它的版本:`sh render-config.sh` 后 `up -d --force-recreate emqx`——单文件挂载绑的是旧文件,普通 `up -d` 读不到新内容。EMQX 重启时 Mock 与 backend 会断开几秒再自动重连。
- `.env` 里 `COMPOSE_PROFILES=demo` 打开后,§5 所有命令自动包含 mock 服务;`git pull` 后 `up -d --build` 会连 mock 一起重建。
- 改了 `Caddyfile`:**用一次性容器校验,再强制重建网关**。配置写坏会让网关起不来,API 与 Admin 一起断:

  ```bash
  docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  docker compose -f docker-compose.prod.yml up -d --force-recreate gateway   # 校验通过再执行
  ```

  ⚠️ **两个都是 2026-09-23 踩出来的,别改回去**:

  1. **不要用 `exec gateway caddy validate` 校验**。compose 把 Caddyfile 按**单个文件**挂进容器,绑的是 inode;`git pull` 写临时文件再改名,inode 变了,**容器里看到的仍是旧内容**。当天 validate 报 `Valid configuration`、`up -d` 一重建就 `wrong argument count` 崩溃重启,网关挂了约 10 分钟。一次性容器挂的是当前主机文件,校验的才是真要跑的那份。
  2. **同一个原因,`restart gateway` 不会加载 `git pull` 来的新配置**,必须 `up -d --force-recreate gateway`(容器内手改文件时 `restart` 才有效)。
  3. Caddy 的 `handle` **只接受一个匹配符**,`handle /a /a/*` 会启动失败;要匹配多个路径就写多个 handle 块。

- **隐私政策 / 用户协议静态页**(`deploy/legal/`,2026-09-23 新增):对外地址 `https://<API_DOMAIN>/legal/privacy`、`/legal/terms`,由网关直接提供,不经后端。目录走 volume 挂载,**首次生效要 `up -d gateway` 重建容器**(新增挂载点),之后改文案只需 `git pull` + `restart gateway`:

  ```bash
  git pull
  docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" caddy:2 \
    caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  docker compose -f docker-compose.prod.yml up -d --force-recreate gateway
  sleep 5
  docker compose -f docker-compose.prod.yml ps gateway               # STATUS 必须是 Up,不是 Restarting
  curl -sI https://dev-api.01weichuang.com/legal/privacy | head -1   # 期望 HTTP/2 200
  curl -sI https://dev-api.01weichuang.com/api/v1/health | head -1   # 回归:路由改动没碰坏 API
  ```

  只发布 `/legal/privacy` 与 `/legal/terms`;不带子路径的 `/legal` 不支持(走 API 的 404)。

  这两个 URL 是极光「隐私协议」字段、App 备案、双端应用商店上架的硬性材料;production 上线后同一路径换成 `api.01weichuang.com`,App 内链接同步改。
- **production 环境**:按 §8 清单从本套复制——新服务器 + 新 `.env`(全部密钥重新生成)+ 域名去掉 `dev-` 前缀,步骤完全相同。

## 6. 安全基线(部署时核对)

- [ ] `.env` 每个密钥独立强随机;`deploy/.env` 与 `deploy/generated/` 确认未被 Git 跟踪(`git status` 查不到)
- [ ] PostgreSQL 无宿主端口映射;backend 无宿主端口映射(只能经 gateway 443)
- [ ] 1883 防火墙已限源 IP;18083 只绑 127.0.0.1
- [ ] EMQX Dashboard 密码非默认 public
- [ ] SSH 建议改密钥登录、禁密码

## 7. 排障

| 症状 | 原因与处理 |
|------|-----------|
| Caddy 日志反复 `obtaining certificate` 失败 | 先查 DNS 是否已解析到本机(`dig dev-api.01weichuang.com`)、80 端口是否放通。若确认是 Let's Encrypt 网络不通(国内偶发):腾讯云 SSL 控制台按子域名申请免费 DV 证书,下载 nginx 格式的 crt/key 放服务器 `/opt/certs/`,compose 给 gateway 加挂载 `- /opt/certs:/certs:ro`,Caddyfile 对应站点块内加一行 `tls /certs/<域名>.crt /certs/<域名>.key`,restart gateway。两分钟的事,不影响其他一切 |
| `npm ci` / `apt-get` 在构建时极慢/超时 | 国内服务器访问 npmjs 与 deb.debian.org 不稳。按 §3 ②' 切腾讯云内网源 + npmmirror(本地开发不需要,别提交) |
| ubuntu 用户 `docker` 报 `permission denied ... docker.sock` | 首次登录用户不在 docker 组:`sudo usermod -aG docker $USER && newgrp docker` |
| Mock/设备连 MQTT 被拒 `Not authorized` | 依次查:① deviceId/deviceSecret 是否 §3 开通的那套;② `generated/emqx.conf` 是否渲染过、token 与 `.env` 一致;③ backend 是否健康(连接认证 fail-closed,后端挂了新连接全拒,这是设计行为;已连着的设备发自己的 Topic 由 `emqx/acl-fallback.conf` 兜底放行) |
| backend 起不来:`P1001 Can't reach database` | postgres 容器健康检查未过就被连了,`docker compose ... ps` 看 postgres 状态;一般 restart backend 即愈(depends_on 已配 healthy,极少出现) |
| Admin 页面白屏 | 强刷(Cmd+Shift+R);仍白屏看 gateway 日志 `docker compose ... logs gateway`,确认 /srv/admin 有产物(镜像构建时烧入,重建 gateway 镜像) |

## 8. production 首次部署清单(Week 11–12,从 development 复制;逐条打勾)

与 §3 步骤完全相同,只有输入不同。**development 的任何密钥、数据库、证书都不复用**。

| # | 项 | 与 development 的差异 |
|---|----|----------------------|
| 1 | 新服务器(腾讯云轻量 2C4G 起,同一账号) | 新实例;development 保留作联调/演示 |
| 2 | DNS 三条 A 记录 | `api` / `admin` / `mqtt.01weichuang.com`(去掉 `dev-` 前缀)→ 新 IP;先解析再部署 |
| 3 | 防火墙 | 同 §2 表;1883 只放硬件团队出口 IP;22 只放办公出口 |
| 4 | `deploy/.env` | `cp .env.example .env` 后:`API_DOMAIN`/`ADMIN_DOMAIN` 填正式域名;**全部密钥重新 `openssl rand -hex 32`**(POSTGRES/JWT/ADMIN_JWT/EMQX_INTERNAL_TOKEN/MQTT_BACKEND_PASSWORD/EMQX_NODE_COOKIE/EMQX_DASHBOARD_PASSWORD);COS/短信/TRTC 用**正式**子账号密钥与正式应用(THIRD_PARTY.md),**`TENCENT_COS_BACKUP_BUCKET` 填单独的备份桶**(THIRD_PARTY §3,2026-10-14);`TRUST_PROXY` 保持默认 1;`SOS_COUNTDOWN_SECONDS=60` 不改(决策 #28) |
| 5 | Mock 常驻 | 生产**不开** `COMPOSE_PROFILES=demo`;演示走 development |
| 6 | `sh render-config.sh` + `up -d --build` | 同 §3 ④⑤ |
| 7 | 管理员与设备 | `create:admin` 新建(密码入密码管理器);真机设备用 `provision:batch` 按批开通(CSV + 二维码交产线,单台用 `provision:device`),deviceSecret 交硬件产线 |
| 8 | 备份 cron | §5 那一行 crontab(日志写 `/home/ubuntu/`,不要 `/var/log`);**用 crontab 里一模一样的整条命令**手动跑一次,`~/helmet-backup.log` 末行「备份完成」且 ✓ 行写的是**备份桶**（不是媒体桶、没有 ⚠️ 行）,备份桶里 `backups/` 有新对象;次日再看一次日志确认定时触发 |
| 9 | 拨测 | §5 对外拨测加 `api.01weichuang.com` 一条 |
| 10 | 验收 | §4 全部 10 条 + §6 安全基线逐条打勾;App 正式包 `EXPO_PUBLIC_API_URL=https://api.01weichuang.com/api/v1` |
| 11 | ~~上线后~~ | ~~给 `helmet-cos` 子账号换新密钥~~ → 负责人 2026-10-02 决定不再轮换(09-22 已换过一次),COS 与极光沿用现有密钥 |

### 8.1 定案:现有服务器 helmet-dev 直接转正(负责人 2026-10-02)

初期用户量小,**不另购服务器**:helmet-dev(111.230.157.151)转为 production,上面的「新服务器」清单暂不执行;用户量上来后再按上表另购、用 §5 备份迁移。代价:之后没有独立的联调环境——A 线测试用专门的测试账号连同一套环境,或连本机后端。

**零代码改动**:`API_DOMAIN` / `ADMIN_DOMAIN` 可以一次填多个域名(Caddy 在解析前展开环境变量,2026-10-02 用 `caddy adapt` 验证:两个域名进同一站点),新旧域名同时可用,已经发出去的包(硬件手里的 APK、A 线开发包、极光后台登记的隐私协议地址)切换当天不会断。

| # | 步骤 | 谁 | 说明 |
|---|------|----|------|
| 1 | ✅ DNS 加三条 A 记录 `api` / `admin` / `mqtt.01weichuang.com` → 111.230.157.151(2026-10-12 已加并核对生效) | 负责人 | **现在就能加,不影响现网**;`dev-` 三条保留。App 备案填服务域名 `api.01weichuang.com` 也以此为准 |
| 2 | 定切换日 | 负责人 | 建议在 A 线回归完成之后、首次提交商店审核之前 |
| 3 | 切换前手动备份一次 | B 线 | `sh backup.sh`,确认 COS `backups/` 有新对象(§4 #9) |
| 4 | 清空测试数据 | B 线 | 当前库里全是测试账号与 Mock 轨迹,正式用户不该看到。`docker compose -f docker-compose.prod.yml stop backend mock` → `exec postgres dropdb -U helmet helmet` → `exec postgres createdb -U helmet helmet` → `up -d`(backend 启动时自动 `prisma migrate deploy` 建表)。**只删库不删卷**,EMQX / Caddy 证书不受影响 |
| 5 | 改 `deploy/.env` | B 线 | `API_DOMAIN="api.01weichuang.com, dev-api.01weichuang.com"`、`ADMIN_DOMAIN="admin.01weichuang.com, dev-admin.01weichuang.com"`;`up -d` 后 Caddy 自动给新域名签证书。第三方密钥沿用(负责人 2026-10-02 决定不轮换) |
| 5b | `REQUIRE_REAL_PROVIDERS=1` | B 线 | 转正当天必设：短信 / 推送 / COS 任一配置不全时 backend 拒绝启动（日志点名缺哪项），不再静默回落 Mock——Mock 短信在通知记录与推送文案里与真发不可区分（10-06 评审 F-2）。设完 `up -d` 看 backend 日志三条通道都不是 Mock |
| 6 | `JPUSH_APNS_PRODUCTION` | B 线 | iPhone 装的是 TestFlight / App Store 包时设 `true`;设了以后 Xcode 直装的 Debug 包收不到远程推送(极光静默丢),A 线调推送需临时改回 |
| 7 | 重建账号与演示设备 | B 线 | `create:admin` 新建管理员(密码入密码管理器);`provision:device` 开一台 Mock 填 `MOCK_DEVICE_*`,保留 `COMPOSE_PROFILES=demo`、`MOCK_SCENARIO=ski`,供商店审核演示账号绑定(THIRD_PARTY §12);A 线测试账号重新注册 |
| 8 | 验收 | B 线 | §4 十条,域名换成 `api.` / `admin.`;旧 `dev-api` health 仍 200 |
| 9 | 外部登记改新域名 | 负责人 | UptimeRobot 加 `https://api.01weichuang.com/api/v1/health`;极光「隐私协议」字段、商店后台隐私政策地址改 `https://api.01weichuang.com/legal/privacy` |
| 10 | 正式包指新域名 | A 线 | Release / TestFlight 包 `EXPO_PUBLIC_API_URL=https://api.01weichuang.com/api/v1`(App 内协议链接随之自动切换,决策 #47);B 线把 `.github/workflows/android-apk.yml` 默认地址改成 `api.` |
| 11 | 下线旧域名 | B 线 | 旧包都换掉之后(至少等硬件的测试包更新),`.env` 两项去掉 `dev-` 那个域名再 `up -d`,DNS 删 `dev-` 三条 |

## 9. 待硬件确认后:MQTT over TLS(8883)

⏸️ 决策 #35 后延——待硬件扩展 4G 时,张森淼确认 4G 模组支持 TLS 及证书预置方式后:

1. 取证书:复用 §7 手动证书路径,或从 Caddy 数据卷导出 `dev-mqtt` 证书;
2. `deploy/emqx.prod.conf.template` 追加 `listeners.ssl.default`(bind 8883,certfile/keyfile 指向挂载路径),重跑 render + 重启 emqx;
3. compose 的 emqx ports 加 `"8883:8883"`,防火墙放通 8883(仍限源 IP);
4. 设备端接入地址 `dev-mqtt.01weichuang.com:8883`;联调通过后关闭 1883 公网映射;
5. 同步更新 DEVICE_PROTOCOL §3(去 ⚠️ 标记)与本文档。

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
| `dev-mqtt.01weichuang.com` | 服务器 IP:1883 | 设备/Mock 的 MQTT 接入 |

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

## 3. 首次部署(约 20 分钟)

```bash
# ① 装 Docker(镜像自带则跳过;验证:docker compose version 有输出)
curl -fsSL https://get.docker.com | sh

# ② 拉代码
git clone https://github.com/Dragolone/AI-Smart-Helmet-01WeiChuang.git
cd AI-Smart-Helmet-01WeiChuang/deploy

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
```

## 4. 验收清单(逐条过,全绿才算部署完成)

| # | 操作 | 预期看到 |
|---|------|---------|
| 1 | 浏览器开 `https://dev-api.01weichuang.com/api/v1/health` | 挂锁图标(证书有效)+ `{"status":"ok","database":"connected"}` |
| 2 | 浏览器开 `https://dev-admin.01weichuang.com` | Admin 登录页正常渲染 |
| 3 | 用 §3 创建的管理员登录 Admin | 进入概览页,统计数字为 0 或初始值 |
| 4 | 本地 Mac 跑 Mock 指到云端:`MQTT_URL=mqtt://dev-mqtt.01weichuang.com:1883 DEVICE_ID=<id> DEVICE_SECRET=<密钥> npm run start -w mock-device` | Mock 日志「已连接」并持续「已发送 location_update」;错密钥则被拒(Not authorized),证明认证生效 |
| 5 | Admin 设备列表刷新 | 该设备在线,电量在变 |
| 6 | App 端 `EXPO_PUBLIC_API_URL=https://dev-api.01weichuang.com/api/v1` 重启 Metro,注册→绑定→地图页 | 全流程可用,地图上看到 Mock 头盔移动(WS 走 wss 自动) |
| 7 | `docker compose -f docker-compose.prod.yml restart backend` 后重复 #1 | 服务自动恢复,health 正常(重启接管:含 SOS pending 恢复逻辑) |

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

# 数据库手动备份(MVP 级:定期执行,产物拉回本地保存)
docker compose -f docker-compose.prod.yml exec postgres pg_dump -U helmet helmet | gzip > backup_$(date +%Y%m%d).sql.gz
```

- 改了 `deploy/.env` 里的 `EMQX_INTERNAL_TOKEN`:重跑 `sh render-config.sh` 再 `up -d`(backend 与 emqx 都要重启)。
- 改了 `Caddyfile`:`docker compose -f docker-compose.prod.yml restart gateway`(volume 挂载,无需重建)。
- **production 环境**:按 CLAUDE.md 规划 Week 11–12 从本套复制——新服务器 + 新 `.env`(全部密钥重新生成)+ 域名去掉 `dev-` 前缀,步骤完全相同。

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
| `npm ci` 在构建时极慢/超时 | 国内服务器访问 npmjs 不稳。backend/Dockerfile 与 Dockerfile.gateway 的 `RUN npm ci` 前临时加一行 `RUN npm config set registry https://registry.npmmirror.com`(本地开发不需要,别提交) |
| Mock/设备连 MQTT 被拒 `Not authorized` | 依次查:① deviceId/deviceSecret 是否 §3 开通的那套;② `generated/emqx.conf` 是否渲染过、token 与 `.env` 一致;③ backend 是否健康(EMQX 回调 fail-closed,后端挂了=全拒,这是设计行为) |
| backend 起不来:`P1001 Can't reach database` | postgres 容器健康检查未过就被连了,`docker compose ... ps` 看 postgres 状态;一般 restart backend 即愈(depends_on 已配 healthy,极少出现) |
| Admin 页面白屏 | 强刷(Cmd+Shift+R);仍白屏看 gateway 日志 `docker compose ... logs gateway`,确认 /srv/admin 有产物(镜像构建时烧入,重建 gateway 镜像) |

## 8. 待硬件确认后:MQTT over TLS(8883)

⏸️ 决策 #35 后延——待硬件扩展 4G 时,张森淼确认 4G 模组支持 TLS 及证书预置方式后:

1. 取证书:复用 §7 手动证书路径,或从 Caddy 数据卷导出 `dev-mqtt` 证书;
2. `deploy/emqx.prod.conf.template` 追加 `listeners.ssl.default`(bind 8883,certfile/keyfile 指向挂载路径),重跑 render + 重启 emqx;
3. compose 的 emqx ports 加 `"8883:8883"`,防火墙放通 8883(仍限源 IP);
4. 设备端接入地址 `dev-mqtt.01weichuang.com:8883`;联调通过后关闭 1883 公网映射;
5. 同步更新 DEVICE_PROTOCOL §3(去 ⚠️ 标记)与本文档。

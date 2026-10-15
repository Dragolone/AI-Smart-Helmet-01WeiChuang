# 管理后台边界测试发现（2026-10-16）

分支 `test/admin-edge-1016`。本轮新增测试 141 条（57 → 198），全部在 `admin/` 内，没碰后端、App、Contract。

## 本轮已修（代码 + 测试，各自一条提交）

| 提交 | 现象 | 原因 |
|------|------|------|
| `0128e54` | 停在后页时数据变少（「在线」筛选下设备掉线、账号注销）→ 表格空白、总数非 0、点高亮页码没反应 | 受控分页超出末页时 antd 只夹显示、不回调 onChange；新增 `useClampPage` 拉回末页 |
| `ef0daba` | 手输 `/devices/helmet%23x` 请求成 `/admin/devices/helmet`，别的设备的数据挂在这个标题下；直接打开详情点「返回」没反应 | 路由参数已解码却没 `encodeURIComponent`；首个历史条目 `navigate(-1)` 无处可回 |
| `1129950` | 库里出现三种以外的 SOS 状态 → 事故页整页白屏；新触发方式被标成「疑似摔倒」 | `STATUS_TAG[s].color` 取 undefined；`!== 'manual_sos'` 一律当摔倒 |
| `c36780a` | `devices.settings` 存成字符串 / 数字 / 布尔 → 设备详情白屏；对象值显示 `[object Object]` | 对原始值用 `in`；`String(object)` |
| `8abfda1` | 搜索超过 64 字 → 整页「加载失败」 | 后端 DTO `@MaxLength(64)`，前端不限 |
| `135de86` | 空串 / 纯空格昵称显示成空格子或「（   ）」；非法时间显示 `Invalid Date` | 后端不 trim 昵称，前端只判 null |
| `443d2e3` | 设备详情页侧栏一项都不高亮 | `selectedKeys` 用完整路径 |

## 只记录、未改（涉及接口口径或属体验取舍）

### M1 设备详情 404 呈现成「加载失败」并持续轮询（口径待定）

- 现状：`GET /admin/devices/{id}` 不存在时后端回 `404 { code: 'NOT_FOUND' }`，页面显示红色「加载失败，当前显示的不是真实数据」+「重试」，且 `refetchInterval: 30_000` 每 30 秒继续请求一个不存在的设备。
- 口径问题：API.md §10.1 只写「不存在 404」没写 code；§1.1 的 `DEVICE_NOT_FOUND` 是 App 侧「不存在或未绑定到当前用户」。Admin 是否也该用 `DEVICE_NOT_FOUND`，需要 B 线定。
- 建议：前端对 404 单独显示「设备不存在」、停轮询（code 定下来后再改，避免按 message 判断）。
- 测试：`edge-DeviceDetailPage`「设备不存在（404 NOT_FOUND）」按现状断言。

### M2 API.md 没写 Admin 查询参数的长度上限

- 后端 `AdminListQueryDto.keyword` / `deviceId` 是 `@MaxLength(64)`，`AdminEventsQueryDto.type` 是 `@MaxLength(300)`，§10.1 都没写。前端已按 64 限住（`8abfda1`），建议补进 Contract，免得以后有人只看文档。

### M3 事件页「只看校验失败留档」时仍带已选的 type

- 打开开关后类型框禁用但保留所选，请求是 `type=possible_fall&invalid=true`。后端 `listEvents` 在 `invalid=true` 时忽略 type，所以现在没影响。
- 风险：若后端以后改成两个条件叠加，留档视图会被一个已禁用、清不掉的筛选悄悄滤空。建议二选一：前端在 invalidOnly 时不发 type，或在 API.md §10.1 写明「invalid=true 时忽略 type」。
- 测试：`edge-EventsPage`「已选类型后打开只看校验失败留档」按现状断言。

### M4 数据层没有约束，前端只能兜底

- `devices.settings` 是 `Json?`，`sos_cases.status` / `trigger_type` 是自由字符串列，后端原样透出（`device.settings ?? {}`、`c.status as SosStatus`）。前端已不再白屏（`1129950`、`c36780a`），但脏数据本身来自哪里没查。建议 B 线在写入处保证 settings 是对象、状态 / 触发方式在白名单内。

### M5 翻页 / 改筛选时分页条闪一下（体验）

- 新查询键没有旧数据，`total` 临时为 0，antd 隐藏分页，表格空着转圈，回来后分页再出现。可用 TanStack 的 `placeholderData: keepPreviousData` 改善。不是错误，没改。

### M6 报错时分页总数仍是上一次成功的值（体验）

- 刷新失败后表格已清空、横幅写明「不是真实数据」，但底部仍写「共 45 台设备」（`query.data` 保留了上次成功的结果）。信息略矛盾；要不要在出错时把 total 置 0 是取舍，没改。

### M7 api 客户端对 2xx 空体抛 SyntaxError

- `api()` 成功分支直接 `res.json()`，204 / 空体会抛 JSON 解析错误。后台现有接口都带体，暂无影响；以后加 DELETE 或返回 204 的运维操作时要处理。
- 测试：`edge-client`「200 但响应体为空」按现状断言。

### M8 登录用户名不 trim（前后端都不）

- 复制带尾随空格的用户名会被统一 401 当成「用户名或密码错误」。管理员账号由脚本创建，影响小；是否 trim 属登录口径，只记录。

## 怎么跑

```sh
cd admin
npx vitest run                       # 全量
npx vitest run src/pages/edge-*      # 只跑本轮页面边界
```

admin 没有 Prettier 配置，现有文件也不是 Prettier 默认风格（双引号、分号）。本轮新文件按现有写法用
`npx prettier --check --single-quote --no-semi --print-width 120 <文件>` 检查；改动的旧文件只保证新增部分符合，不整文件重排。

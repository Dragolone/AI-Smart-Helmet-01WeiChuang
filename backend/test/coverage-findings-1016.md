# 后端分支 / 语句覆盖补测发现（2026-10-16）

分支 `test/backend-coverage-1016`。只记补测过程中发现的问题，**没有改任何服务代码**（后端归 B 线审）；
对应测试只断言现状，并在测试名里写了编号，修好后把那条测试的期望改过来即可。

> 与同晚的接口边界测试（main 上 #200 的 `backend/test/edge-findings-1016.md`）对照：三条都被独立撞到——
> BC1 = 其 **B2**（本文多了「最新位置接口同样返回 (0,0)」和在入库处一并修的建议）；BC2 = 其观察项 21；BC3 = 其观察项 1。
> 修的时候按一条处理即可，两边的现状断言测试都要改期望。

## BC1：(0,0) 「没定到位」哨兵只在 SOS 事件快照里挡了，轨迹表照收，SOS 回落最新轨迹点时又把 (0,0) 捡回来

- **现象**：`extractSosLocation` 把精确 (0,0) 当作「没定到位」的哨兵，按缺失处理、回落该设备最新轨迹点
  （注释：「否则事故地点会被钉在赤道上」）。但 `LocationRecorderService.record` 的值域校验不排除 (0,0)，
  这样的 `location_update` 照常进 `location_points`；`resolveSnapshot` 回落查最新轨迹点时也不排除 (0,0)。
  结果：头盔没定到位时连发的 (0,0) 位置点先进轨迹表，随后摔倒事件的位置也是 (0,0) → 快照回落到「最新轨迹点」= (0,0)，
  事故地点照样钉在几内亚湾；同理 `GET /devices/{id}/locations/latest` 也会把 (0,0) 当最新位置返回，App 地图跳到赤道。
- **复现**（单测，已提交，断言现状）：
  - `src/locations/location-recorder.service.spec.ts`「精确 (0,0)…现状：照常入轨迹表」
  - `src/sos/sos-trigger.branches.spec.ts`「事件位置是 (0,0) 被当缺失、回落的最新轨迹点也是 (0,0) 时，现状：快照仍钉在 (0,0)」
  - 端到端（真库 + HTTP）：`test/cov-findings.e2e-spec.ts`「BC1 现状」——Ingest 一条 (0,0) 的 location_update 后，
    `GET /devices/{id}/locations/latest` 返回 (0,0)；再来一条位置为 (0,0) 的 possible_fall，`GET /devices/{id}/accidents`
    里事故地点是 `{ latitude: 0, longitude: 0, source: 'last_point' }`。
- **期望**：同一个哨兵在全链路同一口径——要么位置表不收 (0,0)，要么所有「取最新位置」的查询都跳过它。
- **代码位置**：`backend/src/locations/location-recorder.service.ts` `extractLocation`（约第 20–49 行）；
  `backend/src/sos/sos-trigger.service.ts` `resolveSnapshot`（约第 359–387 行）；`backend/src/locations/locations.service.ts` `latest`（约第 50–63 行）。
- **缓解因素**：蓝牙版 App 对「精度 0xFF」的无定位帧整帧不上传（EVENTS.md 4.2 speed 行），所以真机 BLE 链路目前不太会出现；
  4G / MQTT、Mock、Webhook 入口没有这层过滤；硬件「无定位时填什么」仍待答（DEVICE_PROTOCOL §10 B-8）。
- **建议修法**：在 `extractLocation` 里与 SOS 一样 `if (p.latitude === 0 && p.longitude === 0) return null`（raw 已留档，不丢证据），
  一处改动同时堵住快照回落、最新位置、轨迹三条路；若担心误杀真实 (0,0)，也可只在 `resolveSnapshot` / `latest` 的查询里加
  `NOT: { latitude: 0, longitude: 0 }`。改哪种需要 B 线定口径（涉及 EVENTS.md 4.2 值域说明）。

## BC2：媒体换链接的备份前缀拦截漏了 `./backups/…` 这类带 `.` 段的写法（第二道防线，需在 COS 上确认能否利用）

- **现象**：`isSignableStorageKey` 只拦「去掉开头 `/` 后以 `backups/` 开头」和「含整段 `..`」两种。
  `./backups/x.dump`、`.//backups/x.dump`、`././backups/x.dump` 都会被放行并送去签名。
  而 COS SDK 自己的 `util.simplifyPath`（`getObject` 的 `ObjectKeySimplifyCheck`，注释写的是「对象键需要格式化，避免调用成 getBucket」，
  说明 COS 服务端会合并 `.` / `..` 段）会把这三种都归一成 `/backups/x.dump`。
- **复现**（单测，已提交，断言现状）：`src/media/media.service.spec.ts`「'./backups/x.dump' 现状放行…」。
  媒体行的 storageKey 来自设备上报的 `video_ready`，拿到任意一台设备凭证的人可以写进去。
- **能否真的换到备份**：没验证（规则不碰云端）。签名链接里路径是 `/./backups/x.dump`，若下载端或 COS 在验签前把 `/./` 规整掉，
  就可能拿到备份；若验签用原始路径，则会 403。需要 B 线在 development 的 COS 上用一个假备份对象试一次。
- **缓解因素**：根治手段（备份放单独的桶 `TENCENT_COS_BACKUP_BUCKET`，2026-10-14）已上线时这条只是第二道防线；
  没配单独备份桶的环境（`backup-upload` 会打 ⚠️）才有实际风险。
- **期望**：凡是含 `.` 段、`..` 段的键一律不签；或先按与 SDK 相同的规则归一再判前缀。
- **代码位置**：`backend/src/media/media.service.ts` `isSignableStorageKey`（第 28–30 行）。
- **建议修法**：
  ```ts
  export const isSignableStorageKey = (key: string): boolean => {
    const segs = key.replace(/^\/+/, '').split('/');
    return segs[0] !== 'backups' && !segs.some((s) => s === '.' || s === '..');
  };
  ```
  （`segs[0] !== 'backups'` 等价于原来的前缀判断；再拒掉所有 `.` / `..` 段。改后把上面那条测试的期望改成 false。）

## BC3（低）：对讲频道名全空白也能建（联系人名 / 设备名都先 trim，频道名没有）

- **现象**：`CreateChannelDto.name` 只有 `@IsString() @MinLength(1) @MaxLength(30)`，`"   "` 能通过，`VoiceService.create` 也不 trim，
  频道列表 / 邀请页上就是一个看不见名字的频道。同仓库里联系人名（`CreateContactDto` 先 `@Transform(trim)` 再验，注释「全空白名不能入库」）、
  设备名（`DevicesService.rename` trim 后空串视为清除）都处理过这种输入。
- **复现**（已提交，断言现状）：单测 `src/controller-dtos.spec.ts`「频道名 1–30；现状：全空白名也能过」；
  端到端 `test/cov-findings.e2e-spec.ts`「BC3 现状」——`POST /voice/channels { name: "   " }` → 201，名字原样存三个空格（同文件对照：联系人全空白名 → 400）。
- **期望**：与联系人同口径，trim 后再验 1–30。API.md §13（`POST /voice/channels`，body `{ name }`）没写长度与空白规则，改时顺手补上。
- **代码位置**：`backend/src/voice/voice.controller.ts` `CreateChannelDto`（约第 17–22 行）。
- **建议修法**：照 `contacts.controller.ts` 给 `name` 加 `@Transform(trim)`（那个 `trim` 小函数复制过来或抽到 `common/`），改动一两行；昵称（`UpdateMeDto.nickname`、注册 `nickname`）
  同样没有 trim，可一并定口径（昵称为空白时下游 SOS 文案已回落脱敏手机号，影响更小）。

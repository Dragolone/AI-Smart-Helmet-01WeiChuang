# 后端分支 / 语句覆盖补测发现（2026-10-16）

分支 `test/backend-coverage-1016`。只记补测过程中发现的问题，**没有改任何服务代码**（后端归 B 线审）；
对应测试只断言现状，并在测试名里写了编号，修好后把那条测试的期望改过来即可。

## BC1：(0,0) 「没定到位」哨兵只在 SOS 事件快照里挡了，轨迹表照收，SOS 回落最新轨迹点时又把 (0,0) 捡回来

- **现象**：`extractSosLocation` 把精确 (0,0) 当作「没定到位」的哨兵，按缺失处理、回落该设备最新轨迹点
  （注释：「否则事故地点会被钉在赤道上」）。但 `LocationRecorderService.record` 的值域校验不排除 (0,0)，
  这样的 `location_update` 照常进 `location_points`；`resolveSnapshot` 回落查最新轨迹点时也不排除 (0,0)。
  结果：头盔没定到位时连发的 (0,0) 位置点先进轨迹表，随后摔倒事件的位置也是 (0,0) → 快照回落到「最新轨迹点」= (0,0)，
  事故地点照样钉在几内亚湾；同理 `GET /devices/{id}/locations/latest` 也会把 (0,0) 当最新位置返回，App 地图跳到赤道。
- **复现**（单测，已提交，断言现状）：
  - `src/locations/location-recorder.service.spec.ts`「精确 (0,0)…现状：照常入轨迹表」
  - `src/sos/sos-trigger.branches.spec.ts`「事件位置是 (0,0) 被当缺失、回落的最新轨迹点也是 (0,0) 时，现状：快照仍钉在 (0,0)」
- **期望**：同一个哨兵在全链路同一口径——要么位置表不收 (0,0)，要么所有「取最新位置」的查询都跳过它。
- **代码位置**：`backend/src/locations/location-recorder.service.ts` `extractLocation`（约第 20–49 行）；
  `backend/src/sos/sos-trigger.service.ts` `resolveSnapshot`（约第 359–387 行）；`backend/src/locations/locations.service.ts` `latest`（约第 50–63 行）。
- **缓解因素**：蓝牙版 App 对「精度 0xFF」的无定位帧整帧不上传（EVENTS.md 4.2 speed 行），所以真机 BLE 链路目前不太会出现；
  4G / MQTT、Mock、Webhook 入口没有这层过滤；硬件「无定位时填什么」仍待答（DEVICE_PROTOCOL §10 B-8）。
- **建议修法**：在 `extractLocation` 里与 SOS 一样 `if (p.latitude === 0 && p.longitude === 0) return null`（raw 已留档，不丢证据），
  一处改动同时堵住快照回落、最新位置、轨迹三条路；若担心误杀真实 (0,0)，也可只在 `resolveSnapshot` / `latest` 的查询里加
  `NOT: { latitude: 0, longitude: 0 }`。改哪种需要 B 线定口径（涉及 EVENTS.md 4.2 值域说明）。

# 2026-10-16 App 覆盖率补测：发现记录

分支 `test/app-coverage-1016`。这一轮补的是 `src/components/**`、`src/app/**` 页面、`plugins/with-jpush.js`、
`src/api/*.ts` 的薄封装和开屏 `components/splash/**`；`src/services/**`、`src/hooks/**`、`src/i18n/**` 由另一个代理负责，
这里没碰它们的源码和测试。

保命链路（倒计时页 sos-active、推送、蓝牙、实时、上行队列）上的问题**只记录、不改**，编号 C1…；
非保命的小问题能修的已修（提交信息里写了现象 / 原因），没修的列在后面。

## 保命链路：只记录（C 编号）

### C1 倒计时页只认路由里的 deviceId（低）

- 位置：`app/src/app/sos-active.tsx`（`useLocalSearchParams` 取 `deviceId`；`sosApi.snapshot(sosId, deviceId)`；
  `needHelp` 第一行 `if (!deviceId) return;`）；`app/src/api/sos.ts` 的 `snapshot`。
- 现象：用只带 `sosId` 的链接打开倒计时页（例如外部深链 `lingyizhixing://sos-active?sosId=…`）时：
  1. 拉权威状态先请求 `/devices/undefined/sos/active`，服务端回 404（`DEVICE_NOT_FOUND`，见 backend 的 device-access），页面按「这一单不存在」收掉——即使这一单真的还在倒数；
  2. 已取消页上「我还是需要帮助」点了没反应（`needHelp` 直接返回）。
- 影响面：App 内所有入口（安全页、安全记录、事故详情、实时通道、推送、锁屏通知按钮）都会带上 `deviceId`，
  目前只有外部深链会走到这里，所以记为低。
- 原因：`deviceId` 只取路由参数。来源头盔那一行已经是 `sos?.deviceId ?? deviceId`，另外两处没有跟着改。
- 建议（交负责人 / B 线定）：`snapshot` 在没有 `deviceId` 时直接查 `/accidents/:sosId`；`needHelp` 改用 `sos?.deviceId ?? deviceId`。
- 测试：没有加断言（不把现状写死在测试里）。复现：`routerState.params = { sosId: "s1" }` 后渲染 `SosActiveScreen`。

## 非保命的小问题

### 已修

| 提交    | 现象                                                                                     | 原因                                                           |
| ------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| c4cf559 | 外观设置写入本机失败时，抛出一个没人接的 Promise 拒绝                                    | `theme-store.setMode` 里 `SecureStore.setItemAsync` 没有 catch |
| 340fa4b | 紧急联系人名字以扩展区汉字或表情开头时，头像是乱码方块                                   | 首字用 `slice(0, 1)` 按 UTF-16 码元取                          |
| c857f2a | 「我的」昵称删光后账号卡名字一栏空白、不再提示设置昵称，头像空白；表情开头的昵称头像乱码 | 清空后服务端存 `""`，页面用 `??` 判断；首字同上                |
| 81686a3 | 对讲房间和频道「更多」面板里，清空过昵称的成员名字空白；表情开头的昵称头像乱码           | 同上（`nickname ?? phone`、`slice(0, 1)`）                     |

### 没修，记一笔

- **N1 昵称空串**：`PATCH /users/me` 只能传字符串，清空昵称后服务端存的是 `""`。App 端「我的」页和对讲页已按「去空格后为空 = 没设」兜住，
  更彻底的办法是服务端把 `""` 存成 `null`（B 线）。
- **N2 语言设置落盘失败**：`i18n/locale-store.ts` 的 `setLocale` 和上面 theme-store 那条一样，`SecureStore.setItemAsync` 失败时会抛出没人接的拒绝。
  它在另一个代理负责的 `i18n` 目录里，这里没动。
- **N3 对讲页一处走不到的分支**：`leaveChannel` 里「在房间里、退的正是当前频道就先退房」那一支，现在走不到——「更多」面板只在频道列表里能打开，
  进房间后看不到。留着无害，只是说明一下覆盖率里那一支为什么是 0。

## 测试设施（给之后补测的人）

- `app/package.json` 的 jest 配置：`coveragePathIgnorePatterns` 不计 `__tests__/`；`moduleNameMapper` 把 `react` 指到 `app/node_modules/react`
  ——仓库根目录还装着一份不同版本的 React，不统一的话凡是带 hooks 的组件在 `react-test-renderer` 里都会报 Invalid hook call。
- `src/__tests__/helpers/native-mocks.tsx`：reanimated / worklets / Skia / 图标 / 安全区 / 手势 / expo-router 的替身，
  以及开屏用的「会反应」的 reanimated 替身（`reactiveReanimatedMock` + `pumpReactions` + `frameClock`：测试自己走帧，每帧后按值变化过一遍反应）。
- `src/__tests__/helpers/render.tsx`：渲染、取文字（透明度为 0 的不算）、按文字 / 读屏名点、QueryClient（不回收、不重试）、`waitFor`。
- 开屏的路线段、画布、表盘用电脑上那套真的 Skia（`canvaskit-wasm`）画出来读像素，不替换画布。
- 踩过的坑：
  - `act` 的回调返回 Promise（比如 `onPress` 返回 `void join()` 以外的异步函数）时 act 变成异步，必须 `await`，否则下一次 act 交叠；
  - 用同一个元素对象 `rerender` 时 React 会跳过重渲染，要传新的元素；
  - RN 的 `Animated.loop` 在 jest 里会同步无限循环，换成只记起停的假循环；
  - `AppState.addEventListener` 在 RN 的 jest 环境里本身就是 `jest.fn`，`spyOn(...).mockRestore()` 会把它原来的实现一起抹掉，要用 `mockImplementationOnce`；
  - 顶层的 worklet 函数在模块加载时就把 `Skia` 收进闭包：真的 Skia 要异步起，替身要交一个转发的 Proxy；
  - `jest.clearAllMocks()` 不清 `mockReturnValue` / `mockImplementation`，上一个用例改的实现会带到下一个；
  - 门控脚本的输出不要接管道（`| tail`），会吞掉失败的退出码。

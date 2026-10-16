// 对讲提示音（2026-10-07）：进出房间、有人进来、按下 / 松开说话、开麦关麦、掉线、重连、头盔断开。
// 骑行时不看屏幕，靠声音知道「现在别人听不听得到我」。
// 声音是程序生成的几段短音（services/cue-synth），第一次用到时写进缓存目录，交给 TRTC 的音效接口播放：
// 通话中的声音必须走 TRTC 自己的音频引擎——另起一个播放器会去改系统的音频会话，iOS 上可能把通话的
// 麦克风打断。只在本机播放（publish=false），队友听不到。
// 任何一步失败都只是没有提示音，绝不影响通话：所有调用都吞掉异常。
import { File, Paths } from "expo-file-system";
import TRTCCloud from "trtc-react-native";

import { synthWav, type Tone } from "@/services/cue-synth";

export type Cue =
  | "enter" // 进了房间
  | "leave" // 离开房间
  | "join" // 有人进来
  | "talkOn" // 按住说话：按下
  | "talkOff" // 按住说话：松开
  | "micOn" // 一直开麦：麦克风开了
  | "micOff" // 一直开麦：麦克风关了
  | "lost" // 掉线
  | "back" // 重新连上
  | "helmet"; // 头盔断开

type Sound = "up" | "down" | "blip" | "warn" | "tickOn" | "tickOff";

/** 上行 = 通了 / 开了，下行 = 关了，三声低音 = 出问题了；按住说话的两声要短，不能耽误开口 */
const SOUNDS: Record<Sound, { id: number; tones: Tone[] }> = {
  up: {
    id: 9101,
    tones: [
      { hz: 660, ms: 90 },
      { hz: 880, ms: 130 },
    ],
  },
  down: {
    id: 9102,
    tones: [
      { hz: 660, ms: 90 },
      { hz: 440, ms: 130 },
    ],
  },
  blip: { id: 9103, tones: [{ hz: 740, ms: 90 }] },
  warn: {
    id: 9104,
    tones: [
      { hz: 330, ms: 110, gapMs: 70 },
      { hz: 330, ms: 110, gapMs: 70 },
      { hz: 330, ms: 110 },
    ],
  },
  tickOn: { id: 9105, tones: [{ hz: 1040, ms: 45 }] },
  tickOff: { id: 9106, tones: [{ hz: 620, ms: 45 }] },
};

const CUE_SOUND: Record<Cue, Sound> = {
  enter: "up",
  back: "up",
  micOn: "up",
  leave: "down",
  micOff: "down",
  join: "blip",
  lost: "warn",
  helmet: "warn",
  talkOn: "tickOn",
  talkOff: "tickOff",
};

const cache: Partial<Record<Sound, { file: File; path: string }>> = {};

/** 这段声音的本地文件路径；没有就现做一个。做不出来返回 null */
function pathOf(sound: Sound): string | null {
  try {
    // 缓存目录会被系统或用户清掉：只认还在的文件，不在了就重写，否则直到重启 App 都没有提示音
    const cached = cache[sound];
    if (cached?.file.exists) return cached.path;
    const bytes = synthWav(SOUNDS[sound].tones);
    const file = new File(Paths.cache, `intercom-cue-${sound}.wav`);
    // 大小对不上 = 上个版本留下的旧声音，或者上次没写完
    if (!file.exists || file.size !== bytes.length) {
      file.create({ overwrite: true });
      file.write(bytes);
    }
    // TRTC 要的是绝对路径，不带 file:// 前缀
    const path = decodeURI(file.uri).replace(/^file:\/\//, "");
    cache[sound] = { file, path };
    return path;
  } catch {
    return null;
  }
}

/** 进房后先把几段声音备好，免得第一次按下说话时才去写文件 */
export function prepareCues(): void {
  for (const sound of Object.keys(SOUNDS) as Sound[]) pathOf(sound);
}

export function playCue(cue: Cue): void {
  try {
    const sound = CUE_SOUND[cue];
    const path = pathOf(sound);
    if (!path) return;
    TRTCCloud.sharedInstance()
      .getAudioEffectManager()
      .startPlayMusic({
        id: SOUNDS[sound].id,
        path,
        publish: false,
        isShortFile: true,
      })
      .catch(() => undefined);
  } catch {
    // 没有提示音不影响通话
  }
}

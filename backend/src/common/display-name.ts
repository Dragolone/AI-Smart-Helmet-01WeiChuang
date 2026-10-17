/**
 * 名字里看不见的字符：控制符（换行、制表另按空白处理）、软连字符、零宽空格 / 零宽不连字、方向标记与嵌入、
 * 字连接符与不可见运算符、BOM、韩文填充符这类专门用来「起空白名」的字符。
 * 零宽连接符（U+200D）和变体选择符（U+FE00–FE0F）不在这里：表情组合（👨‍💻、❤️）要靠它们，下面单独处理。
 */
const INVISIBLE_IN_NAME =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class -- 就是要逐个去掉控制符和组合用的不可见字符
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]/g;

/**
 * BMP 以外同样看不见、能拼出「空白名」的字符（10-17 第二轮评审 r1）：标签字符 U+E0000–E007F 及其后未分配的
 * 默认可忽略码位、乐谱格式符 U+1D173–1D17A、速记格式符 U+1BCA0–1BCA3。
 * 例外：黑旗 U+1F3F4 + 标签字符 + 结束符 U+E007F 是英格兰 / 苏格兰 / 威尔士旗，整段保留（第一个分组）。
 * 补充变体选择符 U+E0100–E01EF（日文异体字用）与 FE00–FE0F 同样处理：跟在可见字符后保留，落单的去掉。
 */
const INVISIBLE_ASTRAL =
  /(\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F})|[\u{E0000}-\u{E00FF}\u{E01F0}-\u{E0FFF}\u{1D173}-\u{1D17A}\u{1BCA0}-\u{1BCA3}]/gu;

/**
 * 用户起的名字（昵称 / 头盔名 / 联系人名 / 频道名）整理成一行能显示的样子：去掉看不见的字符，
 * 换行、制表等连续空白压成一个空格，去掉首尾空白。与 App `cleanHelmetName`（app/src/services/safety-status.ts）同一规则。
 * 入库前整理：只含零宽字符 / 带换行的名字原来照收，推送正文、Admin、对讲成员表里是空白或断行（10-16 夜测 N1 / N6）。
 */
export function cleanDisplayName(raw: string): string {
  return (
    raw
      .replace(INVISIBLE_IN_NAME, '')
      .replace(INVISIBLE_ASTRAL, (_m, flag?: string) => flag ?? '')
      // 盲文空白（U+2800）显示出来也是空白，和空格同等对待
      .replace(/[\s\u2800]+/g, ' ')
      // 零宽连接符 / 变体选择符只有跟在可见字符后面才有用：落在开头或空格后面的去掉，连接符落在结尾或空格前面的也去掉
      // eslint-disable-next-line no-misleading-character-class -- 匹配的就是落单的连接符 / 变体选择符
      .replace(/(^|\s)[\u200D\uFE00-\uFE0F\u{E0100}-\u{E01EF}]+/gu, '$1')
      .replace(/\u200D+(?=\s|$)/g, '')
      // 去掉连接符后两边的空格会挨在一起
      .replace(/ {2,}/g, ' ')
      .trim()
  );
}

/** class-transformer 用：字符串先整理再交给长度校验；非字符串原样留给 @IsString 去拒 */
export const cleanName = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? cleanDisplayName(value) : value;

/** 同上，整理完是空串就当没起（昵称：null，下游回落脱敏手机号） */
export const cleanNameOrNull = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? cleanDisplayName(value) || null : value;

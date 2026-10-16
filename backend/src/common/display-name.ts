/**
 * 名字里看不见的字符：控制符（换行、制表另按空白处理）、软连字符、零宽空格 / 零宽不连字、方向标记与嵌入、
 * 字连接符与不可见运算符、BOM、韩文填充符这类专门用来「起空白名」的字符。
 * 零宽连接符（U+200D）和变体选择符（U+FE00–FE0F）不在这里：表情组合（👨‍💻、❤️）要靠它们，下面单独处理。
 */
const INVISIBLE_IN_NAME =
  // eslint-disable-next-line no-control-regex, no-misleading-character-class -- 就是要逐个去掉控制符和组合用的不可见字符
  /[\u0000-\u0008\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0\uFFF9-\uFFFB]/g;

/**
 * 用户起的名字（昵称 / 头盔名 / 联系人名 / 频道名）整理成一行能显示的样子：去掉看不见的字符，
 * 换行、制表等连续空白压成一个空格，去掉首尾空白。与 App `cleanHelmetName`（app/src/services/safety-status.ts）同一规则。
 * 入库前整理：只含零宽字符 / 带换行的名字原来照收，推送正文、Admin、对讲成员表里是空白或断行（10-16 夜测 N1 / N6）。
 */
export function cleanDisplayName(raw: string): string {
  return (
    raw
      .replace(INVISIBLE_IN_NAME, '')
      // 盲文空白（U+2800）显示出来也是空白，和空格同等对待
      .replace(/[\s\u2800]+/g, ' ')
      // 零宽连接符 / 变体选择符只有跟在可见字符后面才有用：落在开头或空格后面的去掉，连接符落在结尾或空格前面的也去掉
      // eslint-disable-next-line no-misleading-character-class -- 匹配的就是落单的连接符 / 变体选择符
      .replace(/(^|\s)[\u200D\uFE00-\uFE0F]+/g, '$1')
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

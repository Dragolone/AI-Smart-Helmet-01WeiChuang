import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PrismaService } from '../prisma/prisma.service';
import { EmqxHookService } from './emqx-hook.service';

// emqx/acl-fallback.conf 是后端 authorize 的 EMQX 本地副本，只在授权回调不可达时生效。
// 两边一旦不一致，后端重启那一分钟里的放行范围就和平时不同——这里按同一组输入对比两边的判定。
const ROOT = join(__dirname, '../../..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

const PLACEHOLDER = '${username}';
const RULE =
  /^\{allow, \{username, \{re, "([^"]+)"\}\}, (publish|subscribe), \[(.*)\]\}\.$/;

interface AclRule {
  usernameRe: RegExp;
  action: string;
  topics: string[];
}

function parseRules(): AclRule[] {
  return read('emqx/acl-fallback.conf')
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => {
      const m = RULE.exec(line);
      if (!m) throw new Error(`acl-fallback.conf 出现无法识别的规则：${line}`);
      return {
        usernameRe: new RegExp(m[1]),
        action: m[2],
        topics: [...m[3].matchAll(/"([^"]+)"/g)].map((t) => t[1]),
      };
    });
}

/** EMQX file 源对单条请求的判定：命中任一 allow 规则即放行，否则落到 no_match = deny */
function aclAllows(
  rules: AclRule[],
  username: string,
  topic: string,
  action: string,
): boolean {
  return rules.some(
    (r) =>
      r.action === action &&
      r.usernameRe.test(username) &&
      r.topics.some((t) => t.split(PLACEHOLDER).join(username) === topic),
  );
}

describe('emqx/acl-fallback.conf 与后端 authorize 一致', () => {
  const rules = parseRules();
  const hook = new EmqxHookService({} as PrismaService);
  const backendAllows = (u: string, t: string, a: string): boolean =>
    hook.authorize(u, t, a).result === 'allow';

  it('只有 publish / subscribe 两条 allow 规则，topic 都按 username 隔离', () => {
    expect(rules.map((r) => r.action).sort()).toEqual(['publish', 'subscribe']);
    for (const r of rules) {
      for (const t of r.topics)
        expect(t.startsWith(`helmet/${PLACEHOLDER}/`)).toBe(true);
    }
  });

  const devices = ['helmet_001', 'helmet_b3f8c2', 'Helmet-A_9'];
  const leaves = [
    'status',
    'location',
    'event',
    'cmd_ack',
    'cmd',
    'debug',
    '+',
    '#',
  ];
  const cases: [string, string, string][] = [];
  for (const u of devices) {
    for (const owner of [u, 'helmet_other', '+', '#']) {
      for (const leaf of leaves) {
        for (const action of ['publish', 'subscribe']) {
          cases.push([u, `helmet/${owner}/${leaf}`, action]);
        }
      }
    }
    for (const action of ['publish', 'subscribe']) {
      cases.push([u, `helmet/${u}/event/extra`, action]);
      cases.push([u, `helmet/${u}`, action]);
      cases.push([u, `other/${u}/event`, action]);
      cases.push([u, '#', action]);
    }
  }

  it.each(cases)('%s %s %s：两边判定相同', (username, topic, action) => {
    expect(aclAllows(rules, username, topic, action)).toBe(
      backendAllows(username, topic, action),
    );
  });

  it('用户名含通配符 / 分隔符时规则不生效，不能借占位符变成通配', () => {
    for (const u of ['+', '#', 'a/b', 'helmet_001/+', '']) {
      for (const leaf of ['status', 'event', 'cmd']) {
        for (const action of ['publish', 'subscribe']) {
          expect(aclAllows(rules, u, `helmet/${u}/${leaf}`, action)).toBe(
            false,
          );
          expect(aclAllows(rules, u, `helmet/helmet_001/${leaf}`, action)).toBe(
            false,
          );
        }
      }
    }
  });

  it('本地与云端 EMQX 配置都把它挂成授权的第二个源，compose 都挂载了文件', () => {
    const source = 'path = "/opt/emqx/etc/acl-fallback.conf"';
    for (const conf of ['emqx/emqx.conf', 'deploy/emqx.prod.conf.template']) {
      const text = read(conf);
      const http = text.indexOf('/internal/emqx/authorize');
      expect(http).toBeGreaterThan(-1);
      expect(text.indexOf(source)).toBeGreaterThan(http);
    }
    expect(read('docker-compose.yml')).toContain(
      './emqx/acl-fallback.conf:/opt/emqx/etc/acl-fallback.conf:ro',
    );
    expect(read('deploy/docker-compose.prod.yml')).toContain(
      '../emqx/acl-fallback.conf:/opt/emqx/etc/acl-fallback.conf:ro',
    );
  });
});

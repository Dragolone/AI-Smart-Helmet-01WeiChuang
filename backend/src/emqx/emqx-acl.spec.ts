import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import type { PrismaService } from '../prisma/prisma.service';
import { EmqxHookService, deviceAcl } from './emqx-hook.service';

// 设备权限随认证应答下发（EMQX HTTP 认证的 acl 字段），EMQX 不再回调 authorize。
// 这里钉住两件事：下发的 ACL 与 §4 规则（authorize 的判定）逐条一致；EMQX 配置里没有再按 username 判权限的源。
const ROOT = join(__dirname, '../../..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

/** EMQX 用随认证下发的 ACL 判一条请求：规则 topic 不含通配，按全等匹配 */
function aclAllows(deviceId: string, topic: string, action: string): boolean {
  return deviceAcl(deviceId).some(
    (r) => r.action === action && r.topic === topic,
  );
}

describe('随认证下发的设备 ACL', () => {
  const hook = new EmqxHookService({} as PrismaService);

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

  it.each(cases)(
    '%s %s %s：与 §4 规则（authorize）判定相同',
    (u, topic, action) => {
      expect(aclAllows(u, topic, action)).toBe(
        hook.authorize(u, topic, action).result === 'allow',
      );
    },
  );

  it('规则都是本设备的具体 Topic，不含通配符', () => {
    for (const r of deviceAcl('helmet_001')) {
      expect(r.topic.startsWith('helmet/helmet_001/')).toBe(true);
      expect(r.topic).not.toMatch(/[+#]/);
    }
  });

  it('设备号带通配符 / 层级分隔符：认证直接拒，不查库、不下发会变成通配的 ACL', async () => {
    const findUnique = jest.fn().mockResolvedValue({
      deviceSecretHash: createHash('sha256').update('s').digest('hex'),
    });
    const svc = new EmqxHookService({
      device: { findUnique },
    } as unknown as PrismaService);
    for (const id of [
      '+',
      '#',
      'helmet/+',
      'a/b',
      'helmet_001#',
      'x'.repeat(65),
    ]) {
      await expect(svc.authenticate(id, 's', id)).resolves.toEqual({
        result: 'deny',
      });
    }
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('本地与云端 EMQX 配置：不配授权源、被拒即断开，不再回调后端 authorize（它分不出没过认证的连接）', () => {
    for (const conf of ['emqx/emqx.conf', 'deploy/emqx.prod.conf.template']) {
      const text = read(conf);
      const authz = text.slice(text.indexOf('authorization {'));
      expect(authz).toMatch(/\n\s*sources = \[\]\n/);
      expect(authz).toMatch(/\n\s*deny_action = disconnect\n/);
      expect(authz).toMatch(/\n\s*no_match = deny\n/);
      expect(text).not.toContain('/internal/emqx/authorize');
      expect(text).toContain('/internal/emqx/authenticate');
    }
  });
});

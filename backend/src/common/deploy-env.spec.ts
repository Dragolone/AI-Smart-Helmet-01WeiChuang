import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const deployDir = join(__dirname, '../../../deploy');

/**
 * deploy/.env.example 里写出来的每个键（含注释掉的选填项）都必须在 docker-compose.prod.yml 里被引用。
 * backend 容器拿不到 deploy/.env 本身（.dockerignore 排除），只认 compose environment 显式透传的变量；
 * 漏一项就是「文档说填了就生效、实际改了没用」——REQUIRE_REAL_PROVIDERS 与 JPUSH_THIRD_PARTY_CHANNEL
 * 都这样漏过（2026-10-14）。
 */
describe('deploy/.env.example ↔ docker-compose.prod.yml', () => {
  // compose 自己读、不进任何容器的键
  const COMPOSE_ONLY = new Set(['COMPOSE_PROFILES']);

  it('.env.example 的每个键都被 compose 引用', () => {
    const example = readFileSync(join(deployDir, '.env.example'), 'utf-8');
    const compose = readFileSync(
      join(deployDir, 'docker-compose.prod.yml'),
      'utf-8',
    );
    const keys = [...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map(
      (m) => m[1],
    );
    expect(keys.length).toBeGreaterThan(20);
    const missing = [...new Set(keys)].filter(
      (key) => !COMPOSE_ONLY.has(key) && !compose.includes(`\${${key}`),
    );
    expect(missing).toEqual([]);
  });
});

"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const node_crypto_1 = require("node:crypto");
const adapter_pg_1 = require("@prisma/adapter-pg");
const client_1 = require("../src/generated/prisma/client");
async function main() {
    const deviceId = process.argv[2] ?? `helmet_${(0, node_crypto_1.randomBytes)(3).toString('hex')}`;
    const deviceSecret = (0, node_crypto_1.randomBytes)(24).toString('base64url');
    const bindCode = String((0, node_crypto_1.randomInt)(10_000_000, 100_000_000));
    const prisma = new client_1.PrismaClient({
        adapter: new adapter_pg_1.PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
    await prisma.device.create({
        data: {
            deviceId,
            deviceSecretHash: (0, node_crypto_1.createHash)('sha256').update(deviceSecret).digest('hex'),
            bindCode,
        },
    });
    await prisma.$disconnect();
    console.log('设备开通成功（deviceSecret 只显示这一次，立即保存）：');
    console.log(`  DEVICE_ID     = ${deviceId}`);
    console.log(`  DEVICE_SECRET = ${deviceSecret}`);
    console.log(`  BIND_CODE     = ${bindCode}`);
    console.log(`\nMock 设备启动：DEVICE_ID=${deviceId} DEVICE_SECRET=${deviceSecret} npm run start -w mock-device`);
}
main().catch((err) => {
    console.error('开通失败：', err instanceof Error ? err.message : err);
    process.exit(1);
});
//# sourceMappingURL=provision-device.js.map
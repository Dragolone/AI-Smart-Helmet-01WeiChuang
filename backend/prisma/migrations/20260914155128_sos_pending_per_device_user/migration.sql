-- 决策 #40（2026-09-15）：SOS 并发合并规则改为按「设备 + 用户」判定。
-- 原约束「每设备至多一个进行中 SOS」会让换绑后新用户的摔倒/求救被并入前用户的单（审计 SOS-03）；
-- 现改为「每设备每用户至多一个进行中 SOS」：旧用户的单不受换绑影响（口径「解绑不影响处置权」保持），
-- 新用户的事件另建新单。Prisma schema 不支持 partial index，手写于此。
DROP INDEX IF EXISTS "sos_cases_one_pending_per_device";
CREATE UNIQUE INDEX "sos_cases_one_pending_per_device_user" ON "sos_cases"("device_id", "user_id") WHERE "status" = 'pending';

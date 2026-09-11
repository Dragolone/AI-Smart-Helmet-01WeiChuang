-- CreateTable
CREATE TABLE "device_bindings" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "bound_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unbound_at" TIMESTAMP(3),

    CONSTRAINT "device_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_bindings_device_id_user_id_bound_at_idx" ON "device_bindings"("device_id", "user_id", "bound_at");

-- 回填：现有绑定关系各开一段进行中的历史（bound_at 缺失时以设备创建时间兜底）
INSERT INTO "device_bindings" ("id", "device_id", "user_id", "bound_at")
SELECT 'bnd_' || "device_id", "device_id", "bind_user_id", COALESCE("bound_at", "created_at")
FROM "devices"
WHERE "bind_user_id" IS NOT NULL;

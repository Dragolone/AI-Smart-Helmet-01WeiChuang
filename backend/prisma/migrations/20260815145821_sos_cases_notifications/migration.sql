-- CreateTable
CREATE TABLE "sos_cases" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "trigger_event_id" TEXT NOT NULL,
    "trigger_type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "deadline" TIMESTAMP(3) NOT NULL,
    "finalized_at" TIMESTAMP(3),
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "coordinate_system" TEXT,
    "accuracy" DOUBLE PRECISION,
    "location_source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sos_cases_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sos_notifications" (
    "id" TEXT NOT NULL,
    "sos_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "contact_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sos_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sos_cases_trigger_event_id_key" ON "sos_cases"("trigger_event_id");

-- CreateIndex
CREATE INDEX "sos_cases_device_id_created_at_idx" ON "sos_cases"("device_id", "created_at");

-- CreateIndex
CREATE INDEX "sos_cases_status_deadline_idx" ON "sos_cases"("status", "deadline");

-- CreateIndex
CREATE INDEX "sos_notifications_sos_id_idx" ON "sos_notifications"("sos_id");

-- CreateIndex
CREATE INDEX "sos_notifications_status_idx" ON "sos_notifications"("status");

-- AddForeignKey
ALTER TABLE "sos_notifications" ADD CONSTRAINT "sos_notifications_sos_id_fkey" FOREIGN KEY ("sos_id") REFERENCES "sos_cases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 每设备至多一个进行中 SOS（并发触发兜底，配合应用层合并规则；Prisma schema 不支持 partial index，手写于此）
CREATE UNIQUE INDEX "sos_cases_one_pending_per_device" ON "sos_cases"("device_id") WHERE "status" = 'pending';

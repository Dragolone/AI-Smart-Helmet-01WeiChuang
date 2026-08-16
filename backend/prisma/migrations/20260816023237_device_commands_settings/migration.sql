-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "settings" JSONB;

-- CreateTable
CREATE TABLE "device_commands" (
    "id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "params" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "issued_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "issued_by" TEXT,
    "delivered_at" TIMESTAMP(3),
    "ack_result" TEXT,
    "error_code" TEXT,
    "executed_at" TIMESTAMP(3),
    "acked_at" TIMESTAMP(3),

    CONSTRAINT "device_commands_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "device_commands_device_id_issued_at_idx" ON "device_commands"("device_id", "issued_at");

-- CreateIndex
CREATE INDEX "device_commands_status_issued_at_idx" ON "device_commands"("status", "issued_at");

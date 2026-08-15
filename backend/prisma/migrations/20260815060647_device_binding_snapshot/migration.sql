-- AlterTable
ALTER TABLE "devices" ADD COLUMN     "bind_code" TEXT,
ADD COLUMN     "bound_at" TIMESTAMP(3),
ADD COLUMN     "charging" BOOLEAN,
ADD COLUMN     "signal_level" INTEGER,
ADD COLUMN     "sleeping" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE UNIQUE INDEX "devices_bind_code_key" ON "devices"("bind_code");


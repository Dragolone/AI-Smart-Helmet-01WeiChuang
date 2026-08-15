-- CreateTable
CREATE TABLE "location_points" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "coordinate_system" TEXT NOT NULL,
    "accuracy" DOUBLE PRECISION NOT NULL,
    "speed" DOUBLE PRECISION NOT NULL,
    "heading" DOUBLE PRECISION NOT NULL,
    "altitude" DOUBLE PRECISION,

    CONSTRAINT "location_points_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "location_points_event_id_key" ON "location_points"("event_id");

-- CreateIndex
CREATE INDEX "location_points_device_id_timestamp_idx" ON "location_points"("device_id", "timestamp");

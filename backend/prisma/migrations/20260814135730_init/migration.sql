-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "nickname" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "device_id" TEXT NOT NULL,
    "device_secret_hash" TEXT NOT NULL,
    "bind_user_id" TEXT,
    "last_seen_at" TIMESTAMP(3),
    "battery" INTEGER,
    "firmware_version" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "raw_events" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "schema_version" INTEGER NOT NULL,
    "firmware_version" TEXT,
    "payload" JSONB NOT NULL,

    CONSTRAINT "raw_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "raw_events_event_id_key" ON "raw_events"("event_id");

-- CreateIndex
CREATE INDEX "raw_events_device_id_timestamp_idx" ON "raw_events"("device_id", "timestamp");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_bind_user_id_fkey" FOREIGN KEY ("bind_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "media" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "device_id" TEXT NOT NULL,
    "video_id" TEXT NOT NULL,
    "related_event_id" TEXT,
    "duration" INTEGER,
    "size_bytes" INTEGER,
    "storage_key" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ready',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "media_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "media_event_id_key" ON "media"("event_id");

-- CreateIndex
CREATE INDEX "media_related_event_id_idx" ON "media"("related_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "media_device_id_video_id_key" ON "media"("device_id", "video_id");

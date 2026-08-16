-- CreateTable
CREATE TABLE "voice_channels" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "room_id" SERIAL NOT NULL,
    "invite_code" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "voice_channel_members" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voice_channel_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "voice_channels_room_id_key" ON "voice_channels"("room_id");

-- CreateIndex
CREATE UNIQUE INDEX "voice_channels_invite_code_key" ON "voice_channels"("invite_code");

-- CreateIndex
CREATE INDEX "voice_channel_members_user_id_idx" ON "voice_channel_members"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "voice_channel_members_channel_id_user_id_key" ON "voice_channel_members"("channel_id", "user_id");

-- AddForeignKey
ALTER TABLE "voice_channel_members" ADD CONSTRAINT "voice_channel_members_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "voice_channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

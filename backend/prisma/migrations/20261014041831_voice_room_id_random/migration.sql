-- 对讲房间号改为服务端随机生成（决策 #56，2026-10-14）：去掉自增默认值与序列。已有频道的房间号保留
ALTER TABLE "voice_channels" ALTER COLUMN "room_id" DROP DEFAULT;
DROP SEQUENCE IF EXISTS "voice_channels_room_id_seq";

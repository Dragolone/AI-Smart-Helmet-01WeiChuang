-- AlterTable
ALTER TABLE "raw_events" ADD COLUMN     "clock_skew" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'mqtt';

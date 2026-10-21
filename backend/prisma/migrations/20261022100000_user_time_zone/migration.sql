-- 用户手机时区（O13，2026-10-22）：App 每个请求带 X-Client-Timezone（IANA 名），守卫在值变化时写进来；
-- 推送正文的时间按它写当地时间，没有时写明「北京时间」。只加可空列，不回填，瞬间完成。
ALTER TABLE "users" ADD COLUMN "time_zone" TEXT;

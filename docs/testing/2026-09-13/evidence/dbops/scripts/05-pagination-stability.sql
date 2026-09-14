-- 分页排序稳定性：§5 orderBy 仅 timestamp（无唯一 tiebreaker）。300 个点共用同一 timestamp（now-12h）。
-- 分别在「索引扫描」与「强制排序」两种执行计划下取同一页，比较 id 集合是否一致。
\set dev '''perf_helmet_0001'''
SELECT count(*) AS rows_before_tie FROM location_points WHERE device_id=:dev AND "timestamp" < (SELECT "timestamp" FROM location_points WHERE id='perf_lp_1000') \gset
\echo rows_before_tie = :rows_before_tie
CREATE TEMP TABLE page_a AS
SELECT row_number() over () AS rn, id FROM (SELECT id FROM location_points WHERE device_id=:dev AND "timestamp">=now()-interval '24 hours' AND "timestamp"<=now() ORDER BY "timestamp" ASC LIMIT 100 OFFSET :rows_before_tie) s;
SET enable_indexscan=off; SET enable_indexonlyscan=off; SET enable_bitmapscan=off;
CREATE TEMP TABLE page_b AS
SELECT row_number() over () AS rn, id FROM (SELECT id FROM location_points WHERE device_id=:dev AND "timestamp">=now()-interval '24 hours' AND "timestamp"<=now() ORDER BY "timestamp" ASC LIMIT 100 OFFSET :rows_before_tie) s;
RESET enable_indexscan; RESET enable_indexonlyscan; RESET enable_bitmapscan;
\echo '--- 同一页在两种计划下 id 集合差异（行数>0 即分页不稳定：换计划/换 offset 会漏行或重复）'
SELECT (SELECT count(*) FROM page_a) AS page_a_rows, (SELECT count(*) FROM (SELECT id FROM page_a EXCEPT SELECT id FROM page_b) x) AS only_in_a, (SELECT count(*) FROM (SELECT id FROM page_b EXCEPT SELECT id FROM page_a) x) AS only_in_b, (SELECT count(*) FROM page_a a JOIN page_b b USING(rn) WHERE a.id<>b.id) AS same_position_diff_id;
\echo '--- 前 5 行对比'
SELECT a.rn, a.id AS index_plan_id, b.id AS sort_plan_id FROM page_a a JOIN page_b b USING(rn) ORDER BY rn LIMIT 5;
\echo '--- 翻页一致性（索引计划）：同一 ORDER BY 下相邻两页 (OFFSET n, n+100) 是否有交集/漏行——用 3 页覆盖 300 个并列行'
WITH p AS (
  SELECT id FROM location_points WHERE device_id=:dev AND "timestamp">=now()-interval '24 hours' AND "timestamp"<=now() ORDER BY "timestamp" ASC LIMIT 300 OFFSET :rows_before_tie
) SELECT count(*) AS fetched, count(DISTINCT id) AS distinct_ids, count(*) FILTER (WHERE id ~ '^perf_lp_[0-9]+000$') AS tie_rows FROM p;

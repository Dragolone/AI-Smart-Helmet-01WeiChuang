#!/bin/zsh
# 一键复跑本轮全部后端审计套件（按领域分库，避免相互干扰）。
# 预期：部分用例失败——那是刻意保留的缺陷断言（见 BUGS.md）；修复后应转绿。
EV=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang/docs/testing/2026-09-13/evidence
run() { echo "\n##### $1"; $EV/run-audit-suite.sh "$@" 2>&1 | grep -E "^(PASS|FAIL|Tests:|Test Suites:)"; }
run sos    audit-sos audit-sos-faults
run sos    audit-sos-realtime
run auth   audit-auth-account audit-auth-authz audit-auth-binding audit-auth-extra
run auth   audit-auth-ratelimit
run ingest audit-ingest-entries audit-realtime audit-commands
run mqtt   audit-mqtt-hook
run admin  audit-admin
run dbops  audit-dbops
run v2     audit-contract
run voice  audit-voice audit-voice-defects audit-media audit-media-defects

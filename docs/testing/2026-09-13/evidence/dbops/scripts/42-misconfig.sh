#!/bin/zsh
source ~/.nvm/nvm.sh >/dev/null 2>&1; nvm use 24 >/dev/null 2>&1
R=/Users/dravenzhong/Desktop/AI-Smart-Helmet-01WeiChuang
SP=/private/tmp/claude-501/-Users-dravenzhong-Desktop-AI-Smart-Helmet-01WeiChuang/f23220c2-7807-4477-a125-d5f13c84ad94/scratchpad
cd $R/backend; set -a; source $SP/audit.env; set +a
export MQTT_URL=mqtt://127.0.0.1:51899 PORT=3502
probe() { # $1=label  其余=env 覆盖前缀
  echo "--- $1"
  ( "${@:2}" node dist/main > /tmp/audit-mis.log 2>&1 ) & P=$!
  for i in $(seq 1 24); do
    kill -0 $P 2>/dev/null || break
    curl -sf http://127.0.0.1:3502/api/v1/health >/dev/null 2>&1 && break
    sleep 0.5
  done
  if kill -0 $P 2>/dev/null; then
    H=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3502/api/v1/health)
    echo "进程存活；/health=$H"
    if [ "$H" = "200" ] && [ -n "$3" ]; then :; fi
    L=$(curl -s -o /dev/null -w "%{http_code}" -X POST http://127.0.0.1:3502/api/v1/auth/login -H 'content-type: application/json' -d '{"phone":"19900000000","password":"whatever1"}')
    echo "  /auth/login 返回 $L"
    kill -9 $P 2>/dev/null; wait $P 2>/dev/null
  else
    wait $P; echo "进程已退出 exit=$?"
  fi
  echo "  日志关键行：$(grep -iE 'error|secret|P1001|unreachable|Can.t reach' /tmp/audit-mis.log | head -2 | cut -c1-200)"
}
echo "### B. DATABASE_URL 指向无监听端口"
probe "DATABASE_URL=…:55499" env DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55499/helmet_audit_dbops
echo; echo "### C. 缺 JWT_SECRET"
probe "unset JWT_SECRET" env -u JWT_SECRET DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/helmet_audit_dbops
echo; echo "### E. ADMIN_JWT_SECRET == JWT_SECRET（deploy/.env.example 要求两值不同）"
probe "same secrets" env ADMIN_JWT_SECRET=audit0913_user_jwt_secret_not_for_prod DATABASE_URL=postgresql://audit:audit_0913@127.0.0.1:55432/helmet_audit_dbops
echo; echo "### F. 缺 DATABASE_URL"
probe "unset DATABASE_URL" env -u DATABASE_URL

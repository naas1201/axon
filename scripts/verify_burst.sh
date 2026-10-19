#!/bin/bash
set -u
HOST=axon.va-n.com
IP=188.114.97.2
C=(curl -sS -m 40 --resolve "$HOST:443:$IP")
# warm the isolate
for i in 1 2 3; do "${C[@]}" -o /dev/null -X POST "https://$HOST/api/v1/execute" -H 'content-type: application/json' --data-binary '{"code":"return 1"}'; done
echo "--- 25 parallel, attempt 2"
seq 1 25 | xargs -P 25 -I{} "${C[@]}" -o /dev/null -w "%{http_code}\n" -X POST "https://$HOST/api/v1/execute" -H 'content-type: application/json' --data-binary '{"code":"return 1"}' | sort | uniq -c
sleep 2
echo "--- 40 parallel"
seq 1 40 | xargs -P 40 -I{} "${C[@]}" -o /dev/null -w "%{http_code}\n" -X POST "https://$HOST/api/v1/execute" -H 'content-type: application/json' --data-binary '{"code":"return 1"}' | sort | uniq -c
sleep 1
"${C[@]}" -o /dev/null -w "health %{http_code}\n" "https://$HOST/health"

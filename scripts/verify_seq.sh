#!/bin/bash
set -u
HOST=axon.va-n.com
IP=188.114.97.2
C=(curl -sS -m 20 --resolve "$HOST:443:$IP")
echo "--- 16 sequential, no delay"
for i in $(seq 1 16); do
  "${C[@]}" -o /dev/null -w "%{http_code} " -X POST "https://$HOST/api/v1/execute" -H 'content-type: application/json' --data-binary '{"code":"return 1"}'
done
echo
echo "--- retry-after on the next request"
"${C[@]}" -D /tmp/h.txt -o /tmp/b.json -X POST "https://$HOST/api/v1/execute" -H 'content-type: application/json' --data-binary '{"code":"return 1"}' -w "http=%{http_code}\n"
grep -i "retry-after" /tmp/h.txt || true
head -c 200 /tmp/b.json
echo

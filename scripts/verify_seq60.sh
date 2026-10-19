#!/bin/bash
set -u
HOST=axon.va-n.com
IP=188.114.97.2
C=(curl -sS -m 20 --resolve "$HOST:443:$IP")
echo "--- 60 sequential"
for i in $(seq 1 60); do
  "${C[@]}" -o /dev/null -w "%{http_code}\n" -X POST "https://$HOST/api/v1/execute" -H 'content-type: application/json' --data-binary '{"code":"return 1"}'
done | sort | uniq -c

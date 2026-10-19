#!/bin/bash
# Gate verification against the custom domain. The sandbox resolver still has a
# negative cache from before the certificate was validated, so --resolve pins
# the edge IP that public DNS (Google/Cloudflare DoH) returns for the A record.
set -u
HOST=axon.va-n.com
IP=188.114.97.2
BASE="https://$HOST"
C=(curl -sS -m 40 --resolve "$HOST:443:$IP")

post() {
  local name="$1" body="$2"
  local out status
  out=$("${C[@]}" -o /tmp/v.json -w "%{http_code}" -X POST "$BASE/api/v1/execute" -H 'content-type: application/json' --data-binary "$body")
  echo "### $name http=$out"
  head -c 320 /tmp/v.json
  echo
  sleep 0.9
}

post math '{"code":"return 2+2"}'
post regex '{"code":"const s=\"ABC-142 ABC-157\"; return [...s.matchAll(/[A-Z]{3}-\\d+/g)].map(m=>m[0])"}'
post lodash '{"code":"import _ from \"lodash\"; export default _.chunk([1,2,3,4,5],2)"}'
post timeout '{"code":"while(true){}","timeout_ms":300}'
post oom '{"code":"return new Uint8Array(512*1024*1024).length"}'
post bogus '{"code":"import x from \"nope-xyz-404\"; export default x"}'
post nodefs '{"code":"import fs from \"node:fs\"; export default fs"}'
post badtype '{"code":123}'
post empty ''

for path in / /docs /faq /about /license /credits /health /robots.txt /sitemap.xml /og.svg /favicon.svg /assets/site.css /api/v1/meta /api/v1/examples; do
  code=$("${C[@]}" -o /dev/null -w "%{http_code}" "$BASE$path")
  echo "route $path $code"
done

code=$("${C[@]}" -o /dev/null -w "%{http_code}" -X GET "$BASE/api/v1/execute")
echo "GET execute $code"

code=$("${C[@]}" -o /dev/null -w "%{http_code}" -X OPTIONS "$BASE/api/v1/execute")
echo "OPTIONS $code"

code=$("${C[@]}" -o /tmp/v404.html -w "%{http_code}" "$BASE/no-such-page")
echo "404 $code $(grep -c 'in the sandbox' /tmp/v404.html)"

echo "--- 25 parallel"
seq 1 25 | xargs -P 25 -I{} "${C[@]}" -o /dev/null -w "%{http_code}\n" -X POST "$BASE/api/v1/execute" -H 'content-type: application/json' --data-binary '{"code":"return 1"}' | sort | uniq -c

sleep 1
code=$("${C[@]}" -o /dev/null -w "%{http_code}" "$BASE/health")
echo "health after burst $code"

# Security policy

## Reporting

Email <qmpro@outlook.com> with a description, a proof of concept and the request id if you have one.
Please do not open a public issue for a vulnerability. Expect an initial answer within a few days.

## What is in scope

- The Worker at `https://axon.va-n.com`, including the API and the static site.
- The source in this repository.

## What is out of scope

- Cloudflare's platform itself. Report those to Cloudflare.
- esm.sh and the npm packages it serves. Report those upstream.
- Denial of service through volume. The rate limiter is documented as per-colo and best effort.
- Reports that require access to a secret, an account or a private system that we do not have.

## Design promises worth testing

- No state crosses requests. Two calls cannot observe each other.
- No network, filesystem, process or environment access from inside the sandbox.
- No Node builtin resolves.
- The timeout and memory ceilings are enforced by the runtime, not by a cooperative check.
- Errors never contain stack traces, wasm addresses or environment values.
- Request bodies are not logged or stored.

If you break one of those, it is a real finding and we want it.

## Safe harbour

Good faith research against the hosted endpoint, within the limits above, is welcome. Do not attack
third parties, do not exfiltrate data, and keep volumes small enough that the service stays up for
everyone else.

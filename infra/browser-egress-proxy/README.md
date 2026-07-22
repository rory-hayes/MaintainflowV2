# Maintain Flow browser-egress proxy

This directory contains the security boundary selected in
`docs/business-evals/BROWSER_EGRESS_PROXY_IMPLEMENTATION_CONTRACT.md`.

## Current implementation boundary

This subtree implements **slice 1: the hermetic policy core**, **slice 2: the
private CONNECT policy dialer**, **slice 3: the pinned interception gateway**,
and a non-deployed Fly topology scaffold. The Go module provides:

- strict CONNECT-authority and IDNA hostname normalization;
- a checked-in domain denylist and reserved/local suffix policy;
- pinned IANA IPv4 and IPv6 special-purpose registry snapshots, a reproducible
  generator, hashes, and a policy fingerprint;
- all-answer address classification and deterministic selection of one public
  address;
- an injectable, dual fixed-IP DNS-over-TLS resolver that queries both A and
  AAAA, follows at most eight CNAME links, combines public answer differences,
  and never calls the operating-system resolver or keeps a DNS cache;
- an allowlisted audit event type that HMACs normalized hosts and cannot carry
  raw URLs, hostnames, addresses, headers, bodies, credentials, certificates,
  or exception text;
- a raw, 64 KiB-bounded HTTP/1.1 CONNECT parser that rejects bodies, framing,
  upgrades, h2c, ambiguous authorities, duplicate fields, and pipelining;
- an mTLS-only private listener with one exact SPIFFE URI allowlist, mandatory
  HTTP/1.1 ALPN, a shared five-second DNS/connect budget, and no Basic-auth or
  public-listener mode;
- one numeric-IP TCP dial with no operating-system DNS lookup, fallback,
  alternate-address retry, or Happy Eyeballs path;
- bounded credential/destination rate and concurrency admission, including
  pending DNS and connect work;
- a 30-second idle relay with half-close behavior and hard 2 MiB upload and
  20 MiB download ceilings;
- loopback-only liveness/readiness that performs no DNS or target request;
- immutable startup checks for the denylist hash, policy fingerprint, TLS
  material, resolver endpoints, release digest, audit encoder, and limits;
- hermetic mTLS, protocol-denial, rebinding, mixed-answer, exact-IP target
  receipt, shared-budget, limiter-race, relay, health, and audit-failure tests.

The `interceptor/` subtree contains the reproducibly patched mitmproxy/h11
build, strict public CONNECT authentication and HTTP/body/framing policy. The
`deploy/` subtree contains separate public-interceptor and private-dialer Fly
templates, default-drop firewall rules, privilege-drop entrypoints, internal
mTLS PKI tooling, and hermetic configuration tests.

Nothing here has been deployed. The Fly templates retain deliberate app-name
placeholders; no provider project, resolver operator, durable audit sink,
certificate, secret, public IP, or production hostname has been configured.
Container builds and the effective Fly/nftables topology also remain unproven
in this local environment. Browserbase integration and production canaries are
mandatory live gates, so the production runner remains blocked.

## Policy flow

```text
normalized host
      |
      v
domain policy -> two fixed-IP DoT resolvers -> A + AAAA + bounded CNAME chains
                                             |
                                             v
                                 validate every observed address
                                             |
                           any unsafe answer? reject whole destination
                                             |
                                  otherwise pin deterministic IP
```

The slice-2 dialer passes the selected numeric address directly to the kernel
once, with no DNS lookup, Happy Eyeballs fallback, address retry, or cached
prior answer. The original normalized hostname remains the TLS SNI and
certificate identity at the interception layer.

## Local verification

The module requires Go 1.25 or newer. A system-wide Go installation is not
required; an official toolchain can be unpacked into a temporary directory and
used directly.

From this directory:

```sh
go test ./...
go test -race ./...
go vet ./...
go run ./cmd/generate-iana -root . -check
```

Fuzz targets live with authority, DNS, address-policy, and audit packages. For
example:

```sh
go test ./internal/authority -fuzz=FuzzNormalizeHostname -fuzztime=30s
go test ./internal/dnsresolver -fuzz=FuzzDNSPacketParsing -fuzztime=30s
go test ./internal/proxy -fuzz=FuzzParseConnectRequest -fuzztime=30s
```

All normal tests are hermetic. They do not contact IANA, a DNS resolver, a
target, Fly, Browserbase, Vercel, or any other provider.

## Updating the IANA policy

Production builds and startup never fetch policy. Refresh is an explicit
maintenance operation only:

```sh
go run ./cmd/generate-iana -root . -refresh
git diff -- policy/ internal/policy/iana_generated.go
go test ./...
go run ./cmd/generate-iana -root . -check
```

The refresh command accepts only the two hard-coded IANA HTTPS origins, bounds
downloads to 1 MiB, validates every prefix, records snapshot hashes and the
retrieval date, and produces a reviewable generated Go diff. A snapshot older
than 30 days is a release warning; older than 90 days is a release blocker until
an explicit refresh is reviewed. Snapshot freshness does not weaken the
runtime backstops for private, loopback, link-local, multicast, mapped,
translated, metadata, or Fly-private addresses.

## DNS operator configuration

No production resolver operators are selected or hard-coded. Runtime
configuration must provide exactly two independently reviewed resolver
endpoints, each as a numeric public IP on TCP 853 plus its normalized TLS server
name. Both certificate-verified responses are mandatory; neither endpoint is a
fallback. Operator selection, privacy review, and fixed bootstrap IP approval
remain external release decisions.

## Remaining release gates

Follow `deploy/README.md`. The next work is operator-approved runtime proof:
build and scan immutable images, validate rendered Fly configuration, verify
the effective firewall and mTLS topology, select two DoT operators and a
durable audit sink, prove Browserbase custom-proxy/interception-CA behavior,
then complete the required fail-closed and seven-day scheduled canaries. None
of those gates may be inferred from local tests or used to enable the runner.

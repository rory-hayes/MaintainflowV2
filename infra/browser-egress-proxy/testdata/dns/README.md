# Hermetic DNS fixtures

The resolver tests build `miekg/dns` response messages through the injected
`QueryClient` interface. They never contact the operating-system resolver or a
public DNS service.

The fixture matrix covers A-only, AAAA-only, dual-stack, independent resolver
answer differences, CNAME chains and loops, NODATA, NXDOMAIN, truncation,
SERVFAIL, malformed ownership, timeouts, mixed public/private answers, and
IPv4-mapped IPv6. Slice 2 will add wire-level authoritative DNS and target
servers under this directory for CONNECT integration tests.

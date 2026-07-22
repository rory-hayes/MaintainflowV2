# Browser egress container residual-risk review

Review date: **22 July 2026**

This review covers the complete, unsuppressed Trivy `0.70.0` scan after the
browser-egress dialer and interceptor images have installed current Debian 13
security updates and stripped unused administration, archive, SQLite and
terminal packages. It is a source-controlled review baseline, not proof for a
future release digest.

Both locally built ARM64 images produced:

- zero `CRITICAL` findings;
- zero fixable `HIGH` or `CRITICAL` findings; and
- the same two unfixed Debian `HIGH` findings listed below.

CI must repeat both scans against the exact release commit on native AMD64,
publish the complete JSON reports and SPDX SBOMs, and record the resulting
image digests in release evidence. A changed result invalidates this review.

## CVE-2026-54369 — `libacl1`

The reported issue is a symlink-traversal privilege-escalation path in libacl
functions. `libacl1` remains because the entrypoint needs a small set of
Coreutils commands during fail-closed startup. Maintain Flow does not invoke
the affected ACL APIs directly.

The startup paths are fixed service-owned paths beneath `/run/maintainflow`,
the per-boot leaf is randomly generated with mode `0700`, decoded material is
written with no-follow/exclusive semantics, and no customer-controlled path is
passed to `install` or `chown`. The container's ephemeral root filesystem,
fixed entrypoint, non-root proxy process and cleared capability set further
bound impact. The finding has no installable Debian fix in the reviewed scan;
the blocking CI pass will fail automatically when one becomes available and is
not installed.

## CVE-2025-69720 — `libtinfo6`

The reported issue is an ncurses buffer-overflow path. `libtinfo6` remains as a
dynamic dependency of nftables' non-interactive command-line binary. Maintain
Flow invokes `nft` only with version-controlled or service-generated rule
files before the network proxy binds. It does not expose an interactive
terminal, accept customer terminal input, or read customer-selected terminfo
data.

All ncurses programs and the wide-character ncurses runtime library are
removed. The residual library is reached only through nftables' fixed startup
path, while customer browser traffic is handled later by the non-root proxy.
The finding has no installable Debian fix in the reviewed scan; the blocking CI
pass will fail automatically when one becomes available and is not installed.

## Release decision

These two residuals may be accepted only when the exact-commit CI artifacts
still match this reachability analysis, the fixable-finding gate passes, and
the Fly runtime proves the same fixed entrypoints and capability boundary. No
CVE is allowlisted or hidden from the complete report.

This review does not approve deployment by itself. The mTLS, Fly private
network, default-drop firewall, Browserbase, signed proxy credential, provider
budget and seven-day canary gates remain mandatory.

# Security Policy

## Reporting a vulnerability

Please **do not open a public issue** for security reports. Instead, email
the maintainers privately:

- **Email**: `security@brows3r.dev` (until the project picks a permanent
  domain, substitute the lead maintainer's address listed in the GitHub
  profile of the repository owner).
- **GitHub Security Advisory**: open a private security advisory via
  [github.com/banduk/brows3r/security/advisories/new](https://github.com/banduk/brows3r/security/advisories/new).

Include:

1. A description of the issue and its impact.
2. A reproduction (proof-of-concept, sample bucket, repro steps).
3. The affected version (`brows3r --version` or commit SHA).
4. Your preferred disclosure timeline.

We aim to acknowledge reports within **72 hours** and to publish a fix and
advisory within **14 days** of confirmation for high-severity issues.

## What we consider in scope

- Anything that lets a hostile party read AWS credentials or session
  tokens from the WebView, the Tauri IPC layer, the loopback media
  server, or persisted state.
- Anything that lets a hostile party trigger arbitrary S3 operations
  (DELETE, PutObject, etc.) without explicit user action.
- Privilege escalation across profiles (operating on one profile while
  another's credentials are loaded).
- Renderer-side XSS, prototype pollution, or token leakage via
  reflected URLs.
- Loopback media server token guessing / replay across sessions.
- Persistence of credentials in plaintext outside the OS keychain.
- Bypass of the validation gate (operating on an unvalidated profile).

## Out of scope

- Attacks that require root / admin on the user's machine. brows3r's
  threat model is "trusted local host" — once an attacker controls the
  OS, all bets are off, same as the AWS CLI.
- Social engineering of the user (e.g. tricking them into pasting a
  malicious presigned URL).
- Denial-of-service via huge buckets or pathological prefixes that
  consume memory / CPU. These are perf issues, not security.
- Issues in upstream dependencies that have a known CVE without a patch
  available — we'll bump as soon as one ships.

## Disclosure policy

We follow a coordinated disclosure model:

1. You report privately.
2. We confirm, classify severity, and assign an issue number internally.
3. We develop a fix on a private branch.
4. We coordinate a release date with you (typically 7–14 days for
   high-severity, 14–30 days for medium).
5. We ship the fix, publish a GitHub Security Advisory, and credit you
   in the changelog (unless you prefer to remain anonymous).

## Supported versions

While brows3r is pre-1.0, we support **the latest tagged release** and the
`main` branch. Older tags don't receive security backports.

## Hall of fame

A list of reporters with public credit will live here once we receive our
first disclosure. Thank you in advance.

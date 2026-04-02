# Security policy

## Reporting a vulnerability

If you discover a security vulnerability in `@wave-av/adk`, please report it responsibly.

**Do not open a public issue.**

Instead, email **security@wave.online** with:

- A description of the vulnerability
- Steps to reproduce
- Impact assessment
- Any suggested fix (optional)

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical issues.

## Supported versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |
| < 1.0   | No        |

## Security measures

- All API calls use HTTPS with TLS 1.3
- API keys are never logged or included in error messages
- Dependencies are monitored via Dependabot and npm audit
- Secret scanning and push protection are enabled on this repository

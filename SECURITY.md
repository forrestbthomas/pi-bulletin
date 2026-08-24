# Security Policy

## Supported Versions

pi-bulletin is a 0.x package; only the current and previous published minors
receive security fixes. **Update this table in the same PR as any CHANGELOG
release entry.**

| Version | Supported          |
| ------- | ------------------ |
| v0.2.x  | ✅ Active          |
| < 0.2   | ❌ Not supported    |

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use GitHub's **private vulnerability reporting** (recommended):

1. Go to the repo: https://github.com/forrestbthomas/pi-bulletin
2. **Security** tab → **Report a vulnerability** → **Create a report**.

This sends the report privately to the maintainers.

If private reporting is unavailable, email the maintainer privately at the
address shown in the repo (git config user.email / profile), or open a
**draft** security advisory from the Security tab.

### What to include

- Affected version / commit
- Steps to reproduce
- Impact (what an attacker could do)
- Suggested fix, if you have one

## Response SLA

- **Acknowledgement:** within 48 hours of a report.
- **Triage / fix plan:** within 7 days.
- **Fix shipped:** coordinated with the reporter; a public disclosure is
  posted after the fix is released.

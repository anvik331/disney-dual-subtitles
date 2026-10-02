# Security Policy

## Supported version

Security fixes are applied to the latest version on the default branch.

## Reporting a vulnerability

Please do not publish credentials, signed Disney playback URLs, account data,
private subtitle content, or working exploit details in a public issue.

Open a GitHub private vulnerability report when that feature is available for
the repository. Otherwise, contact the repository owner privately and include:

- the affected version;
- reproduction steps using non-sensitive test data;
- the expected and observed behavior; and
- the potential security or privacy impact.

The extension must continue to restrict background requests to allowlisted HTTPS
Disney media hosts, enforce response-size limits, avoid remote code execution,
and request only the permissions required by its user-facing purpose.


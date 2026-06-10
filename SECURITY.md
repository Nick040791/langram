# Security

## Threat model

LANgram runs on a private LAN and exposes read access to a single host
folder chosen at runtime. The threat model is:

- **Honest LAN users** browsing the gallery should have a smooth,
  read-only experience with no login prompts.
- **Curious LAN users** must not be able to read arbitrary files on the
  host by poking at API endpoints.
- **Mutating actions** (changing the gallery root, liking files) must
  require a shared secret that the host owner distributes out-of-band.

## Reporting a vulnerability

Email `security@kcoptimalcomputing.com` with a description of the issue
and a proof of concept. Please do not file a public GitHub issue for
security reports.

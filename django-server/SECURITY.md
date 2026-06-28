# Security configuration

The Django backend reads all secrets and security-sensitive switches from the
environment. Defaults are safe for production (DEBUG off, Host/Origin locked,
HTTPS/HSTS on). Local development opts back into permissive behaviour with
`IONIK_DEBUG=1` (the Windows run scripts already set this).

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `IONIK_SECRET_KEY` | public dev-only key when `IONIK_DEBUG=1`; required in prod | Django signing key. **Set in prod & rotate.** |
| `IONIK_MESSAGE_ENCRYPTION_KEY` | public dev-only key when `IONIK_DEBUG=1`; required in prod | Primary Fernet key for new chat-at-rest encryption. **Set in prod & rotate.** |
| `IONIK_OLD_MESSAGE_ENCRYPTION_KEYS` | empty | Comma-separated Fernet keys that may still decrypt old rows/files during rotation. |
| `IONIK_DEBUG` | `0` | `1` enables DEBUG (verbose errors, allow-all CORS, no HTTPS redirect). |
| `IONIK_ALLOWED_HOSTS` | localhost + `IONIK_DOMAIN` | Comma-separated Host whitelist (`*` to disable). |
| `IONIK_DOMAIN` | `start-ionik.ru` | Primary domain (Host + CORS/CSRF origins). |
| `IONIK_CORS_ORIGINS` | empty | Extra allowed CORS origins (comma-separated). |
| `IONIK_CORS_ALLOW_ALL` | `0` | Escape hatch: allow any origin in prod if a client breaks. |
| `IONIK_SSL_REDIRECT` | `1` (prod) | Redirect HTTP to HTTPS. |
| `IONIK_HSTS_SECONDS` | `31536000` | HSTS max-age. |
| `IONIK_STATUS_TOKEN` | empty | Secret for `/status-<token>/` and `/metrics?token=`. If unset, falls back to the weak date token. **Set in prod.** |
| `IONIK_ACCESS_TOKEN_MINUTES` | `15` | JWT access lifetime. |
| `IONIK_REFRESH_TOKEN_DAYS` | `14` | JWT refresh lifetime. |
| `IONIK_REFRESH_COOKIE_NAME` | `ionik_refresh` | HttpOnly refresh cookie name. |
| `IONIK_UPLOAD_SCAN_COMMAND` | empty | Optional AV scanner command. The uploaded temp file path is appended as the final argv item. |
| `IONIK_THROTTLE_ANON` / `_USER` / `_AUTH` | `60/min` / `1000/min` / `10/min` | DRF rate limits. |

On the production server `scripts/linux/start-common.sh` generates
`/etc/ionik/secrets.env` (mode 0640) with strong `IONIK_SECRET_KEY`,
`IONIK_STATUS_TOKEN`, and `IONIK_MESSAGE_ENCRYPTION_KEY`, then wires
`IONIK_DEBUG=0` plus Host/Origin restrictions into the systemd units.

## Message encryption key rotation

To rotate an existing database without losing old messages:

1. Add a new Fernet key to `IONIK_MESSAGE_ENCRYPTION_KEY`.
2. Put the previous key(s) in `IONIK_OLD_MESSAGE_ENCRYPTION_KEYS`, comma-separated.
3. Run `python manage.py rotate_message_encryption --dry-run`.
4. Run `python manage.py rotate_message_encryption`.
5. Remove the old key(s) from `IONIK_OLD_MESSAGE_ENCRYPTION_KEYS` after verifying reads/downloads.

The command re-encrypts DM messages, guild messages, scheduled messages,
post comments, and encrypted attachment files with the current primary key.

## WebSocket auth

The web client sends JWTs through the `Sec-WebSocket-Protocol` handshake
(`ionik.jwt`, then the token), so tokens no longer appear in WebSocket URLs.
The Django Channels middleware and Rust ws-gateway reject the old
`?token=<jwt>` query parameter. The Rust gateway also calls Django
`/api/ws/authorize/` before accepting a socket so a valid JWT is not enough to
join a conversation or guild channel.

## Client refresh flow

The web client stores only the short-lived access token. Refresh tokens are set
as HttpOnly cookies on login/register, are rotated by SimpleJWT, and are
blacklisted after rotation/logout/password change. Authenticated HTTP requests
retry once after a 401 refresh.

## Runtime hardening

- Uploads reject active file types/extensions, are served as attachments with
  `X-Content-Type-Options: nosniff`, and can be checked by an AV command via
  `IONIK_UPLOAD_SCAN_COMMAND`.
- Security-sensitive auth actions are recorded in `SecurityAuditLog`.
- CI runs CodeQL, dependency review, npm audit, pip-audit, Gitleaks, and Trivy.
- Docker compose requires explicit database/Grafana/JWT secrets and binds
  infrastructure ports to localhost.

## Remaining manual step

Scrub leaked historical secrets from git history with a coordinated history
rewrite, for example `git filter-repo`, then force-push and rotate any keys that
were ever present in the rewritten history. Do this only with repo-owner
coordination because every clone/branch must be reconciled afterward.

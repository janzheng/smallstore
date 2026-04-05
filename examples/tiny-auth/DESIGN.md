# Tiny Auth — Airtable-Backed Account System

## Overview

A minimal user account system using Airtable as the database. Airtable provides a free admin UI (the grid view) for managing users, sessions, and invites — no separate admin panel needed.

## Why Airtable for Auth?

- **Zero-cost admin dashboard**: Approve users, revoke sessions, manage roles directly in Airtable
- **Schema flexibility**: Add fields (plan, company, onboardedAt) without migrations
- **API-ready**: Smallstore's Airtable adapter gives you CRUD + upsert + search for free
- **Tiny projects**: Perfect for personal tools, internal apps, side projects with <1000 users

## Tables

### Users
| Field | Type | Notes |
|-------|------|-------|
| email | email | Primary key, unique |
| name | singleLineText | Display name |
| role | singleSelect | admin, user, viewer |
| status | singleSelect | active, pending, suspended |
| passwordHash | singleLineText | bcrypt hash (never exposed via API) |
| createdAt | dateTime | Auto-set |
| lastLoginAt | dateTime | Updated on each login |

### Sessions
| Field | Type | Notes |
|-------|------|-------|
| token | singleLineText | Primary key, random UUID |
| email | email | Links to Users.email |
| expiresAt | dateTime | Session expiry |
| createdAt | dateTime | When session was created |
| userAgent | singleLineText | For audit trail |
| ip | singleLineText | For audit trail |

### Invites
| Field | Type | Notes |
|-------|------|-------|
| code | singleLineText | Random invite code |
| email | email | Optional: pre-assigned to email |
| role | singleSelect | What role the invitee gets |
| usedBy | email | Who used this invite |
| usedAt | dateTime | When it was used |
| expiresAt | dateTime | Invite expiry |

## API Endpoints (via smallstore API server)

```
POST   /auth/register       { email, password, inviteCode? }
POST   /auth/login           { email, password }
POST   /auth/logout          { token }
GET    /auth/me              (Bearer token) → user profile
POST   /auth/invite          (admin only) { email?, role }
```

## Architecture

```
Client → API Server (Hono) → Smallstore → Airtable Adapter → Airtable
                                  ↑
                            Auth middleware
                         (validates session token)
```

The API server adds a thin auth middleware layer on top of the standard smallstore API. Session validation is a simple lookup: `store.get('sessions/{token}')` → check `expiresAt`.

## Security Considerations

- Password hashing: bcrypt with cost factor 12
- Session tokens: crypto.randomUUID() — 122 bits of entropy
- Rate limiting: Airtable's own rate limits (5 req/sec) provide natural brute-force protection
- HTTPS required: Use Cloudflare Tunnel for local dev
- Never expose passwordHash field via API responses — strip it in the response middleware

## Limitations

- **Scale**: Airtable caps at 50k records per base, 5 req/sec API limit
- **Latency**: ~200-500ms per auth check (Airtable API roundtrip)
- **Not for**: High-traffic production apps, sub-100ms auth requirements
- **Good for**: Personal tools, internal dashboards, prototypes, side projects

## Future Work

- OAuth provider support (Google, GitHub)
- Magic link login (email-based, no password)
- API key management (for service-to-service auth)
- Session refresh/rotation

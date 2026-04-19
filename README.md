# VPSMMO Monitoring

Production-grade commercial uptime monitoring SaaS at `monitoring.vpsmmo.vn`.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Copy env and fill secrets
cp .env.example .env
chmod 600 .env
# Edit .env with real values

# 3. Install git hooks
bash scripts/install-hooks.sh

# 4. Run migrations
node scripts/migrate.js up

# 5. Start server
npm start          # production
npm run dev        # development (pretty logs)
```

## Scripts

| Command | Purpose |
|---|---|
| `npm start` | Start production server |
| `npm run dev` | Start with debug logging |
| `npm test` | Run test suite |
| `npm run test:coverage` | Run tests with coverage |
| `npm run migrate` | Apply pending migrations |
| `npm run migrate:status` | Show migration status |
| `npm run check:invariants` | Verify wallet balance integrity |
| `npm run check:secrets` | Scan code for leaked secrets |

## Environment Variables

See `.env.example` for full list. Required vars validated at boot — missing vars cause process exit.

## File Permissions

- `.env` must be `chmod 600` (owner read/write only)
- Log dir `/var/log/vpsmmo-monitoring/` must be writable by app user

## Database

- MySQL 8.0+ with InnoDB, REPEATABLE-READ isolation
- App user `vpsmmo_monitoring` has DML + DDL grants
- Backup user `backup_user` has read-only grants

## Documentation

- `CLAUDE.md` — Project constitution and rules
- `ARCHITECTURE.md` — System blueprint and data flows
- `MILESTONES.md` — Implementation roadmap
- `SECURITY-CHECKLIST.md` — Security verification items
- `ADVERSARIAL-TESTING.md` — Self-attack protocol

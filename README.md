# cousin-mcp (local)

A local MCP server that lets **Claude Desktop** and **Claude Code** reach Cousin's data:

- **`db_query` / `list_tables` / `describe_table`** — read-only SQL against Postgres.
- **`api_get` / `api_write` / `describe_api`** — call the Fastify API (writes go through its
  validation + business rules).

Claude launches this process directly over stdio. No hosting, no OAuth, no public endpoint.
(It does **not** work on claude.ai in a browser or in Cowork — those need the hosted variant.)

## Setup (~10 min)

### 1. Build

```bash
cd cousin-mcp
npm install
npm run build      # → dist/stdio.mjs
```

### 2. Pick a database URL

- **Safest (recommended):** a read-only role, so `db_query` physically cannot mutate. In
  Supabase → SQL editor:
  ```sql
  create role cousin_mcp_ro login password 'strong-password';
  grant connect on database postgres to cousin_mcp_ro;
  grant usage on schema public to cousin_mcp_ro;
  grant select on all tables in schema public to cousin_mcp_ro;
  alter default privileges in schema public grant select on tables to cousin_mcp_ro;
  ```
  Use that role's Supabase **Transaction pooler** string (port 6543) as `DATABASE_URL`.
- **Fastest to try:** reuse your existing `DATABASE_URL` from `cousin-backend/.env`. The tool's
  SQL guard still blocks non-SELECT statements, but the read-only role is the real safety net —
  switch to it before you rely on this.

### 3. Wire it into Claude

Three env vars: `DATABASE_URL`, `SUPABASE_JWT_SECRET` (same value as `cousin-backend/.env`),
`COUSIN_API_BASE_URL` (your Render URL, or `http://localhost:3000` while the backend runs locally).
Optional: `MCP_ACTOR_SUB` (a UUID for cleaner audit logs).

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "cousin": {
      "command": "node",
      "args": ["/Users/4089dtidigital/Developer/Cousin/cousin-mcp/dist/stdio.mjs"],
      "env": {
        "DATABASE_URL": "postgres://cousin_mcp_ro:...@...pooler.supabase.com:6543/postgres",
        "SUPABASE_JWT_SECRET": "same-as-backend",
        "COUSIN_API_BASE_URL": "https://cousin-backend.onrender.com"
      }
    }
  }
}
```

Restart Claude Desktop. The `cousin` tools appear in the tools menu.

**Claude Code** — from the repo root:

```bash
claude mcp add cousin \
  --env DATABASE_URL="postgres://cousin_mcp_ro:...:6543/postgres" \
  --env SUPABASE_JWT_SECRET="same-as-backend" \
  --env COUSIN_API_BASE_URL="https://cousin-backend.onrender.com" \
  -- node /Users/4089dtidigital/Developer/Cousin/cousin-mcp/dist/stdio.mjs
```

## Try it

Ask Claude: *"list the tables in the cousin database"*, then *"how many wallets are there?"*,
then *"show my dashboard for this month"* (uses `api_get`).

## Notes

- **Rebuild after code changes:** `npm run build`. (Or point the config at `npm run dev`/`tsx` if
  you'd rather skip the build step during development.)
- **`api_write` mutates production.** It goes through your validated endpoints, but it can create,
  edit, and delete real data. Confirm before destructive calls, and keep Supabase backups on.
- **HS256 dependency:** `api_*` tools mint HS256 tokens with `SUPABASE_JWT_SECRET`, accepted by the
  legacy branch in `cousin-backend/src/middleware/auth.ts`. When you remove that branch, update
  `src/jwt.ts`.
- **Want browser / Cowork access later?** That needs the hosted (remote MCP + OAuth) variant. The
  tool code here (`db.ts`, `jwt.ts`, `tools.ts`) is reused unchanged; ask and I'll add it back.

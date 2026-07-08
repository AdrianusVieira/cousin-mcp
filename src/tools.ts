import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { assertIdentifier, runReadOnlyQuery } from "./db";
import { mintApiToken } from "./jwt";

// Only the config the tools actually need. Kept separate from the hosted
// Worker's Env so the local (stdio) server doesn't depend on any Cloudflare types.
export interface ToolEnv {
  COUSIN_API_BASE_URL: string;
  DATABASE_URL: string;
  MCP_ACTOR_SUB: string;
  SUPABASE_JWT_SECRET: string;
}

// Compact catalog of the Fastify API so Claude can drive api_get/api_write
// without guessing. Mirrors cousin-backend/reference-files/endpoints.md.
const API_CATALOG = `All paths are under /api and require auth (handled automatically).
Money values are integer cents. Dates are YYYY-MM-DD.

Dashboard:  GET /dashboard?from&to
Transactions:
  GET /transactions?from&to&method(all|debit|credit)&category&wallet&cursor&limit
  POST /transactions  (debit: {method,amount,date,description?,categoryId?,fromType,fromId?,toType,toId?}
                       credit:{method,amount,date,description?,categoryId?,fromId,toType,toId?,term?,installmentTotal?})
  GET /transactions/:id | PATCH /transactions/:id {amount?,date?,description?,categoryId?} | DELETE /transactions/:id
Credit:     GET /credit?status(all|settled|unsettled) | POST /credit/settle {transactionIds:[]}
Bills:
  GET /bills?from&to&status(all|unpaid|paid|overdue)&active | POST /bills {name,value,term,sourceId,description?,recurrence?}
  GET /bills/:id | PATCH /bills/:id {name?,value?,term?,description?,paid?} | DELETE /bills/:id
Revenues:
  GET /revenues?from&to&status(all|pending|received|overdue)&active | POST /revenues {name,value,term,sourceId,description?,recurrence?}
  GET /revenues/:id | PATCH /revenues/:id {name?,value?,term?,description?,received?} | DELETE /revenues/:id
Recurrences:
  GET /recurrences?from&to | GET /recurrences/:id
  PATCH /recurrences/:id {intervalUnit?,intervalValue?,isVariable?,recurrentDay?,recurrentMonth?} | POST /recurrences/:id/deactivate
Wallets:
  GET /wallets?active&from&to | POST /wallets {name,description?}
  GET /wallets/:id?from&to | PATCH /wallets/:id {name?,description?,balance?} | POST /wallets/:id/archive | /unarchive
Sources:
  GET /sources?from&to | POST /sources {name,description?}
  GET /sources/:id | PATCH /sources/:id {name?,description?} | POST /sources/:id/archive | /unarchive
Categories:
  GET /categories?from&to&active | POST /categories {name,description?}
  GET /categories/:id | PATCH /categories/:id {name?,description?} | POST /categories/:id/archive | /unarchive`;

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

function normalizeApiPath(path: string): string {
  const clean = path.startsWith("/") ? path : `/${path}`;
  return clean.startsWith("/api/") || clean === "/api" ? clean : `/api${clean}`;
}

async function callApi(env: ToolEnv, method: string, path: string, body?: unknown): Promise<string> {
  const token = await mintApiToken(env.SUPABASE_JWT_SECRET, env.MCP_ACTOR_SUB);
  const url = new URL(normalizeApiPath(path), env.COUSIN_API_BASE_URL).href;

  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const raw = await resp.text();
  let parsed: unknown = raw;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    // leave as raw text
  }

  return JSON.stringify({ status: resp.status, ok: resp.ok, body: parsed }, null, 2);
}

export function registerTools(server: McpServer, env: ToolEnv) {
  // --- Direct database (READ-ONLY) ---

  server.tool(
    "db_query",
    "Run a read-only SQL query (SELECT/WITH/EXPLAIN/SHOW) against the Cousin Postgres database. Cannot mutate data — the DB role is SELECT-only. Use for exploration, reporting, and aggregates.",
    { sql: z.string().describe("A single read-only SQL statement.") },
    async ({ sql }) => {
      try {
        const rows = await runReadOnlyQuery(env.DATABASE_URL, sql);
        return jsonResult({ rowCount: rows.length, rows });
      } catch (e) {
        return textResult(`Query error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    "list_tables",
    "List all tables in the public schema of the Cousin database.",
    {},
    async () => {
      try {
        const rows = await runReadOnlyQuery(
          env.DATABASE_URL,
          "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
        );
        return jsonResult(rows);
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    "describe_table",
    "Show the columns, types, and nullability of a table in the public schema.",
    { table: z.string().describe("Table name, e.g. 'wallets'.") },
    async ({ table }) => {
      try {
        const name = assertIdentifier(table);
        const rows = await runReadOnlyQuery(
          env.DATABASE_URL,
          `select column_name, data_type, is_nullable, column_default
           from information_schema.columns
           where table_schema = 'public' and table_name = '${name}'
           order by ordinal_position`,
        );
        return jsonResult(rows);
      } catch (e) {
        return textResult(`Error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  // --- Fastify API ---

  server.tool(
    "describe_api",
    "Return the catalog of available Cousin API endpoints and their request shapes. Call this before using api_get/api_write if unsure of a path.",
    {},
    async () => textResult(API_CATALOG),
  );

  server.tool(
    "api_get",
    "Call a GET endpoint on the Cousin API. Path is relative to /api, e.g. '/wallets' or '/dashboard'. Use describe_api for the full list.",
    {
      path: z.string().describe("Endpoint path, e.g. '/wallets?active=true'."),
    },
    async ({ path }) => {
      try {
        return textResult(await callApi(env, "GET", path));
      } catch (e) {
        return textResult(`Request error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.tool(
    "api_write",
    "Call a mutating endpoint (POST/PATCH/DELETE) on the Cousin API. Writes go through the backend's validation and business rules. Path is relative to /api. THIS MUTATES PRODUCTION DATA — confirm intent with the user before destructive calls.",
    {
      method: z.enum(["POST", "PATCH", "DELETE"]),
      path: z.string().describe("Endpoint path, e.g. '/wallets' or '/bills/<id>'."),
      body: z.record(z.any()).optional().describe("JSON body for POST/PATCH."),
    },
    async ({ method, path, body }) => {
      try {
        return textResult(await callApi(env, method, path, body));
      } catch (e) {
        return textResult(`Request error: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}

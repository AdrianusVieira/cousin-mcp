import postgres from "postgres";

// Statements the read-only tools are allowed to start with. The DATABASE_URL
// role (`cousin_mcp_ro`) is the real guard — it only has SELECT — but this
// prefix check + multi-statement rejection is cheap defense in depth so a
// mutating query fails fast with a clear message instead of a permission error.
const READ_ONLY_PREFIXES = ["select", "with", "explain", "show", "table"];

export function assertReadOnly(sql: string): string {
  const trimmed = sql.trim().replace(/;+\s*$/, "");

  if (trimmed.length === 0) {
    throw new Error("Empty query.");
  }
  if (trimmed.includes(";")) {
    throw new Error("Multiple statements are not allowed; run one SELECT at a time.");
  }

  const firstWord = trimmed.toLowerCase().split(/\s+/)[0];
  if (!READ_ONLY_PREFIXES.includes(firstWord)) {
    throw new Error(
      `Only read-only queries are allowed (${READ_ONLY_PREFIXES.join(", ")}...). This connector cannot mutate the database directly; use the api_write tool for changes.`,
    );
  }

  return trimmed;
}

// Opens a fresh connection per call and closes it in `finally`. Volume here is
// low (single user), so this trades a little latency for not having to manage a
// pool across the Durable Object lifecycle. `prepare: false` is required for the
// Supabase transaction pooler.
export async function runReadOnlyQuery(databaseUrl: string, sql: string): Promise<unknown[]> {
  const statement = assertReadOnly(sql);

  const client = postgres(databaseUrl, {
    prepare: false,
    max: 1,
    idle_timeout: 10,
    connect_timeout: 15,
    // Supabase certs are self-signed and don't chain to a public CA, so we
    // require TLS but don't verify the chain (matches the backend's pg config).
    ssl: { rejectUnauthorized: false },
  });

  try {
    const rows = await client.unsafe(statement);
    return rows as unknown[];
  } finally {
    await client.end({ timeout: 5 });
  }
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function assertIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
  return name;
}

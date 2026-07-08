// Local MCP server for Claude Desktop and Claude Code (stdio transport).
// No hosting, no OAuth — Claude launches this process directly. Config lives in
// the client's mcpServers block, which supplies the env vars below.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools, type ToolEnv } from "./tools";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[cousin-mcp] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const env: ToolEnv = {
  COUSIN_API_BASE_URL: requireEnv("COUSIN_API_BASE_URL"),
  DATABASE_URL: requireEnv("DATABASE_URL"),
  MCP_ACTOR_SUB: process.env.MCP_ACTOR_SUB ?? "00000000-0000-0000-0000-000000000000",
  SUPABASE_JWT_SECRET: requireEnv("SUPABASE_JWT_SECRET"),
};

const server = new McpServer({ name: "cousin", version: "0.1.0" });
registerTools(server, env);

await server.connect(new StdioServerTransport());
console.error("[cousin-mcp] ready (stdio)");

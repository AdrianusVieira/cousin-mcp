// Obtains a real Supabase session for the configured user and keeps a valid
// ES256 access token available to the api_* tools.
//
// This deliberately replaces the old approach of minting HS256 tokens from
// SUPABASE_JWT_SECRET: that secret could forge a token for *any* subject, so
// anything holding it held total authority over the backend. A password grant
// yields a token for exactly one user, which the backend then checks against
// its own allowlist.

const EXPIRY_SKEW_SECONDS = 60;

export interface AuthEnv {
  COUSIN_PASSWORD: string;
  COUSIN_EMAIL: string;
  SUPABASE_ANON_KEY: string;
  SUPABASE_URL: string;
}

interface Session {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
}

let session: Session | null = null;

function isFresh(candidate: Session): boolean {
  return candidate.expiresAt - EXPIRY_SKEW_SECONDS > Math.floor(Date.now() / 1000);
}

async function tokenRequest(env: AuthEnv, grantType: string, body: unknown): Promise<Session> {
  const url = new URL(`/auth/v1/token?grant_type=${grantType}`, env.SUPABASE_URL).href;

  const resp = await fetch(url, {
    method: "POST",
    headers: { apikey: env.SUPABASE_ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text();
    throw new Error(`Supabase ${grantType} grant failed (${resp.status}): ${detail}`);
  }

  const data = (await resp.json()) as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
  };

  if (!data.access_token || !data.refresh_token) {
    throw new Error(`Supabase ${grantType} grant returned no session`);
  }

  return {
    accessToken: data.access_token,
    expiresAt: Math.floor(Date.now() / 1000) + (data.expires_in ?? 3600),
    refreshToken: data.refresh_token,
  };
}

function signIn(env: AuthEnv): Promise<Session> {
  return tokenRequest(env, "password", { email: env.COUSIN_EMAIL, password: env.COUSIN_PASSWORD });
}

export async function getAccessToken(env: AuthEnv): Promise<string> {
  if (session && isFresh(session)) return session.accessToken;

  if (session) {
    try {
      session = await tokenRequest(env, "refresh_token", { refresh_token: session.refreshToken });
      return session.accessToken;
    } catch {
      // A stale or revoked refresh token is recoverable - fall through and
      // sign in again rather than failing the tool call.
      session = null;
    }
  }

  session = await signIn(env);
  return session.accessToken;
}

/** Test seam: drops the cached session so the next call re-authenticates. */
export function resetSession(): void {
  session = null;
}

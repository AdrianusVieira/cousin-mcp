// Mints short-lived HS256 JWTs accepted by the Cousin backend's legacy auth
// branch (see cousin-backend/src/middleware/auth.ts). The backend only verifies
// the signature and reads `sub`, so a minimal payload is sufficient.
//
// NOTE: this depends on SUPABASE_JWT_SECRET remaining enabled on the backend.
// When that legacy HS256 fallback is removed, replace this with a stored/
// refreshed Supabase session (ES256) obtained during login.

function base64url(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function mintApiToken(secret: string, sub: string, ttlSeconds = 300): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const payload = {
    aud: "authenticated",
    exp: now + ttlSeconds,
    iat: now,
    role: "authenticated",
    sub,
  };

  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));

  return `${signingInput}.${base64url(signature)}`;
}

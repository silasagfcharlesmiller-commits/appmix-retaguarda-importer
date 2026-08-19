const encoder = new TextEncoder();
const COOKIE_NAME = "appmix_session";

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signature(value: string) {
  const secret = process.env.APP_MIX_SESSION_SECRET || (process.env.NODE_ENV === "development" ? "app-mix-local-development-secret-2026" : "");
  if (!secret || secret.length < 32) throw new Error("APP_MIX_SESSION_SECRET precisa ter pelo menos 32 caracteres.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

export async function createSession(email: string) {
  const payload = btoa(JSON.stringify({ email, exp: Date.now() + 8 * 60 * 60 * 1000 }));
  return `${payload}.${await signature(payload)}`;
}

export async function verifySession(value?: string) {
  if (!value) return null;
  try {
    const [payload, received] = value.split(".");
    if (!payload || !received || received !== await signature(payload)) return null;
    const data = JSON.parse(atob(payload)) as { email: string; exp: number };
    return data.exp > Date.now() ? data : null;
  } catch {
    return null;
  }
}

export { COOKIE_NAME };

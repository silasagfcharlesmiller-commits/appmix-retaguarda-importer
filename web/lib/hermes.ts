import { createHash, timingSafeEqual } from "node:crypto";
import { query } from "@/lib/db";

export type HermesActor = { ownerId: number; accountOwnerId: number; login: string; requester: string; fingerprint: string };

export async function ensureHermesSchema() {
  await query(`CREATE TABLE IF NOT EXISTS public.hermes_api_audit (
    id BIGSERIAL PRIMARY KEY,
    request_id VARCHAR(180),
    method VARCHAR(10) NOT NULL,
    path VARCHAR(300) NOT NULL,
    requester VARCHAR(180) NOT NULL,
    key_fingerprint VARCHAR(20) NOT NULL,
    status_code INTEGER,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_json JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at TIMESTAMPTZ
  )`);
  await query("CREATE UNIQUE INDEX IF NOT EXISTS hermes_api_audit_request_id_uidx ON public.hermes_api_audit(request_id) WHERE request_id IS NOT NULL");
  await query("CREATE INDEX IF NOT EXISTS hermes_api_audit_created_idx ON public.hermes_api_audit(created_at DESC)");
  await query(`CREATE TABLE IF NOT EXISTS public.hermes_api_keys (
    id BIGSERIAL PRIMARY KEY, name VARCHAR(100) NOT NULL,
    key_hash CHAR(64) NOT NULL UNIQUE, key_prefix VARCHAR(16) NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES public.web_users(id), active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by INTEGER NOT NULL REFERENCES public.web_users(id), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ
  )`);
  await query("ALTER TABLE public.hermes_api_keys ADD COLUMN IF NOT EXISTS credential_owner_id INTEGER REFERENCES public.web_users(id)");
  await query("UPDATE public.hermes_api_keys SET credential_owner_id=owner_id WHERE credential_owner_id IS NULL");
  await query(`CREATE TABLE IF NOT EXISTS public.service_heartbeats (
    service_name VARCHAR(60) PRIMARY KEY, host_name VARCHAR(180) NOT NULL,
    process_id INTEGER, version VARCHAR(40), details JSONB NOT NULL DEFAULT '{}'::jsonb,
    last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
}

function safeEqual(actual: string, expected: string) {
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function authenticateHermes(request: Request): Promise<HermesActor> {
  const supplied = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || request.headers.get("x-api-key") || "";
  if (supplied.length < 32) throw Object.assign(new Error("Credencial de integracao invalida."), { status: 401 });
  const suppliedHash = createHash("sha256").update(supplied).digest("hex");
  const key = (await query<{id:number;owner_id:number;credential_owner_id:number;key_hash:string}>("SELECT id,owner_id,COALESCE(credential_owner_id,owner_id) AS credential_owner_id,key_hash FROM public.hermes_api_keys WHERE key_hash=$1 AND active=TRUE", [suppliedHash])).rows[0];
  if (!key || !safeEqual(suppliedHash, key.key_hash)) throw Object.assign(new Error("Credencial de integracao invalida."), { status: 401 });
  const user = (await query<{id:number;email:string}>("SELECT id,email FROM public.web_users WHERE ativo=TRUE AND id=$1 AND COALESCE(owner_id,id)=$2", [key.credential_owner_id,key.owner_id])).rows[0];
  if (!user) throw Object.assign(new Error("Operador tecnico do Hermes nao encontrado ou inativo."), { status: 503 });
  const credential = await query("SELECT 1 FROM public.mix_credentials WHERE owner_id=$1 AND ativa=TRUE", [user.id]);
  if (!credential.rowCount) throw Object.assign(new Error("Operador tecnico do Hermes nao possui credencial Mix ativa."), { status: 503 });
  const requester = (request.headers.get("x-hermes-user") || "emanuel@hermes").trim().slice(0, 120);
  await query("UPDATE public.hermes_api_keys SET last_used_at=NOW() WHERE id=$1", [key.id]);
  return { ownerId: user.id, accountOwnerId: key.owner_id, login: user.email, requester, fingerprint: suppliedHash.slice(0, 12) };
}

export function digits(value: unknown) { return String(value ?? "").replace(/\D/g, ""); }
export function validCnpj(value: string) {
  const cnpj = digits(value);
  if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
  for (const size of [12, 13]) {
    const weights = size === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    const sum = weights.reduce((total, weight, index) => total + Number(cnpj[index]) * weight, 0);
    const candidate = 11 - (sum % 11);
    if (Number(cnpj[size]) !== (candidate >= 10 ? 0 : candidate)) return false;
  }
  return true;
}

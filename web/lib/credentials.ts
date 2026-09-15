import "server-only";
import { createCipheriv,createDecipheriv,createHash,randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { query } from "@/lib/db";
import type { WebUser } from "@/lib/users";
function key(){let s=process.env.APP_MIX_CREDENTIAL_SECRET||"";if(!s&&process.env.NODE_ENV==="development"){try{s=JSON.parse(readFileSync(resolve(process.cwd(),"..","config_mix.json"),"utf8")).credential_secret||"";}catch{}}if(s.length<32)throw new Error("APP_MIX_CREDENTIAL_SECRET precisa ter pelo menos 32 caracteres no site e no worker.");return createHash("sha256").update(s).digest();}
export function encryptSecret(value:string){const iv=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key(),iv),data=Buffer.concat([cipher.update(value,"utf8"),cipher.final()]);return `v1:${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;}
export async function ensureCredentials(){await query(`CREATE TABLE IF NOT EXISTS public.mix_credentials(owner_id INTEGER PRIMARY KEY REFERENCES public.web_users(id) ON DELETE CASCADE,login VARCHAR(180) NOT NULL,password_encrypted TEXT NOT NULL,ativa BOOLEAN NOT NULL DEFAULT FALSE,validada_em TIMESTAMPTZ,erro_validacao VARCHAR(500),atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW())`);}
export async function credentialStatus(u:WebUser){await ensureCredentials();return (await query<{login:string;ativa:boolean;validada_em:string|null;erro_validacao:string|null}>("SELECT login,ativa,validada_em,erro_validacao FROM public.mix_credentials WHERE owner_id=$1",[u.id])).rows[0]||{login:"",ativa:false,validada_em:null,erro_validacao:null};}
export async function saveCredential(u:WebUser,login:string,password:string){login=login.trim();if(!login||!password)throw new Error("Informe seu login e sua senha do App Mix.");let r:Response;try{r=await fetch("https://dev.authentication.mixfiscal.com.br/v1/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({email:login,password,browser_id:"appmix-web-validation"}),signal:AbortSignal.timeout(20000),cache:"no-store"});}catch{throw new Error("Nao foi possivel validar a credencial no App Mix agora.");}if(!r.ok)throw new Error("Login ou senha do App Mix recusados.");await ensureCredentials();await query(`INSERT INTO public.mix_credentials(owner_id,login,password_encrypted,ativa,validada_em,erro_validacao) VALUES($1,$2,$3,TRUE,NOW(),NULL) ON CONFLICT(owner_id) DO UPDATE SET login=EXCLUDED.login,password_encrypted=EXCLUDED.password_encrypted,ativa=TRUE,validada_em=NOW(),erro_validacao=NULL,atualizado_em=NOW()`,[u.id,login,encryptSecret(password)]);return credentialStatus(u);}
export async function requireCredential(u:WebUser){const s=await credentialStatus(u);if(!s.ativa)throw new Error("Cadastre e valide a credencial do App Mix antes de enviar tarefas.");return s;}

// Tokens stay on the server and are scoped to the owner and saved credential.
const bearerCache = new Map<number, { fingerprint: string; expires: number; token: Promise<string> }>();

export async function credentialBearer(ownerId: number, refresh = false) {
  const { rows } = await query<{ login: string; password_encrypted: string }>(
    "SELECT login,password_encrypted FROM public.mix_credentials WHERE owner_id=$1 AND ativa=TRUE", [ownerId],
  );
  const credential = rows[0];
  if (!credential) {
    bearerCache.delete(ownerId);
    throw new Error("Valide a credencial do App Mix para consultar o cadastro dos clientes.");
  }
  const fingerprint = createHash("sha256").update(`${credential.login}:${credential.password_encrypted}`).digest("hex");
  const cached = bearerCache.get(ownerId);
  if (!refresh && cached?.fingerprint === fingerprint && cached.expires > Date.now()) return cached.token;

  const token = (async () => {
    const [version, iv, tag, encrypted] = credential.password_encrypted.split(":");
    if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Credencial do App Mix inválida.");
    const decipher = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64"));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    const password = Buffer.concat([decipher.update(Buffer.from(encrypted, "base64")), decipher.final()]).toString("utf8");
    const response = await fetch("https://dev.authentication.mixfiscal.com.br/v1/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: credential.login, password, browser_id: "appmix-web-cadastro" }),
      cache: "no-store", signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error("Não foi possível autenticar a consulta de cadastro no App Mix.");
    const body = await response.json();
    const value = body.token || body.access_token;
    if (typeof value !== "string" || !value.trim()) throw new Error("App Mix não retornou o token de cadastro.");
    return value.replace(/^Bearer\s+/i, "").trim();
  })();
  if (bearerCache.size >= 128) bearerCache.delete(bearerCache.keys().next().value!);
  const entry = { fingerprint, expires: Date.now() + 5 * 60_000, token };
  bearerCache.set(ownerId, entry);
  try { return await token; }
  catch (error) {
    if (bearerCache.get(ownerId) === entry) bearerCache.delete(ownerId);
    throw error;
  }
}

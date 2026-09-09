import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, verifySession } from "@/lib/session";
import { getUser } from "@/lib/users";
import { ensureHermesSchema } from "@/lib/hermes";
import { query } from "@/lib/db";
import { createHash, randomBytes } from "node:crypto";

export const runtime = "nodejs";
export async function GET(request: NextRequest) {
  const session = await verifySession(request.cookies.get(COOKIE_NAME)?.value);
  if (!session) return NextResponse.json({ detail: "Sessao expirada." }, { status: 401 });
  const user = await getUser(session.email);
  if (!user || user.role !== "admin" || user.id !== user.owner_id) return NextResponse.json({ detail: "Somente o administrador master pode acessar a integracao." }, { status: 403 });
  await ensureHermesSchema();
  const credentialUsers = (await query<{id:number;nome:string;email:string;credential_active:boolean}>(`SELECT u.id,u.nome,u.email,COALESCE(c.ativa,FALSE) AS credential_active FROM public.web_users u LEFT JOIN public.mix_credentials c ON c.owner_id=u.id WHERE u.ativo=TRUE AND COALESCE(u.owner_id,u.id)=$1 ORDER BY CASE WHEN u.id=$1 THEN 0 ELSE 1 END,u.nome`, [user.id])).rows;
  const services = (await query(`WITH expected(service_name,label) AS (VALUES ('worker_templates','Worker de templates'),('worker_importacoes','Worker de importacao'),('api_automacao','API de automacao')) SELECT e.service_name,e.label,h.host_name,h.last_seen,COALESCE(h.last_seen>NOW()-INTERVAL '35 seconds',FALSE) AS active FROM expected e LEFT JOIN public.service_heartbeats h USING(service_name) ORDER BY e.service_name`)).rows;
  const audits = (await query("SELECT id,method,path,requester,status_code,details,created_at FROM public.hermes_api_audit ORDER BY id DESC LIMIT 50")).rows;
  const keys = (await query("SELECT k.id,k.name,k.key_prefix,k.active,k.created_at,k.last_used_at,COALESCE(k.credential_owner_id,k.owner_id) AS credential_owner_id,u.email AS credential_login FROM public.hermes_api_keys k LEFT JOIN public.web_users u ON u.id=COALESCE(k.credential_owner_id,k.owner_id) WHERE k.owner_id=$1 ORDER BY k.id DESC",[user.id])).rows;
  const activeKey = keys.find((key)=>key.active);
  const selected = credentialUsers.find((candidate)=>candidate.id===Number(activeKey?.credential_owner_id));
  return NextResponse.json({ configured: Boolean(activeKey && selected?.credential_active), key_configured: Boolean(activeKey), owner: selected ? { login: selected.email, credential_active: selected.credential_active } : null, selected_credential_user_id: selected?.id || null, credential_users: credentialUsers, keys, services, audits });
}

export async function POST(request: NextRequest) {
  const session = await verifySession(request.cookies.get(COOKIE_NAME)?.value);
  if (!session) return NextResponse.json({ detail: "Sessao expirada." }, { status: 401 });
  const user = await getUser(session.email);
  if (!user || user.role !== "admin" || user.id !== user.owner_id) return NextResponse.json({ detail: "Somente o administrador master pode gerar a chave." }, { status: 403 });
  await ensureHermesSchema();
  const body = await request.json().catch(()=>({}));
  const credentialUserId = Number(body.credential_user_id || user.id);
  const credential = await query("SELECT 1 FROM public.web_users u JOIN public.mix_credentials c ON c.owner_id=u.id AND c.ativa=TRUE WHERE u.id=$1 AND u.ativo=TRUE AND COALESCE(u.owner_id,u.id)=$2",[credentialUserId,user.id]);
  if(!credential.rowCount)return NextResponse.json({detail:"Ative sua credencial Mix antes de gerar a chave."},{status:422});
  const secret=`hmx_${randomBytes(32).toString("base64url")}`;
  const hash=createHash("sha256").update(secret).digest("hex");
  await query("UPDATE public.hermes_api_keys SET active=FALSE,revoked_at=NOW() WHERE owner_id=$1 AND active=TRUE",[user.id]);
  await query("INSERT INTO public.hermes_api_keys(name,key_hash,key_prefix,owner_id,credential_owner_id,created_by) VALUES('Emanuel / Hermes',$1,$2,$3,$4,$3)",[hash,secret.slice(0,12),user.id,credentialUserId]);
  return NextResponse.json({secret,prefix:secret.slice(0,12),warning:"Copie agora. Esta chave nao sera exibida novamente."},{status:201});
}

export async function PATCH(request: NextRequest) {
  const session = await verifySession(request.cookies.get(COOKIE_NAME)?.value);
  if (!session) return NextResponse.json({ detail: "Sessao expirada." }, { status: 401 });
  const user = await getUser(session.email);
  if (!user || user.role !== "admin" || user.id !== user.owner_id) return NextResponse.json({ detail: "Somente o administrador master pode alterar o vinculo." }, { status: 403 });
  await ensureHermesSchema();
  const body = await request.json().catch(()=>({}));
  const credentialUserId = Number(body.credential_user_id);
  const credential = await query("SELECT u.email FROM public.web_users u JOIN public.mix_credentials c ON c.owner_id=u.id AND c.ativa=TRUE WHERE u.id=$1 AND u.ativo=TRUE AND COALESCE(u.owner_id,u.id)=$2",[credentialUserId,user.id]);
  if(!credential.rowCount)return NextResponse.json({detail:"Selecione um colaborador ativo que possua credencial Mix validada."},{status:422});
  const updated = await query("UPDATE public.hermes_api_keys SET credential_owner_id=$1 WHERE owner_id=$2 AND active=TRUE RETURNING id",[credentialUserId,user.id]);
  if(!updated.rowCount)return NextResponse.json({detail:"Gere primeiro uma chave do Hermes."},{status:422});
  return NextResponse.json({ok:true,credential_user_id:credentialUserId,login:credential.rows[0].email});
}

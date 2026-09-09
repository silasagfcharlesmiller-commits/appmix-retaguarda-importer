import { NextRequest, NextResponse } from "next/server";
import { COOKIE_NAME, verifySession } from "@/lib/session";
import { getUser } from "@/lib/users";
import { query } from "@/lib/db";
import { ensureHermesKnowledgeSchema, seedHermesKnowledge } from "@/lib/hermes-knowledge";

async function admin(request: NextRequest) {
  const session = await verifySession(request.cookies.get(COOKIE_NAME)?.value);
  const user = session ? await getUser(session.email) : null;
  if (!user || user.role !== "admin" || user.id !== user.owner_id) return null;
  await ensureHermesKnowledgeSchema(); await seedHermesKnowledge(user.id);
  return user;
}
export async function GET(request: NextRequest) {
  const user = await admin(request); if (!user) return NextResponse.json({detail:"Acesso negado."},{status:403});
  const items=(await query("SELECT id,title,category,content,keywords,active,updated_at FROM public.hermes_knowledge WHERE owner_id=$1 ORDER BY active DESC,category,title",[user.id])).rows;
  return NextResponse.json({items});
}
export async function POST(request: NextRequest) {
  const user=await admin(request); if(!user)return NextResponse.json({detail:"Acesso negado."},{status:403});
  const body=await request.json().catch(()=>({})); const title=String(body.title||"").trim(), content=String(body.content||"").trim();
  if(!title||!content)return NextResponse.json({detail:"Título e conteúdo são obrigatórios."},{status:422});
  const item=(await query("INSERT INTO public.hermes_knowledge(owner_id,title,category,content,keywords) VALUES($1,$2,$3,$4,$5) RETURNING *",[user.id,title,String(body.category||"Geral").trim().slice(0,80),content,String(body.keywords||"").trim()])).rows[0];
  return NextResponse.json(item,{status:201});
}
export async function PATCH(request: NextRequest) {
  const user=await admin(request); if(!user)return NextResponse.json({detail:"Acesso negado."},{status:403}); const body=await request.json().catch(()=>({}));
  const item=(await query("UPDATE public.hermes_knowledge SET title=$1,category=$2,content=$3,keywords=$4,active=$5,updated_at=NOW() WHERE id=$6 AND owner_id=$7 RETURNING *",[String(body.title||"").trim(),String(body.category||"Geral").trim(),String(body.content||"").trim(),String(body.keywords||"").trim(),body.active!==false,Number(body.id),user.id])).rows[0];
  return item?NextResponse.json(item):NextResponse.json({detail:"Item não encontrado."},{status:404});
}
export async function DELETE(request: NextRequest) {
  const user=await admin(request); if(!user)return NextResponse.json({detail:"Acesso negado."},{status:403}); const id=Number(new URL(request.url).searchParams.get("id"));
  await query("DELETE FROM public.hermes_knowledge WHERE id=$1 AND owner_id=$2",[id,user.id]); return NextResponse.json({ok:true});
}

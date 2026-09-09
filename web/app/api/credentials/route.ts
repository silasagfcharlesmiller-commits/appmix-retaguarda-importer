import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { COOKIE_NAME,verifySession } from "@/lib/session";
import { getUser } from "@/lib/users";
import { credentialStatus,saveCredential } from "@/lib/credentials";
async function current(){const s=await verifySession((await cookies()).get(COOKIE_NAME)?.value);return s?getUser(s.email):null;}
export async function GET(){const u=await current();return u?NextResponse.json(await credentialStatus(u)):NextResponse.json({detail:"Sessao expirada"},{status:401});}
export async function PUT(request:Request){const u=await current();if(!u)return NextResponse.json({detail:"Sessao expirada"},{status:401});try{const b=await request.json();return NextResponse.json(await saveCredential(u,String(b.login||""),String(b.password||"")));}catch(e){return NextResponse.json({detail:e instanceof Error?e.message:"Falha ao salvar credencial"},{status:422});}}

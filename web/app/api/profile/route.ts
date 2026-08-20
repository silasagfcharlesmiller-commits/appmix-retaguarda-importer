import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { COOKIE_NAME, createSession, verifySession } from "@/lib/session";
import { getUser, updateUser } from "@/lib/users";

async function sessionUser() { return verifySession((await cookies()).get(COOKIE_NAME)?.value); }

export async function GET() {
  const session = await sessionUser();
  if (!session) return NextResponse.json({ detail:"Sessao expirada" }, { status:401 });
  const user = await getUser(session.email);
  return user ? NextResponse.json(user) : NextResponse.json({ detail:"Usuario nao encontrado" }, { status:404 });
}

export async function PATCH(request: Request) {
  const session = await sessionUser();
  if (!session) return NextResponse.json({ detail:"Sessao expirada" }, { status:401 });
  try {
    const body = await request.json();
    const user = await updateUser(session.email, String(body.login || ""), String(body.senha_atual || ""), body.nova_senha ? String(body.nova_senha) : undefined);
    const response = NextResponse.json(user);
    response.cookies.set(COOKIE_NAME, await createSession(user.email), { httpOnly:true, secure:process.env.NODE_ENV==="production", sameSite:"lax", path:"/", maxAge:8*60*60 });
    return response;
  } catch (error) { return NextResponse.json({ detail:error instanceof Error ? error.message : "Falha ao atualizar perfil" }, { status:422 }); }
}

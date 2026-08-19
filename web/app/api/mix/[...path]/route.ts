import { NextRequest, NextResponse } from "next/server";
import { query, transaction } from "@/lib/db";

export const runtime = "nodejs";
const validStatus = new Set(["pendente", "processando", "concluido", "erro", "cancelado"]);
const digits = (value: unknown) => String(value ?? "").replace(/\D/g, "");

function validCnpj(value: string) {
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

async function forward(request: NextRequest, path: string[]) {
  const baseUrl = process.env.APP_MIX_API_URL?.replace(/\/$/, "");
  const apiKey = process.env.APP_MIX_API_KEY;
  if (!baseUrl || !apiKey) return null;
  const body = request.method === "GET" ? undefined : await request.text();
  const upstream = await fetch(`${baseUrl}/${path.join("/")}${request.nextUrl.search}`, { method: request.method, headers: { "X-API-Key": apiKey, ...(body ? { "Content-Type": "application/json" } : {}) }, body, cache: "no-store", signal: AbortSignal.timeout(30000) });
  return new NextResponse(await upstream.text(), { status: upstream.status, headers: { "Content-Type": upstream.headers.get("content-type") || "application/json" } });
}

async function handler(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  try {
    const proxied = await forward(request, path);
    if (proxied) return proxied;
    if (path[0] !== "v1") return NextResponse.json({ detail: "Rota nao encontrada." }, { status: 404 });

    if (request.method === "GET" && path[1] === "templates") {
      const result = await query("SELECT id, nome, criado_em, atualizado_em FROM public.templates ORDER BY nome");
      return NextResponse.json({ items: result.rows });
    }

    if (request.method === "GET" && path[1] === "jobs" && !path[2]) {
      const status = request.nextUrl.searchParams.get("status");
      const cnpj = digits(request.nextUrl.searchParams.get("cnpj"));
      const limit = Math.min(Math.max(Number(request.nextUrl.searchParams.get("limite")) || 100, 1), 1000);
      const values: unknown[] = [];
      const filters: string[] = [];
      if (status && validStatus.has(status)) { values.push(status); filters.push(`f.status = $${values.length}`); }
      if (cnpj) { values.push(cnpj); filters.push(`f.cnpj = $${values.length}`); }
      values.push(limit);
      const result = await query(`SELECT f.id, f.cnpj, f.status, f.tentativas, f.mensagem_erro, f.criado_em, f.processado_em, t.id AS template_id, t.nome AS template_nome FROM public.fila_execucao f JOIN public.templates t ON t.id=f.template_id ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""} ORDER BY f.id DESC LIMIT $${values.length}`, values);
      return NextResponse.json({ items: result.rows, limite: limit });
    }

    if (request.method === "POST" && path[1] === "lotes" && !path[2]) {
      const body = await request.json();
      const rawCnpjs: unknown[] = Array.isArray(body.cnpjs) ? body.cnpjs : [];
      const cnpjs: string[] = [...new Set(rawCnpjs.map((item) => digits(item)))];
      if (!body.template_id || cnpjs.length < 1 || cnpjs.length > 1000 || cnpjs.some((item) => !validCnpj(item))) return NextResponse.json({ detail: "Confira o template e os CNPJs informados." }, { status: 422 });
      const result = await transaction(async (client) => {
        const templateResult = await client.query("SELECT id, nome FROM public.templates WHERE id=$1", [Number(body.template_id)]);
        if (!templateResult.rowCount) throw new Error("Template nao encontrado.");
        const batchId = crypto.randomUUID();
        await client.query("INSERT INTO public.api_lotes (id,template_id,origem,solicitado_por) VALUES ($1,$2,$3,$4)", [batchId, body.template_id, String(body.origem || "Painel web").slice(0,120), String(body.solicitado_por || "").slice(0,120)]);
        const jobs = [];
        for (const cnpj of cnpjs) {
          let job = (await client.query("SELECT id,status FROM public.fila_execucao WHERE cnpj=$1 AND template_id=$2 AND status IN ('pendente','processando') ORDER BY id DESC LIMIT 1", [cnpj, body.template_id])).rows[0];
          const reused = Boolean(job);
          if (!job) job = (await client.query("INSERT INTO public.fila_execucao (cnpj,template_id) VALUES ($1,$2) RETURNING id,status", [cnpj, body.template_id])).rows[0];
          await client.query("INSERT INTO public.api_lote_jobs (lote_id,job_id) VALUES ($1,$2) ON CONFLICT DO NOTHING", [batchId, job.id]);
          jobs.push({ id: job.id, cnpj, status: job.status, reutilizado: reused });
        }
        return { lote_id: batchId, template: templateResult.rows[0], quantidade: jobs.length, jobs };
      });
      return NextResponse.json(result, { status: 201 });
    }
    return NextResponse.json({ detail: "Rota ainda nao disponivel no modo temporario." }, { status: 404 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Falha interna.";
    return NextResponse.json({ detail: process.env.NODE_ENV === "development" ? message : "Servico temporariamente indisponivel." }, { status: 500 });
  }
}

export const GET = handler;
export const POST = handler;

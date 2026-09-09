import "server-only";
import { query } from "@/lib/db";
import { encryptSecret } from "@/lib/credentials";

export type RetaguardaConnectionInput = {
  nome: string;
  cnpj: string;
  banco_tipo: string;
  host: string;
  porta: number;
  banco_nome: string;
  usuario: string;
  senha?: string;
  machine_id?: string;
  servico?: string;
  servico_mixfiscal?: string;
  tamanho_max_mensagem?: number;
};

let ready: Promise<void> | null = null;
export async function ensureRetaguardaConnections() {
  ready ??= query(`CREATE TABLE IF NOT EXISTS public.template_retaguarda_connections (
    id BIGSERIAL PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES public.web_users(id) ON DELETE CASCADE,
    template_id INTEGER NOT NULL REFERENCES public.templates(id) ON DELETE CASCADE,
    nome VARCHAR(100) NOT NULL,
    cnpj CHAR(14),
    banco_tipo VARCHAR(30) NOT NULL,
    host VARCHAR(255) NOT NULL,
    porta INTEGER NOT NULL,
    banco_nome VARCHAR(150) NOT NULL,
    usuario VARCHAR(150) NOT NULL,
    senha_encrypted TEXT,
    machine_id VARCHAR(180),
    atualizado_por VARCHAR(180) NOT NULL,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(owner_id,template_id)
  );
  ALTER TABLE public.template_retaguarda_connections ALTER COLUMN cnpj DROP NOT NULL;
  ALTER TABLE public.template_retaguarda_connections ADD COLUMN IF NOT EXISTS servico VARCHAR(255);
  ALTER TABLE public.template_retaguarda_connections ADD COLUMN IF NOT EXISTS servico_mixfiscal VARCHAR(180);
  ALTER TABLE public.template_retaguarda_connections ADD COLUMN IF NOT EXISTS tamanho_max_mensagem INTEGER NOT NULL DEFAULT 4`).then(() => undefined).catch((error) => { ready = null; throw error; });
  return ready;
}

export async function getRetaguardaConnection(ownerId: number, templateId: number) {
  await ensureRetaguardaConnections();
  const result = await query(`SELECT nome,cnpj,banco_tipo,host,porta,banco_nome,usuario,machine_id,servico,servico_mixfiscal,tamanho_max_mensagem,
    (senha_encrypted IS NOT NULL) AS senha_cadastrada,atualizado_em
    FROM public.template_retaguarda_connections WHERE owner_id=$1 AND template_id=$2`, [ownerId, templateId]);
  return result.rows[0] || null;
}

export async function saveRetaguardaConnection(ownerId: number, templateId: number, actor: string, input: RetaguardaConnectionInput) {
  await ensureRetaguardaConnections();
  const encrypted = input.senha ? encryptSecret(input.senha) : null;
  await query(`INSERT INTO public.template_retaguarda_connections
    (owner_id,template_id,nome,cnpj,banco_tipo,host,porta,banco_nome,usuario,senha_encrypted,machine_id,servico,servico_mixfiscal,tamanho_max_mensagem,atualizado_por)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    ON CONFLICT(owner_id,template_id) DO UPDATE SET
      nome=EXCLUDED.nome,cnpj=EXCLUDED.cnpj,banco_tipo=EXCLUDED.banco_tipo,host=EXCLUDED.host,
      porta=EXCLUDED.porta,banco_nome=EXCLUDED.banco_nome,usuario=EXCLUDED.usuario,
      senha_encrypted=COALESCE(EXCLUDED.senha_encrypted,template_retaguarda_connections.senha_encrypted),
      machine_id=EXCLUDED.machine_id,servico=EXCLUDED.servico,servico_mixfiscal=EXCLUDED.servico_mixfiscal,
      tamanho_max_mensagem=EXCLUDED.tamanho_max_mensagem,atualizado_por=EXCLUDED.atualizado_por,atualizado_em=NOW()`,
    [ownerId,templateId,input.nome,input.cnpj || null,input.banco_tipo,input.host,input.porta,input.banco_nome,input.usuario,encrypted,input.machine_id || null,input.servico || null,input.servico_mixfiscal || null,input.tamanho_max_mensagem || 4,actor]);
  return getRetaguardaConnection(ownerId, templateId);
}

import { query } from "@/lib/db";

export async function ensureHermesKnowledgeSchema() {
  await query(`CREATE TABLE IF NOT EXISTS public.hermes_knowledge (
    id BIGSERIAL PRIMARY KEY,
    owner_id INTEGER NOT NULL REFERENCES public.web_users(id) ON DELETE CASCADE,
    title VARCHAR(180) NOT NULL,
    category VARCHAR(80) NOT NULL DEFAULT 'Geral',
    content TEXT NOT NULL,
    keywords TEXT NOT NULL DEFAULT '',
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  await query("CREATE INDEX IF NOT EXISTS hermes_knowledge_owner_idx ON public.hermes_knowledge(owner_id,active,updated_at DESC)");
}

export async function seedHermesKnowledge(ownerId: number) {
  const found = await query("SELECT 1 FROM public.hermes_knowledge WHERE owner_id=$1 LIMIT 1", [ownerId]);
  if (found.rowCount) return;
  const defaults = [
    ["Como usar a API App Mix", "Integração", "Consulte /status antes de executar. Use /templates para localizar o template. Operações POST exigem Authorization Bearer, X-Hermes-User e Idempotency-Key único. Acompanhe o resultado em /jobs/{id} ou /lotes/{id}.", "api hermes autenticação fluxo"],
    ["Dados de conexão obrigatórios", "Conexão", "Uma conexão só é válida quando Banco de dados, Usuário do banco e Senha estão preenchidos com valores não vazios. Host e porta preenchidos automaticamente não tornam a conexão válida. Template sem conexão não pode executar a instalação dos dados de conexão.", "banco usuário senha host porta conexão"],
    ["Machine IDs", "Automação", "Um CNPJ pode possuir mais de um machine ID. Configuração XML, dados de conexão e Scheduler devem ser aplicados a todos os IDs encontrados. machine_ids explícitos podem ser enviados quando a filial usa outro CNPJ, sempre com autorização do operador.", "machine id filial cnpj xml scheduler"],
    ["Segurança operacional", "Segurança", "Nunca invente CNPJ, template, machine ID ou job. Confirme os dados com o usuário antes de criar execução. Não repita uma operação: reutilize a mesma Idempotency-Key para a mesma intenção e uma nova chave somente para uma nova intenção.", "segurança confirmação idempotência"],
  ];
  for (const item of defaults) await query("INSERT INTO public.hermes_knowledge(owner_id,title,category,content,keywords) VALUES($1,$2,$3,$4,$5)", [ownerId, ...item]);
}

export async function searchHermesKnowledge(ownerId: number, term: string, limit = 12) {
  const pattern = term.trim().slice(0, 300);
  return (await query(`SELECT id,title,category,content,keywords,updated_at,
    CASE WHEN $2='' THEN 1 ELSE ts_rank_cd(to_tsvector('portuguese',title||' '||category||' '||keywords||' '||content),websearch_to_tsquery('portuguese',$2)) END AS relevance
    FROM public.hermes_knowledge WHERE owner_id=$1 AND active=TRUE
      AND ($2='' OR to_tsvector('portuguese',title||' '||category||' '||keywords||' '||content) @@ websearch_to_tsquery('portuguese',$2))
    ORDER BY relevance DESC,updated_at DESC LIMIT $3`, [ownerId, pattern, Math.min(Math.max(limit, 1), 30)])).rows;
}

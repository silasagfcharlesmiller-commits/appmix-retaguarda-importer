import { NextRequest, NextResponse } from "next/server";
import { query, transaction } from "@/lib/db";
import { authenticateHermes, digits, ensureHermesSchema, validCnpj } from "@/lib/hermes";
import { ensureHermesKnowledgeSchema, searchHermesKnowledge, seedHermesKnowledge } from "@/lib/hermes-knowledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(message: string, status: number, requestId?: string | null) {
  return NextResponse.json({ error: { code: status === 401 ? "unauthorized" : status === 429 ? "rate_limited" : "request_failed", message }, request_id: requestId || undefined }, { status });
}

async function handler(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const endpoint = `/api/hermes/v1/${path.join("/")}`;
  const requestId = request.headers.get("idempotency-key")?.trim().slice(0, 180) || null;
  try {
    await ensureHermesSchema();
    const actor = await authenticateHermes(request);
    if (request.method === "POST" && !request.headers.get("x-hermes-user")?.trim())
      return jsonError("Envie o cabecalho X-Hermes-User com o solicitante da operacao.", 422, requestId);
    const recent = await query<{total:number}>("SELECT COUNT(*)::int AS total FROM public.hermes_api_audit WHERE key_fingerprint=$1 AND created_at>NOW()-INTERVAL '1 minute'", [actor.fingerprint]);
    if (Number(recent.rows[0]?.total) >= 60) return jsonError("Limite temporario de requisicoes excedido.", 429, requestId);

    if (request.method === "GET" && path[0] === "status") {
      const services = await query(`WITH expected(service_name,label) AS (VALUES ('worker_templates','Worker de templates'),('worker_importacoes','Worker de importacao'),('api_automacao','API de automacao')) SELECT e.service_name,e.label,h.host_name,h.version,h.last_seen,COALESCE(h.last_seen>NOW()-INTERVAL '35 seconds',FALSE) AS active FROM expected e LEFT JOIN public.service_heartbeats h USING(service_name) ORDER BY e.service_name`);
      const response = { status: "ok", database: "ok", services: services.rows, checked_at: new Date().toISOString() };
      await audit(request.method, endpoint, actor.requester, actor.fingerprint, 200, { action: "status" }, response, null);
      return NextResponse.json(response);
    }
    if (request.method === "GET" && path[0] === "capabilities") {
      const batchInput = { field:"cnpjs", type:"array", min_items:1, max_items:1000, items:"CNPJ string", behavior:"cria um job independente por CNPJ" };
      const batchRequirements = ["cnpjs (array de 1 a 1000 CNPJs)","Idempotency-Key","X-Hermes-User"];
      const response = { name:"App Mix Master API", version:"1.9.0", knowledge:true, vector_database:false,guide_markdown:"/HERMES_GUIA_MESTRE.md",openapi:"/api/hermes/openapi.json",batch_automation:{supported:true,input:batchInput,multiple_templates:true,multiple_templates_field:"execucoes",rule:"Use cnpjs para um template em vários clientes; use execucoes para relacionar templates diferentes aos respectivos CNPJs.",job_strategy:"um job por combinação de CNPJ e ação",validation_strategy:"isolada por grupo: grupos válidos são enfileirados e grupos inválidos são retornados em bloqueados"},
        operations:[
          {method:"POST",path:"/automacoes",name:"Executar automações em lote",supports_multiple_cnpjs:true,supports_multiple_templates:true,purpose:"Executa cadastro de template, Importar e gravar, XML, conexão e/ou Scheduler.",requires:["cnpjs + acoes; template somente para ações dependentes", "Idempotency-Key","X-Hermes-User"],template_optional_for:["importar_e_gravar"],input:{cnpjs:["09627008000157","52703958000142"],acoes:["importar_e_gravar"]}},
          {method:"GET",path:"/status",name:"Verificar serviços",purpose:"Verifica banco, API e workers; não cria job."},
          {method:"GET",path:"/knowledge?q=texto",name:"Pesquisar conhecimento",purpose:"Consulta regras operacionais; não cria job."},
          {method:"GET",path:"/templates",name:"Listar templates ativos",purpose:"Retorna somente templates disponíveis, nunca arquivados ou excluídos."},
          {method:"GET",path:"/automacoes/opcoes",name:"Listar opções de automação",purpose:"Retorna templates ativos e as ações disponíveis."},
          {method:"GET",path:"/jobs/{job_id}",name:"Consultar job",purpose:"Consulta status e progresso de um job da integração."},
          {method:"GET",path:"/lotes/{lote_id}",name:"Consultar lote",purpose:"Consulta os jobs de um lote da integração."},
          {method:"POST",path:"/lotes",name:"Cadastrar template em lote",supports_multiple_cnpjs:true,purpose:"Aplica um template ativo a um ou vários CNPJs.",requires:["template_id ou template_nome",...batchRequirements]},
          {method:"POST",path:"/importacoes",name:"Importar e gravar em lote",supports_multiple_cnpjs:true,purpose:"Cria um job de importação para cada CNPJ.",requires:batchRequirements},
          {method:"POST",path:"/configuracoes-xml",name:"Configuração XML em lote",supports_multiple_cnpjs:true,purpose:"Aplica o XML cadastrado a cada CNPJ.",requires:["template_id ou template_nome",...batchRequirements]},
          {method:"POST",path:"/conexoes",name:"Instalar dados de conexão em lote",supports_multiple_cnpjs:true,purpose:"Cria um job de conexão por CNPJ quando banco, usuário e senha são válidos.",requires:["template_id ou template_nome",...batchRequirements]},
          {method:"POST",path:"/schedulers",name:"Scheduler em lote",supports_multiple_cnpjs:true,purpose:"Cria um job de Scheduler por CNPJ.",requires:["template_id ou template_nome",...batchRequirements]}
        ],
        rules:["Todas as automações aceitam um ou vários CNPJs no array cnpjs.","Importar e gravar não exige template.","Configuração XML nunca cria Scheduler implicitamente; Scheduler só roda quando estiver em acoes.","Nunca considere template arquivado ou excluído disponível.","Confirme a lista completa de CNPJs e todas as ações antes do POST.","Nunca diga que executou sem resposta 201 com IDs reais."] };
      await audit(request.method,endpoint,actor.requester,actor.fingerprint,200,{action:"capabilities"},response,null);
      return NextResponse.json(response);
    }
    if (request.method === "GET" && path[0] === "knowledge") {
      await ensureHermesKnowledgeSchema(); await seedHermesKnowledge(actor.accountOwnerId);
      const url=new URL(request.url), term=(url.searchParams.get("q")||"").slice(0,300);
      const items=await searchHermesKnowledge(actor.accountOwnerId,term,Number(url.searchParams.get("limit")||12));
      const response={query:term,count:items.length,items};
      await audit(request.method,endpoint,actor.requester,actor.fingerprint,200,{action:"search_knowledge",query:term},{count:items.length},null);
      return NextResponse.json(response);
    }
    if (request.method === "GET" && path[0] === "templates") {
      const items = (await query("SELECT id,nome,atualizado_em FROM public.templates WHERE COALESCE(arquivado,FALSE)=FALSE ORDER BY nome")).rows;
      const response = { items, count:items.length, filter:"active_only" };
      await audit(request.method, endpoint, actor.requester, actor.fingerprint, 200, { action: "list_templates" }, { count: items.length }, null);
      return NextResponse.json(response);
    }
    if (request.method === "GET" && path[0] === "automacoes" && path[1] === "opcoes") {
      const items=(await query(`SELECT t.id,t.nome,
        TRUE AS cadastrar_template,
        COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(s.dados_json->'paths')='array' THEN s.dados_json->'paths' ELSE '[]'::jsonb END)>0,FALSE) AS configuracao_xml,
        CASE WHEN cfg.dados_json->>'modo_regras_fiscais' IN ('automatico','simulacao') THEN cfg.dados_json->>'modo_regras_fiscais' ELSE 'desativado' END AS regras_fiscais_uf,
        COALESCE(cfg.dados_json->'regimes_tributarios',jsonb_build_array(COALESCE(cfg.dados_json->>'regime_tributario','qualquer'))) AS regimes_tributarios,
        EXISTS(SELECT 1 FROM public.template_retaguarda_connections c WHERE c.template_id=t.id AND c.owner_id=$1 AND NULLIF(BTRIM(c.banco_nome),'') IS NOT NULL AND NULLIF(BTRIM(c.usuario),'') IS NOT NULL AND c.senha_encrypted IS NOT NULL) AS dados_conexao,
        COALESCE(NULLIF(BTRIM(s.dados_json->'scheduler'->>'command'),''),'')<>'' AS scheduler
        FROM public.templates t LEFT JOIN public.template_secoes s ON s.template_id=t.id AND s.chave='configuracao_xml'
        LEFT JOIN public.template_secoes cfg ON cfg.template_id=t.id AND cfg.chave='configuracao'
        WHERE COALESCE(t.arquivado,FALSE)=FALSE ORDER BY t.nome`,[actor.accountOwnerId])).rows;
      const response={count:items.length,filter:"active_only",acoes_sem_template:["importar_e_gravar"],items:items.map(item=>({...item,acoes_disponiveis:["cadastrar_template",...(item.configuracao_xml?["configuracao_xml"]:[]),...(item.dados_conexao?["dados_conexao"]:[]),...(item.scheduler?["scheduler"]:[])]}))};
      await audit(request.method,endpoint,actor.requester,actor.fingerprint,200,{action:"list_automation_options"},{count:items.length},null);return NextResponse.json(response);
    }
    if (request.method === "GET" && path[0] === "automacoes" && path.length === 1) {
      const response={endpoint:"/api/hermes/v1/automacoes",options_endpoint:"/api/hermes/v1/automacoes/opcoes",execute_method:"POST",creates_jobs:false,supports_multiple_cnpjs:true,supports_multiple_templates:true,max_cnpjs:1000,max_groups:100,validation_strategy:"por grupo",partial_success:true,job_strategy:"um job por combinação de CNPJ e ação",description:"Importar e gravar aceita somente cnpjs + acoes e não exige template. As outras ações exigem template. Cadastro, divergências, XML e Scheduler são independentes.",required_headers:{Authorization:"Bearer hmx_...","Idempotency-Key":"UUID unico por intencao","X-Hermes-User":"identificacao do solicitante"},import_without_template_body:{cnpjs:["09627008000157","52703958000142"],acoes:["importar_e_gravar"]},simple_body:{template_nome:"ECOCENTAURO LUCRO REAL",cnpjs:["09627008000157","52703958000142"],acoes:["cadastrar_template"]},divergencias_body:{template_nome:"MONALISA LUCRO REAL",cnpjs:["52703958000142"],acoes:["comparar_divergencias"]},multiple_templates_body:{execucoes:[{template_nome:"ECOCENTAURO LUCRO REAL",cnpjs:["09627008000157"],acoes:["cadastrar_template"]},{cnpjs:["52703958000142"],acoes:["importar_e_gravar"]}]},response_statuses:{enfileirado:"todos os grupos válidos",parcial:"grupos válidos enfileirados e inválidos bloqueados",bloqueado:"nenhum grupo válido; HTTP 422"},allowed_actions:["cadastrar_template","comparar_divergencias","importar_e_gravar","configuracao_xml","dados_conexao","scheduler"],rules:["comparar_divergencias nunca altera VIEW/TMP","template é opcional somente quando todas as ações do grupo são importar_e_gravar","configuracao_xml não dispara scheduler","scheduler só é criado quando explicitamente listado em acoes"],note:"Consulte /automacoes/opcoes, confirme o plano completo e envie um único POST."};
      await audit(request.method,endpoint,actor.requester,actor.fingerprint,200,{action:"describe_automations"},{execute_method:"POST"},null);
      return NextResponse.json(response);
    }
    if (request.method === "GET" && path[0] === "jobs" && path[1]) {
      const item = (await query(`SELECT f.id,f.cnpj,f.operacao,f.status,f.tentativas,f.mensagem_erro,f.criado_em,f.processado_em,f.progresso,f.etapa,f.solicitado_por,t.nome AS template_nome FROM public.fila_execucao f LEFT JOIN public.templates t ON t.id=f.template_id WHERE f.id=$1 AND f.credential_owner_id=$2`, [Number(path[1]), actor.ownerId])).rows[0];
      if (!item) return jsonError("Job nao encontrado.", 404, requestId);
      await audit(request.method, endpoint, actor.requester, actor.fingerprint, 200, { action: "get_job", job_id: item.id }, { status: item.status }, null);
      return NextResponse.json(item);
    }
    if (request.method === "GET" && path[0] === "lotes" && path[1]) {
      const lote = (await query(`SELECT l.id,l.criado_em,l.origem,l.solicitado_por,t.id AS template_id,t.nome AS template_nome FROM public.api_lotes l JOIN public.templates t ON t.id=l.template_id WHERE l.id=$1`, [path[1]])).rows[0];
      if (!lote) return jsonError("Lote nao encontrado.", 404, requestId);
      const jobs = (await query(`SELECT f.id,f.cnpj,f.status,f.progresso,f.etapa,f.mensagem_erro FROM public.api_lote_jobs lj JOIN public.fila_execucao f ON f.id=lj.job_id WHERE lj.lote_id=$1 AND f.credential_owner_id=$2 ORDER BY f.id`, [path[1], actor.ownerId])).rows;
      if (!jobs.length) return jsonError("Lote nao pertence a esta integracao.", 404, requestId);
      const response = { ...lote, jobs, quantidade: jobs.length };
      await audit(request.method, endpoint, actor.requester, actor.fingerprint, 200, { action: "get_batch", lote_id: path[1] }, { quantidade: jobs.length }, null);
      return NextResponse.json(response);
    }
    if (request.method === "POST" && path[0] === "automacoes") {
      if (!requestId) return jsonError("Envie o cabecalho Idempotency-Key para evitar execucoes duplicadas.", 422);
      const body=await request.json();
      const allowed=new Set(["cadastrar_template","comparar_divergencias","importar_e_gravar","configuracao_xml","dados_conexao","scheduler"]);
      const rawPlans:Record<string,unknown>[] = Array.isArray(body.execucoes) ? body.execucoes : [body];
      if(rawPlans.length<1||rawPlans.length>100)return jsonError("execucoes deve conter entre 1 e 100 grupos.",422,requestId);
      const plans=rawPlans.map((raw,index)=>{
        const cnpjs:string[]=[...new Set<string>((Array.isArray(raw.cnpjs)?raw.cnpjs:[]).map((item:unknown)=>digits(item)))];
        const actions:string[]=[...new Set<string>((Array.isArray(raw.acoes)?raw.acoes:[]).map((item:unknown)=>String(item||"").trim()))];
        const machineIds=[...new Set<string>((Array.isArray(raw.machine_ids)?raw.machine_ids:[]).map((item:unknown)=>String(item||"").trim()).filter(Boolean))];
        return {index:index+1,template_id:raw.template_id,template_nome:String(raw.template_nome||"").trim(),cnpjs,actions,machineIds,somenteDivergencias:raw.somente_divergencias===true};
      });
      const totalCnpjs=plans.reduce((sum,plan)=>sum+plan.cnpjs.length,0);
      if(totalCnpjs<1||totalCnpjs>1000)return jsonError("O plano deve conter entre 1 e 1000 CNPJs no total.",422,requestId);
      for(const plan of plans){
        if(plan.cnpjs.length<1||plan.cnpjs.some(item=>!validCnpj(item)))return jsonError(`Grupo ${plan.index}: informe CNPJs validos.`,422,requestId);
        if(!plan.actions.length||plan.actions.some(action=>!allowed.has(action)))return jsonError(`Grupo ${plan.index}: informe somente acoes suportadas.`,422,requestId);
        if(plan.actions.some(action=>action!=="importar_e_gravar")&&!plan.template_id&&!plan.template_nome)return jsonError(`Grupo ${plan.index}: informe template_id ou template_nome para as acoes selecionadas. Importar e gravar nao exige template.`,422,requestId);
        if(plan.machineIds.length>20||plan.machineIds.some(item=>!/^[a-zA-Z0-9_-]{16,180}$/.test(item)))return jsonError(`Grupo ${plan.index}: machine_ids deve conter no maximo 20 identificadores validos.`,422,requestId);
      }
      const response=await transaction(async client=>{
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[requestId]);
        const previous=await client.query("SELECT response_json FROM public.hermes_api_audit WHERE request_id=$1 AND response_json IS NOT NULL",[requestId]);
        if(previous.rowCount)return previous.rows[0].response_json;
        const prepared=[];
        const blocked:Record<string,unknown>[]=[];
        for(const plan of plans){
          const needsTemplate=plan.actions.some(action=>action!=="importar_e_gravar");
          if(!needsTemplate){prepared.push({...plan,templateItem:null,xml:{},scheduler:null});continue;}
          const template=plan.template_id?await client.query("SELECT id,nome FROM public.templates WHERE id=$1 AND COALESCE(arquivado,FALSE)=FALSE",[Number(plan.template_id)]):await client.query("SELECT id,nome FROM public.templates WHERE LOWER(nome)=LOWER($1) AND COALESCE(arquivado,FALSE)=FALSE",[plan.template_nome]);
          if(!template.rowCount){blocked.push({grupo:plan.index,template:{id:plan.template_id||null,nome:plan.template_nome||null},cnpjs:plan.cnpjs,acoes:plan.actions,motivos:["Template ativo nao encontrado."]});continue;}
          const templateItem=template.rows[0];
          const section=await client.query("SELECT dados_json FROM public.template_secoes WHERE template_id=$1 AND chave='configuracao_xml'",[templateItem.id]);
          const xml=section.rows[0]?.dados_json||{};const scheduler=xml?.scheduler;
          const motivos:string[]=[];
          if(plan.actions.includes("configuracao_xml")&&(!Array.isArray(xml.paths)||!xml.paths.length))motivos.push("Configuracao XML nao cadastrada.");
          if(plan.actions.includes("scheduler")&&(!scheduler||typeof scheduler!=="object"||!String(scheduler.command||"").trim()))motivos.push("Scheduler nao cadastrado.");
          if(plan.actions.includes("dados_conexao")){
            const connection=await client.query("SELECT 1 FROM public.template_retaguarda_connections WHERE template_id=$1 AND owner_id=$2 AND NULLIF(BTRIM(banco_nome),'') IS NOT NULL AND NULLIF(BTRIM(usuario),'') IS NOT NULL AND senha_encrypted IS NOT NULL",[templateItem.id,actor.accountOwnerId]);
            if(!connection.rowCount)motivos.push("Banco, usuario ou senha nao cadastrados.");
          }
          if(motivos.length){blocked.push({grupo:plan.index,template:templateItem,cnpjs:plan.cnpjs,acoes:plan.actions,motivos});continue;}
          prepared.push({...plan,templateItem,xml,scheduler});
        }
        if(prepared.length){
          await client.query("ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS credential_owner_id INTEGER");
          await client.query("ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS solicitado_por VARCHAR(180)");
          await client.query("ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS operacao VARCHAR(40) NOT NULL DEFAULT 'cadastro_template'");
          await client.query("ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb");
        }
        const operationNames:Record<string,string>={cadastrar_template:"cadastro_template",comparar_divergencias:"comparar_divergencias",importar_e_gravar:"importar_e_gravar",configuracao_xml:"configuracao_xml",dados_conexao:"configuracao_conexao",scheduler:"scheduler"};
        const results=[];
        for(const plan of prepared)for(const action of plan.actions){const operation=(action==="cadastrar_template"&&plan.somenteDivergencias)||action==="comparar_divergencias"?"comparar_divergencias":operationNames[action];let payload:Record<string,unknown>=action==="configuracao_xml"?plan.xml:action==="scheduler"?plan.scheduler:operation==="comparar_divergencias"?{somente_divergencias:true}:{};if(plan.machineIds.length)payload={...payload,machine_ids:plan.machineIds};const jobs=[];
          for(const cnpj of plan.cnpjs){const templateId=action==="importar_e_gravar"?null:(plan.templateItem?.id??null);let job=(await client.query("SELECT id,status FROM public.fila_execucao WHERE cnpj=$1 AND template_id IS NOT DISTINCT FROM $2 AND operacao=$3 AND credential_owner_id=$4 AND status IN ('pendente','processando') AND ($5::jsonb='[]'::jsonb OR COALESCE(payload->'machine_ids','[]'::jsonb)=$5::jsonb) ORDER BY id DESC LIMIT 1",[cnpj,templateId,operation,actor.ownerId,JSON.stringify(plan.machineIds)])).rows[0];const reused=Boolean(job);if(!job)job=(await client.query("INSERT INTO public.fila_execucao(cnpj,template_id,operacao,credential_owner_id,solicitado_por,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id,status",[cnpj,templateId,operation,actor.ownerId,actor.requester,JSON.stringify(payload)])).rows[0];jobs.push({id:job.id,cnpj,status:job.status,reutilizado:reused});}
          results.push({grupo:plan.index,template:plan.templateItem,acao:action,operacao:operation,quantidade:jobs.length,jobs});
        }
        const executionStatus=prepared.length?(blocked.length?"parcial":"enfileirado"):"bloqueado";
        const httpStatus=prepared.length?201:422;
        const result={execution_id:requestId,status:executionStatus,modo:plans.length>1||Array.isArray(body.execucoes)?"plano_multiplo":"lote_simples",quantidade_grupos:plans.length,grupos_enfileirados:prepared.length,grupos_bloqueados:blocked.length,quantidade_jobs:results.reduce((sum,item)=>sum+item.jobs.length,0),resultados:results,bloqueados:blocked};
        await client.query("INSERT INTO public.hermes_api_audit(request_id,method,path,requester,key_fingerprint,status_code,details,response_json,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,NOW())",[requestId,request.method,endpoint,actor.requester,actor.fingerprint,httpStatus,JSON.stringify({groups:plans.map(plan=>({index:plan.index,template_id:plan.template_id,template_nome:plan.template_nome,actions:plan.actions,cnpjs:plan.cnpjs,machine_ids:plan.machineIds}))}),JSON.stringify(result)]);
        return result;
      });
      return NextResponse.json(response,{status:response.status==="bloqueado"?422:201});
    }
    if (request.method === "POST" && ["lotes", "importacoes", "configuracoes-xml", "conexoes", "schedulers"].includes(path[0])) {
      if (!requestId) return jsonError("Envie o cabecalho Idempotency-Key para evitar execucoes duplicadas.", 422);
      const body = await request.json();
      const raw: unknown[] = Array.isArray(body.cnpjs) ? body.cnpjs : [];
      const cnpjs: string[] = [...new Set<string>(raw.map((item) => digits(item)))];
      if (cnpjs.length < 1 || cnpjs.length > 1000 || cnpjs.some((item) => !validCnpj(item))) return jsonError("Informe entre 1 e 1000 CNPJs validos.", 422, requestId);
      const rawMachineIds: unknown[] = Array.isArray(body.machine_ids) ? body.machine_ids : [];
      const machineIds = [...new Set(rawMachineIds.map((item) => String(item || "").trim()).filter(Boolean))];
      if (machineIds.length > 20 || machineIds.some((item) => !/^[a-zA-Z0-9_-]{16,180}$/.test(item)))
        return jsonError("machine_ids deve conter no maximo 20 identificadores validos.", 422, requestId);
      const response = await transaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [requestId]);
        const previous = await client.query("SELECT response_json FROM public.hermes_api_audit WHERE request_id=$1 AND response_json IS NOT NULL", [requestId]);
        if (previous.rowCount) return previous.rows[0].response_json;
        await client.query("ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS credential_owner_id INTEGER");
        await client.query("ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS solicitado_por VARCHAR(180)");
        await client.query("ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS operacao VARCHAR(40) NOT NULL DEFAULT 'cadastro_template'");
        let result: Record<string, unknown>;
        if (path[0] === "lotes") {
          const template = body.template_id ? await client.query("SELECT id,nome FROM public.templates WHERE id=$1 AND COALESCE(arquivado,FALSE)=FALSE", [Number(body.template_id)]) : await client.query("SELECT id,nome FROM public.templates WHERE LOWER(nome)=LOWER($1) AND COALESCE(arquivado,FALSE)=FALSE", [String(body.template_nome || "").trim()]);
          if (!template.rowCount) throw Object.assign(new Error("Template nao encontrado."), { status: 404 });
          const loteId = crypto.randomUUID();
          await client.query("INSERT INTO public.api_lotes(id,template_id,origem,solicitado_por) VALUES($1,$2,'Hermes',$3)", [loteId, template.rows[0].id, actor.requester]);
          const jobs=[];
          for (const cnpj of cnpjs) {
            let job=(await client.query("SELECT id,status FROM public.fila_execucao WHERE cnpj=$1 AND template_id=$2 AND credential_owner_id=$3 AND status IN ('pendente','processando') ORDER BY id DESC LIMIT 1",[cnpj,template.rows[0].id,actor.ownerId])).rows[0];
            const reutilizado=Boolean(job);
            if(!job) job=(await client.query("INSERT INTO public.fila_execucao(cnpj,template_id,operacao,credential_owner_id,solicitado_por) VALUES($1,$2,'cadastro_template',$3,$4) RETURNING id,status",[cnpj,template.rows[0].id,actor.ownerId,actor.requester])).rows[0];
            await client.query("INSERT INTO public.api_lote_jobs(lote_id,job_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[loteId,job.id]);
            jobs.push({id:job.id,cnpj,status:job.status,reutilizado});
          }
          result={lote_id:loteId,template:template.rows[0],quantidade:jobs.length,jobs};
        } else if (path[0] === "importacoes") {
          const jobs=[];
          for(const cnpj of cnpjs){
            let job=(await client.query("SELECT id,status FROM public.fila_execucao WHERE cnpj=$1 AND operacao='importar_e_gravar' AND credential_owner_id=$2 AND status IN ('pendente','processando') ORDER BY id DESC LIMIT 1",[cnpj,actor.ownerId])).rows[0];
            const reutilizado=Boolean(job);
            if(!job) job=(await client.query("INSERT INTO public.fila_execucao(cnpj,template_id,operacao,credential_owner_id,solicitado_por) VALUES($1,NULL,'importar_e_gravar',$2,$3) RETURNING id,status",[cnpj,actor.ownerId,actor.requester])).rows[0];
            jobs.push({id:job.id,cnpj,status:job.status,reutilizado});
          }
          result={operacao:"importar_e_gravar",quantidade:jobs.length,jobs};
        } else {
          const template = body.template_id ? await client.query("SELECT id,nome FROM public.templates WHERE id=$1 AND COALESCE(arquivado,FALSE)=FALSE", [Number(body.template_id)]) : await client.query("SELECT id,nome FROM public.templates WHERE LOWER(nome)=LOWER($1) AND COALESCE(arquivado,FALSE)=FALSE", [String(body.template_nome || "").trim()]);
          if (!template.rowCount) throw Object.assign(new Error("Template nao encontrado."), { status: 404 });
          const operacao = path[0] === "configuracoes-xml" ? "configuracao_xml" : path[0] === "schedulers" ? "scheduler" : "configuracao_conexao";
          let payload: Record<string, unknown> = {};
          if (operacao === "configuracao_xml") {
            const section = await client.query("SELECT dados_json FROM public.template_secoes WHERE template_id=$1 AND chave='configuracao_xml'", [template.rows[0].id]);
            payload = section.rows[0]?.dados_json || {};
            if (!Array.isArray(payload.paths) || payload.paths.length === 0)
              throw Object.assign(new Error("Template sem Configuracao XML cadastrada."), { status: 422 });
          } else if (operacao === "configuracao_conexao") {
            const connection = await client.query("SELECT 1 FROM public.template_retaguarda_connections WHERE template_id=$1 AND owner_id=$2 AND NULLIF(BTRIM(banco_nome),'') IS NOT NULL AND NULLIF(BTRIM(usuario),'') IS NOT NULL AND senha_encrypted IS NOT NULL", [template.rows[0].id, actor.accountOwnerId]);
            if (!connection.rowCount)
              throw Object.assign(new Error("Não é possível rodar a automação pois esse template não possui dados de conexão cadastrados."), { status: 422 });
          } else {
            const section = await client.query("SELECT dados_json FROM public.template_secoes WHERE template_id=$1 AND chave='configuracao_xml'", [template.rows[0].id]);
            const scheduler = section.rows[0]?.dados_json?.scheduler;
            if (!scheduler || typeof scheduler !== "object" || !String(scheduler.command || "").trim())
              throw Object.assign(new Error("Template sem Scheduler cadastrado."), { status: 422 });
            payload = scheduler;
          }
          if (machineIds.length) payload = { ...payload, machine_ids: machineIds };
          await client.query("ALTER TABLE public.fila_execucao ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb");
          const jobs=[];
          for(const cnpj of cnpjs){
            let job=(await client.query("SELECT id,status FROM public.fila_execucao WHERE cnpj=$1 AND operacao=$2 AND credential_owner_id=$3 AND status IN ('pendente','processando') AND ($4::jsonb='[]'::jsonb OR COALESCE(payload->'machine_ids','[]'::jsonb)=$4::jsonb) ORDER BY id DESC LIMIT 1",[cnpj,operacao,actor.ownerId,JSON.stringify(machineIds)])).rows[0];
            const reutilizado=Boolean(job);
            if(!job) job=(await client.query("INSERT INTO public.fila_execucao(cnpj,template_id,operacao,credential_owner_id,solicitado_por,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING id,status",[cnpj,template.rows[0].id,operacao,actor.ownerId,actor.requester,JSON.stringify(payload)])).rows[0];
            jobs.push({id:job.id,cnpj,status:job.status,reutilizado});
          }
          result={operacao,template:template.rows[0],quantidade:jobs.length,jobs};
        }
        await client.query("INSERT INTO public.hermes_api_audit(request_id,method,path,requester,key_fingerprint,status_code,details,response_json,finished_at) VALUES($1,$2,$3,$4,$5,201,$6::jsonb,$7::jsonb,NOW())",[requestId,request.method,endpoint,actor.requester,actor.fingerprint,JSON.stringify({cnpjs,machine_ids:machineIds,action:path[0]}),JSON.stringify(result)]);
        return result;
      });
      return NextResponse.json(response, { status: 201, headers: { "X-Idempotent-Replay": "false" } });
    }
    return jsonError("Rota nao encontrada.", 404, requestId);
  } catch (error) {
    const status = Number((error as {status?:number}).status) || 500;
    const message = error instanceof Error ? error.message : "Falha interna.";
    return jsonError(status >= 500 && process.env.NODE_ENV === "production" ? "Integracao temporariamente indisponivel." : message, status, requestId);
  }
}

async function audit(method:string,path:string,requester:string,fingerprint:string,statusCode:number,details:unknown,response:unknown,requestId:string|null){
  await query("INSERT INTO public.hermes_api_audit(request_id,method,path,requester,key_fingerprint,status_code,details,response_json,finished_at) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,NOW())",[requestId,method,path,requester,fingerprint,statusCode,JSON.stringify(details),JSON.stringify(response)]);
}

export const GET = handler;
export const POST = handler;

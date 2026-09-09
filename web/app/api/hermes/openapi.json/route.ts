import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const security = [{ bearerAuth: [] }];
const errorResponses = {
  "401": { description: "Chave ausente ou inválida", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  "429": { description: "Limite de 60 requisições por minuto excedido", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
  "500": { description: "Integração temporariamente indisponível", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
};
const idempotencyHeaders = [
  { in: "header", name: "Idempotency-Key", required: true, description: "Identificador único da intenção confirmada.", schema: { type: "string", minLength: 8, maxLength: 180 } },
  { in: "header", name: "X-Hermes-User", required: true, description: "Usuário que solicitou a operação.", schema: { type: "string", maxLength: 120 } },
];

export function GET(request: NextRequest) {
  const origin = request.nextUrl.origin;
  return NextResponse.json({
    openapi: "3.1.0",
    info: {
      title: "APP MIX - Gateway Hermes",
      version: "1.9.0",
      description: "API Mestre do Hermes. Consulta conhecimento, lista somente templates ativos, executa cinco automações e acompanha jobs. Não cria, edita ou exclui templates.",
    },
    servers: [{ url: `${origin}/api/hermes/v1`, description: "Ambiente atual" }],
    tags: [{ name: "Automação", description: "Operações implementadas e disponíveis para integração" }],
    components: {
      securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "hmx_..." } },
      schemas: {
        Cnpjs: { type: "array", minItems: 1, maxItems: 1000, uniqueItems: true, description: "Um ou vários CNPJs. Todas as automações criam um job independente para cada CNPJ enviado.", examples: [["09627008000157", "52703958000142"]], items: { type: "string", description: "CNPJ com 14 dígitos ou formatado" } },
        MachineIds: { type: "array", maxItems: 20, uniqueItems: true, description: "IDs adicionais explicitamente autorizados, inclusive de outra filial.", items: { type: "string", minLength: 16, maxLength: 180, pattern: "^[a-zA-Z0-9_-]+$" } },
        AutomationPlan: { type:"object", required:["cnpjs","acoes"], description:"template_id ou template_nome é obrigatório para todas as ações, exceto quando o grupo contém somente importar_e_gravar.", properties:{template_id:{type:"integer"},template_nome:{type:"string"},cnpjs:{$ref:"#/components/schemas/Cnpjs"},acoes:{type:"array",minItems:1,uniqueItems:true,items:{type:"string",enum:["cadastrar_template","comparar_divergencias","importar_e_gravar","configuracao_xml","dados_conexao","scheduler"]}},somente_divergencias:{type:"boolean",default:false,deprecated:true,description:"Compatibilidade: prefira a ação comparar_divergencias."},machine_ids:{$ref:"#/components/schemas/MachineIds"}} },
        Job: { type: "object", properties: { id: { type: "integer" }, cnpj: { type: "string" }, operacao: { type: "string" }, status: { type: "string", enum: ["pendente", "pausado", "processando", "concluido", "erro", "cancelado"] }, progresso: { type: "integer", minimum: 0, maximum: 100 }, etapa: { type: "string" }, mensagem_erro: { type: ["string", "null"] } } },
        Error: { type: "object", required: ["error"], properties: { error: { type: "object", required: ["code", "message"], properties: { code: { type: "string" }, message: { type: "string" } } }, request_id: { type: "string" } } },
      },
    },
    paths: {
      "/automacoes/opcoes": {get:{tags:["Automação"],operationId:"listar_opcoes_automacao",summary:"Lista templates ativos, regimes, modo de regras por UF e ações disponíveis",description:"regras_fiscais_uf=automatico faz o worker usar a UF real de cada CNPJ; desativado preserva o template.",security,responses:{"200":{description:"Matriz de compatibilidade para escolha segura do template"},...errorResponses}}},
      "/automacoes": {
        get: {
          tags: ["Automação"], operationId: "descrever_automacoes",
          summary: "Mostra os formatos de lote simples e plano múltiplo sem criar jobs", security,
          responses: { "200": { description: "Método, cabeçalhos e exemplos com vários CNPJs e templates" }, ...errorResponses },
        },
        post: {
          tags: ["Automação"], operationId: "executar_automacoes",
          summary: "Executa automações para vários CNPJs e templates",
          description: "Aceita um AutomationPlan simples ou até 100 grupos em execucoes. Valida cada grupo separadamente: os válidos criam jobs e os inválidos são devolvidos em bloqueados.",
          security, parameters: idempotencyHeaders,
          requestBody: { required: true, content: { "application/json": {
            schema: { oneOf: [
              { $ref: "#/components/schemas/AutomationPlan" },
              { type: "object", required: ["execucoes"], properties: { execucoes: { type: "array", minItems: 1, maxItems: 100, items: { $ref: "#/components/schemas/AutomationPlan" } } } },
            ] },
            examples: {
              importar_sem_template: { summary: "Importar e gravar não exige template", value: { cnpjs: ["09627008000157", "52703958000142"], acoes: ["importar_e_gravar"] } },
              mesmo_template: { summary: "Um template para dois clientes", value: { template_nome: "ECOCENTAURO LUCRO REAL", cnpjs: ["09627008000157", "52703958000142"], acoes: ["cadastrar_template"] } },
              somente_divergencias: { summary: "Aplicar divergências sem alterar VIEW/TMP", value: { template_nome: "MONALISA LUCRO REAL", cnpjs: ["52703958000142"], acoes: ["comparar_divergencias"] } },
              templates_respectivos: { summary: "Templates diferentes para seus respectivos CNPJs", value: { execucoes: [
                { template_nome: "ECOCENTAURO LUCRO REAL", cnpjs: ["09627008000157"], acoes: ["cadastrar_template"] },
                { template_nome: "VR", cnpjs: ["52703958000142"], acoes: ["cadastrar_template", "configuracao_xml"] },
              ] } },
            },
          } } },
          responses: {
            "201": { description: "Grupos válidos enfileirados. Pode retornar status enfileirado ou parcial, além da lista bloqueados." },
            "404": { description: "Template ativo não encontrado; nenhum job criado" },
            "422": { description: "Nenhum grupo válido; todos são devolvidos em bloqueados e nenhum job é criado" },
            ...errorResponses,
          },
        },
      },
      "/capabilities": { get: { tags: ["Automação"], operationId: "descobrir_capacidades", summary: "Descreve operações, requisitos e regras da API", security, responses: { "200": { description: "Catálogo operacional completo" }, ...errorResponses } } },
      "/knowledge": { get: { tags: ["Automação"], operationId: "pesquisar_conhecimento", summary: "Pesquisa regras e instruções do App Mix", security, parameters: [{ in:"query",name:"q",required:false,schema:{type:"string",maxLength:300} }], responses: { "200": { description: "Conhecimento aplicável" }, ...errorResponses } } },
      "/status": { get: { tags: ["Automação"], operationId: "verificar_servicos", summary: "Verifica banco e workers", security, responses: { "200": { description: "Estado atual dos serviços" }, ...errorResponses } } },
      "/templates": { get: { tags: ["Automação"], operationId: "listar_templates", summary: "Lista somente templates ativos", description: "Templates arquivados ou excluídos são omitidos.", security, responses: { "200": { description: "Templates ativos disponíveis" }, ...errorResponses } } },
      "/lotes": { post: { tags: ["Automação"], operationId: "cadastrar_template_clientes", summary: "Aplica um template existente em clientes", security, parameters: idempotencyHeaders, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["cnpjs"], oneOf: [{ required: ["template_id"] }, { required: ["template_nome"] }], properties: { template_id: { type: "integer" }, template_nome: { type: "string" }, cnpjs: { $ref: "#/components/schemas/Cnpjs" } } } } } }, responses: { "201": { description: "Lote enfileirado" }, "404": { description: "Template não encontrado" }, "422": { description: "Dados ou Idempotency-Key inválidos" }, ...errorResponses } } },
      "/importacoes": { post: { tags: ["Automação"], operationId: "importar_e_gravar", summary: "Executa Importar e Gravar", security, parameters: idempotencyHeaders, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["cnpjs"], properties: { cnpjs: { $ref: "#/components/schemas/Cnpjs" } } } } } }, responses: { "201": { description: "Operações enfileiradas" }, "422": { description: "Dados ou Idempotency-Key inválidos" }, ...errorResponses } } },
      "/configuracoes-xml": { post: { tags: ["Automação"], operationId: "aplicar_configuracao_xml", summary: "Aplica a configuração XML de um template", security, parameters: idempotencyHeaders, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["cnpjs"], oneOf: [{ required: ["template_id"] }, { required: ["template_nome"] }], properties: { template_id: { type: "integer" }, template_nome: { type: "string" }, cnpjs: { $ref: "#/components/schemas/Cnpjs" }, machine_ids: { $ref: "#/components/schemas/MachineIds" } } } } } }, responses: { "201": { description: "Configurações XML enfileiradas" }, "404": { description: "Template não encontrado" }, "422": { description: "Template sem XML ou dados inválidos" }, ...errorResponses } } },
      "/conexoes": { post: { tags: ["Automação"], operationId: "instalar_dados_conexao", summary: "Instala e testa os dados de conexão do robô", security, parameters: idempotencyHeaders, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["cnpjs"], oneOf: [{ required: ["template_id"] }, { required: ["template_nome"] }], properties: { template_id: { type: "integer" }, template_nome: { type: "string" }, cnpjs: { $ref: "#/components/schemas/Cnpjs" }, machine_ids: { $ref: "#/components/schemas/MachineIds" } } } } } }, responses: { "201": { description: "Instalações de conexão enfileiradas" }, "404": { description: "Template não encontrado" }, "422": { description: "Template sem conexão/senha ou dados inválidos" }, ...errorResponses } } },
      "/schedulers": { post: { tags: ["Automação"], operationId: "executar_scheduler", summary: "Executa o Scheduler salvo no template", security, parameters: idempotencyHeaders, requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["cnpjs"], oneOf: [{ required: ["template_id"] }, { required: ["template_nome"] }], properties: { template_id: { type: "integer" }, template_nome: { type: "string" }, cnpjs: { $ref: "#/components/schemas/Cnpjs" }, machine_ids: { $ref: "#/components/schemas/MachineIds" } } } } } }, responses: { "201": { description: "Schedulers enfileirados" }, "404": { description: "Template não encontrado" }, "422": { description: "Template sem Scheduler ou dados inválidos" }, ...errorResponses } } },
      "/lotes/{lote_id}": { get: { tags: ["Automação"], operationId: "consultar_lote", summary: "Consulta um lote", security, parameters: [{ in: "path", name: "lote_id", required: true, schema: { type: "string", format: "uuid" } }], responses: { "200": { description: "Estado do lote" }, "404": { description: "Lote não encontrado" }, ...errorResponses } } },
      "/jobs/{job_id}": { get: { tags: ["Automação"], operationId: "consultar_job", summary: "Consulta um job", security, parameters: [{ in: "path", name: "job_id", required: true, schema: { type: "integer" } }], responses: { "200": { description: "Estado do job", content: { "application/json": { schema: { $ref: "#/components/schemas/Job" } } } }, "404": { description: "Job não encontrado" }, ...errorResponses } } },
    },
  });
}

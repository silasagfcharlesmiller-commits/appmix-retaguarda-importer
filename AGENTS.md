# App Mix — contexto operacional para agentes

## Escopo e ambiente

- Trabalhe sempre a partir desta raiz. Não duplique o projeto em subpastas.
- O desenvolvimento é local. Não há acesso direto à VM; a publicação é manual por cópia de arquivos.
- Não conecte à VM, ao PostgreSQL de produção nem ao portal real sem autorização explícita.
- Preserve arquivos locais sensíveis, especialmente `config_mix.json`, `config_api.json`, `tokens.json`, perfis do Playwright, logs e dados de clientes.

## Arquitetura real

- Aplicação desktop: Python/PyQt6, entrada em `appmix.pyw`.
- Worker: Python, entrada em `worker_mix.py`.
- Automação compartilhada: `automacao_core.py`, `automacao_tabela.py` e `automacao_compara_divergencia.py`.
- API REST: FastAPI em `api_mix.py` e `automacao_api.py`.
- Banco: PostgreSQL por `database.py`; use apenas schemas, queries e modelos existentes.
- Frontend: Next.js 16/React 19 em `web/`. Ao trabalhar ali, também siga `web/AGENTS.md`.
- Integração web/API: rotas em `web/app/api/`; documentação em `API_DOCUMENTACAO.md` e `HERMES_INTEGRACAO.md`.

## Publicação do Integrador e da Vercel

- Antes de alterar ou publicar o Integrador, leia `integrador/PUBLICACAO.md`.
- Execute a publicação sempre na raiz `C:\Users\Hom\Desktop\appmix` com
  `integrador\PUBLICAR_ATUALIZACAO.ps1` e uma versão SemVer superior à atual.
- O comando canônico está documentado em `integrador/PUBLICACAO.md`; não monte o
  manifesto nem copie os executáveis manualmente.
- A aplicação Vercel está em `web/`, embora os vínculos locais também possam existir na
  raiz. O projeto se chama `appmix-retaguarda-importer` e o deploy de produção ocorre pelo
  push da branch `main` no GitHub.
- Antes de qualquer push em `main`, execute `git status --short -- web`. Todo push recompila
  o site completo, inclusive quando o commit altera apenas o Integrador. Se a versão que está
  em produção veio de um deploy local e ainda aparece como modificada ou não rastreada em
  `web`, revise e versione esses arquivos antes do push para não republicar uma versão antiga.
- Os arquivos públicos do atualizador devem permanecer em
  `web/public/integrador-updates/` e o instalador em `web/public/downloads/`.
- Não execute `vercel --prod` na raiz. O `.vercelignore` local exclui executáveis e um
  deploy manual na raiz errada pode publicar o site sem os downloads.
- Depois do push, valide o manifesto e os dois downloads pelos endereços públicos listados
  em `integrador/PUBLICACAO.md`.

## Leitura econômica

- Comece por este arquivo e abra somente os arquivos diretamente ligados à tarefa.
- Use `rg`/`rg --files` com filtros. Não faça varredura em `.git`, `.venv`, `node_modules`, `.next`, `build_api`, `executavel`, `pacote_teste`, `__pycache__`, logs, screenshots ou artefatos de deploy.
- Não leia JSONs grandes por inteiro sem necessidade. Pesquise primeiro pelas chaves relevantes.
- Consulte `README.md` apenas quando precisar do fluxo operacional completo.
- Para Next.js 16, leia somente o guia relevante em `web/node_modules/next/dist/docs/`, conforme `web/AGENTS.md`.

## Regras de alteração

- `automacao_core.py` é compartilhado pela interface e pelo worker; considere ambos ao alterá-lo.
- Não use classes CSS dinâmicas `sc-*` como seletor principal do portal.
- Uma falha na etapa Configuração não deve repetir as oito tabelas já gravadas.
- Interface e worker não podem usar o mesmo `playwright-profile` simultaneamente.
- Mantenha o worker headless por padrão.
- Por padrão, não execute scripts de diagnóstico, migração, enfileiramento, reprocessamento, conclusão, cancelamento ou remoção de jobs: eles podem alterar produção.
- O acesso à VM, ao PostgreSQL de produção, ao portal real e a execução da automação real são permitidos somente quando o usuário autorizar explicitamente a ação e identificar o ambiente e o alvo (por exemplo: job, CNPJ, serviço ou cliente).
- Para ações que alterem produção, trate a autorização como pontual: confirme o job/CNPJ exato, execute somente o necessário para esse alvo e relate o resultado. Uma autorização genérica ou anterior não vale para outros clientes, jobs ou ações futuras.
- Não faça operações destrutivas, migrações amplas, reprocessamento em massa nem remoção de dados sem uma autorização específica para essa operação. Sempre prefira primeiro consultas de diagnóstico somente leitura, validações estáticas e testes unitários isolados.
- Uma solicitação para editar este arquivo não autoriza, por si só, acesso externo nem alteração de jobs; a ação operacional deve ser solicitada separadamente.

## Validação mínima

- Python alterado: `python -m py_compile <arquivos>`.
- JSON alterado: validar parse sem imprimir segredos.
- Frontend alterado: em `web/`, executar a checagem mais específica disponível e `npm run build` quando proporcional ao risco.
- Preserve mudanças preexistentes e não inclua credenciais em commits ou respostas.

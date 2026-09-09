<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Deploy deste projeto

- A raiz da aplicação Next.js na Vercel é esta pasta `web`.
- O projeto vinculado se chama `appmix-retaguarda-importer`.
- O deploy de produção é disparado pelo push da branch `main`; não execute
  `vercel --prod` a partir da raiz do repositório.
- Antes de qualquer push em `main`, confira `git status --short -- web`. Um commit de outra
  área também dispara um rebuild completo; código local do site ainda não rastreado será
  substituído pela versão antiga do GitHub no novo deploy.
- O atualizador do Integrador depende dos arquivos rastreados em
  `public/integrador-updates/` e `public/downloads/`. Preserve esses diretórios no build.
- Para publicar uma nova versão do Integrador, siga `../integrador/PUBLICACAO.md` e rode o
  script a partir da raiz do repositório.

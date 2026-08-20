# APP MIX Web

Painel Next.js para criar e acompanhar lotes processados pelo worker Python.

## Desenvolvimento local

1. Execute `npm install`.
2. Execute `npm run dev`.
3. Abra `http://localhost:3000`.
4. Use o mesmo usuário e senha cadastrados para o painel web.

Em modo local, o banco e lido de `../config_mix.json`. O primeiro usuário é
criado em produção pelas variáveis administrativas e depois pode alterar nome
e senha na tela Perfil. O login local usa esse mesmo usuário salvo no banco.

Sem `APP_MIX_API_URL`, as rotas de servidor usam `DATABASE_URL` diretamente.
Quando o FastAPI estiver publicado na VM, informe `APP_MIX_API_URL` e
`APP_MIX_API_KEY`; o painel passara a encaminhar as chamadas para ele.

## Vercel

Crie o projeto com a pasta raiz `web` e cadastre as variaveis de
`.env.example` em Settings > Environment Variables. Nunca envie `.env.local`,
`config_mix.json` ou `config_api.json` ao repositorio.

O worker permanece separado e pode ser iniciado no notebook por
`INICIAR_WORKER_API.bat`. O notebook deve ficar ligado e sem suspensao.

# CrediControle web: como rodar e publicar

App Node.js + Express. Banco **PostgreSQL** quando existe `DATABASE_URL`. Sem ela, usa um Postgres
embutido (PGlite) que grava na pasta `PGLITE_DIR` (padrão `./dados`).

O que tem:
- `/`: o sistema (pede login).
- `/login`: entrada.
- `/usuarios`: só para administradores. Cadastrar operadores, desativar, trocar senha.
- `/cadastro`: **formulário público de pré-cadastro**. O que a pessoa envia cai em *Pré-cadastro* com origem "Link". Use `/cadastro?f=GC12` para registrar de qual franquia veio.

A tela principal é `app/credicontrole.html`, a mesma da versão do claude.ai. Daqui para frente, **esta é a versão
oficial**: o link do claude.ai fica só como protótipo.

## Rodar no computador

```bash
npm install
cp .env.example .env      # ajuste os valores; sem DATABASE_URL usa o banco embutido em ./dados
npm run dev               # http://localhost:3300
npm test                  # testes da API (sobe um servidor com banco em memória)
```

O primeiro administrador é criado no início, a partir de `ADMIN_EMAIL` e `ADMIN_SENHA`, **só se ainda não
existir nenhum usuário**.

## Publicar (Render, como o CLAUDIM)

1. Crie um repositório no GitHub só com esta pasta (`web/`):
   ```bash
   git init && git add . && git commit -m "CrediControle web"
   ```
   O `.gitignore` já deixa de fora `.env`, `dados/` e `node_modules/`.
2. **Banco**: crie um PostgreSQL. O Render Postgres grátis **expira em 30 dias**. Para não perder dados, use um
   plano pago ou o **Neon** (grátis, não expira). Copie a *connection string*.
3. Na Render: **New → Web Service** a partir do repositório. Ela detecta o `Dockerfile`.
4. Variáveis de ambiente:

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | connection string do Postgres |
   | `PGSSL` | `1` (Render, Neon e Supabase exigem SSL) |
   | `SESSION_SECRET` | texto longo e aleatório (trocar derruba todas as sessões) |
   | `ADMIN_EMAIL` / `ADMIN_SENHA` | primeiro administrador (senha com 8+ caracteres) |

5. Deploy. Teste em `https://seu-app.onrender.com/saude` (deve responder `{"ok":true}`).

> A Render grátis "dorme" depois de ~15 min sem acesso, e o primeiro acesso demora uns segundos. Para não
> dormir: plano pago, ou **Koyeb** (mesmos passos).

### Servidor próprio (VPS)

```bash
docker build -t credicontrole .
docker run -d --restart=always -p 3300:3300 --env-file .env credicontrole
```

Coloque **HTTPS** na frente (Caddy ou Nginx). Em produção o cookie de login só trafega por HTTPS.

Para não manter um Postgres, deixe `DATABASE_URL` vazio e aponte `PGLITE_DIR` para um disco persistente
(`-v /srv/credicontrole:/dados -e PGLITE_DIR=/dados`). Serve para uma carteira pequena. Para fazer backup, copie
a pasta com o app parado.

## Primeiro acesso

1. Entre com o administrador e troque a senha em **Usuários → Nova senha**.
2. Cadastre os operadores em **Usuários**.
3. Em **Configurações**, preencha **"Nome da empresa no formulário público"** e, se quiser, o texto de
   privacidade. A LGPD exige que a pessoa saiba quem recebe os dados.
4. **Copiar link de pré-cadastro** fica no rodapé do menu. Mande para os clientes, acrescentando `?f=` com a franquia se quiser.
5. Apague os dados de teste, se tiver usado o banco embutido para testar.

## Backup

No Postgres:
```bash
pg_dump "$DATABASE_URL" > backup-$(date +%F).sql
```
Faça isso pelo menos uma vez por semana. Os planos pagos da Render e do Neon também têm backup automático.

## Ainda não feito

- **Importador CSV** do sistema atual (aguardando os arquivos exportados).
- Envio de foto do documento no pré-cadastro.
- Franquias com permissão separada (hoje todo usuário vê a carteira inteira).

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
   | `DATABASE_URL` | connection string do Postgres. No Neon, troque `sslmode=require` por `sslmode=verify-full` |
   | `PGSSL` | deixe vazio se a string já tem `sslmode=verify-full` (Neon); `1` só se o banco exige SSL e a string não diz nada |
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

1. Entre com o administrador. O sistema pede para trocar a senha inicial (a das variáveis do servidor) antes de continuar.
2. Cadastre os operadores em **Usuários** com uma senha provisória. Cada um troca a dele no primeiro acesso.
3. Em **Configurações**, preencha **"Nome da empresa no formulário público"** e, se quiser, o texto de
   privacidade. A LGPD exige que a pessoa saiba quem recebe os dados.
4. **Copiar link de pré-cadastro** fica no rodapé do menu. Mande para os clientes, acrescentando `?f=` com a franquia se quiser.
5. Apague os dados de teste, se tiver usado o banco embutido para testar.

## Segurança

- **Papéis:** o *operador* cadastra clientes, cria contratos e registra pagamentos. Só o *administrador* exclui,
  estorna, cancela contrato, mexe em Configurações, gerencia usuários, vê a auditoria e baixa a cópia de segurança.
  O servidor recusa essas ações, não só a tela.
- **Auditoria** (menu → Auditoria): quem criou, alterou ou excluiu o quê, quando e de qual IP, com o valor antes e
  depois. Também registra logins (inclusive os recusados), trocas de senha, cópias baixadas e pré-cadastros pelo link.
- **Senhas:** guardadas com scrypt. Trocar a senha (menu → Minha senha) derruba os logins abertos nos outros
  aparelhos. Senha definida pelo administrador é provisória: a pessoa troca no próximo acesso.
- **Navegador:** HTTPS obrigatório (HSTS), scripts só do próprio servidor (CSP com nonce), sem moldura de outros
  sites e sem cache nas respostas da API.
- **Ao atualizar para esta versão** todos precisam entrar de novo, e os usuários que já existiam são obrigados a
  trocar a senha.

## Lembretes de vencimento no WhatsApp

Todo dia, às 9h, o sistema avisa os clientes dos vencimentos (por padrão, um dia antes e no dia) pela **API oficial
do WhatsApp (Meta)**. Cada aviso sai uma vez só, e quem não quer receber fica de fora. A tela é **menu → Lembretes
no WhatsApp** (só administrador): mostra o que sai hoje e o histórico, e tem um botão para enviar na hora.

1. **Número na API oficial.** No Meta Business (o mesmo processo do CLAUDIM), ligue um número à WhatsApp Cloud
   API e anote o **Phone Number ID**. Gere um **token permanente** (usuário do sistema com permissão
   `whatsapp_business_messaging`).
2. **Mensagem modelo.** Para mandar mensagem sem o cliente ter escrito antes, a Meta exige um modelo aprovado. No
   WhatsApp Manager → *Modelos de mensagem* → *Criar*:
   - Categoria **Utilidade**, idioma **Português (BR)**, nome `lembrete_vencimento`.
   - Corpo com **3 variáveis, nesta ordem**: primeiro nome, valor e data. Exemplo:
     > Olá {{1}}, passando para lembrar que o seu pagamento de {{2}} vence em {{3}}. Se já pagou, desconsidere.
   - O valor é o da parcela. Nos contratos de saldo devedor, é o total para quitar na data do vencimento.
3. **Variáveis na Render** (Environment):

   | Variável | Valor |
   |---|---|
   | `WHATSAPP_PHONE_NUMBER_ID` | o Phone Number ID |
   | `WHATSAPP_TOKEN` | o token permanente |
   | `WHATSAPP_TEMPLATE` | `lembrete_vencimento` (o nome do modelo) |
   | `WHATSAPP_TEMPLATE_LANG` | `pt_BR` (opcional; é o padrão) |
   | `CRON_TOKEN` | texto longo e aleatório (o mesmo do passo 4) |

4. **Agendamento diário** (GitHub Actions, já está no repositório em `.github/workflows/lembretes.yml`). No GitHub
   → *Settings → Secrets and variables → Actions*, crie os secrets `APP_URL` (ex.: `https://credicontrole.onrender.com`)
   e `CRON_TOKEN` (o mesmo valor da Render). Para testar, vá em *Actions → Lembretes de vencimento → Run workflow*.
5. **Ligar** em menu → Lembretes no WhatsApp: marque "Enviar os lembretes automaticamente" e escolha os dias
   (`1, 0` = véspera e dia; acrescente `-3` para avisar três dias depois do vencimento).

**Consentimento:** a Meta exige que o cliente tenha aceitado receber mensagens. O formulário público pergunta, e quem
não marcar fica como "não quer lembretes". Para os clientes antigos, use a caixa *"Não mandar lembretes de
vencimento pelo WhatsApp"* na ficha do cliente.

## Backup

Pelo próprio sistema: menu → **Baixar cópia de segurança** (só administrador) gera um arquivo JSON com a carteira
inteira. Guarde num lugar seguro, porque ele tem dados pessoais.

No Postgres:
```bash
pg_dump "$DATABASE_URL" > backup-$(date +%F).sql
```
Faça isso pelo menos uma vez por semana. Os planos pagos da Render e do Neon também têm backup automático.

## Ainda não feito

- **Importador CSV** do sistema atual (aguardando os arquivos exportados).
- Envio de foto do documento no pré-cadastro.
- Franquias com permissão separada (hoje todo usuário vê a carteira inteira).

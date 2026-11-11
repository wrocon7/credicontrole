// Banco: PostgreSQL. Os dados da carteira ficam como documentos JSON (coleção + id), no mesmo formato da
// versão do claude.ai, para a mesma tela funcionar nos dois lugares. Cada gravação recebe um número de versão
// crescente, e a tela pede só o que mudou desde a última versão que viu.
import pg from "pg";

// avisos = lembretes de vencimento mandados à mão pela tela (quem avisou e quando)
export const COLECOES = new Set(["clientes", "contratos", "transacoes", "config", "avisos"]);

// Com DATABASE_URL usa o PostgreSQL de verdade. Sem ela, um Postgres embutido (PGlite) que grava na pasta
// PGLITE_DIR (padrão ./dados; ":memory:" para não gravar) — bom para testar ou para um servidor pequeno com disco.
export const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.PGSSL === "1" ? { rejectUnauthorized: false } : undefined, max: 10 })
  : await poolEmbutido(process.env.PGLITE_DIR || "./dados");

async function poolEmbutido(pasta) {
  const { PGlite } = await import("@electric-sql/pglite");
  const lite = new PGlite(pasta === ":memory:" ? undefined : pasta);
  console.log("Banco embutido (PGlite):", pasta);
  // Uma sessão só: tudo passa por uma fila, e uma transação segura a fila até o release().
  let fila = Promise.resolve();
  const vez = () => { let solta; const antes = fila; fila = new Promise(r => (solta = r)); return antes.then(() => solta); };
  const roda = async (sql, params = []) => {
    // objetos viram JSON (colunas jsonb); listas seguem como array do Postgres (ex.: "= any($1)")
    const r = await lite.query(sql, params.map(p => (p !== null && typeof p === "object" && !Array.isArray(p) ? JSON.stringify(p) : p)));
    return { rows: r.rows, rowCount: r.affectedRows || r.rows.length }; // SELECT vem com affectedRows = 0
  };
  return {
    query: async (sql, params) => { const solta = await vez(); try { return await roda(sql, params); } finally { solta(); } },
    connect: async () => { const solta = await vez(); return { query: roda, release: solta }; },
  };
}

const existe = async nome => (await pool.query("select to_regclass($1) is not null as e", [nome])).rows[0].e;

export async function migrar() {
  if (!(await existe("docs_versao"))) await pool.query("create sequence docs_versao");
  await pool.query(`create table if not exists docs(
    colecao text not null, id text not null, dados jsonb not null default '{}',
    excluido boolean not null default false, versao bigint not null default nextval('docs_versao'),
    atualizado timestamptz not null default now(), primary key (colecao, id))`);
  if (!(await existe("docs_versao_idx"))) await pool.query("create index docs_versao_idx on docs(versao)");
  await pool.query(`create table if not exists usuarios(
    id serial primary key, email text not null unique, nome text not null, senha text not null,
    papel text not null default 'operador', ativo boolean not null default true,
    criado timestamptz not null default now())`);
  // sessao_versao: sobe a cada troca de senha e derruba os logins antigos. trocar_senha: obriga a trocar no próximo acesso.
  await pool.query("alter table usuarios add column if not exists sessao_versao integer not null default 1");
  const tinhaTroca = (await pool.query("select 1 from information_schema.columns where table_name = 'usuarios' and column_name = 'trocar_senha'")).rowCount > 0;
  await pool.query("alter table usuarios add column if not exists trocar_senha boolean not null default false");
  // quem existia antes desta versão nunca trocou a senha inicial (a do administrador está nas variáveis do servidor)
  if (!tinhaTroca) await pool.query("update usuarios set trocar_senha = true");
  // um registro por lembrete (contrato + parcela + vencimento + dia do aviso): garante que ninguém recebe duas vezes
  await pool.query(`create table if not exists lembretes(
    chave text primary key, quando timestamptz not null default now(), contrato_id text, cliente_id text, nome text,
    telefone text, valor numeric, vencimento text, status text not null, erro text, wamid text)`);
  await pool.query(`create table if not exists auditoria(
    id bigserial primary key, quando timestamptz not null default now(), usuario_id integer, usuario text,
    acao text not null, colecao text, doc_id text, antes jsonb, depois jsonb, ip text)`);
}

// desde = última versão que a tela já tem; 0 = tudo (sem os excluídos).
// A versão máxima é lida antes da lista: o que for gravado no meio vem de novo na próxima busca, sem perda.
// A busca por mudanças repete o que foi alterado nos últimos 20 segundos: uma gravação pode pegar um número de
// versão e só ser confirmada depois de outra com número maior; sem a repetição, ela nunca chegaria às telas
// abertas. A tela ignora o que já tem na mesma versão.
export async function listar(desde) {
  const versao = Number((await pool.query("select coalesce(max(versao), 0) as m from docs")).rows[0].m);
  const r = desde > 0
    ? await pool.query("select colecao, id, dados, excluido, versao from docs where versao > $1 or atualizado > now() - interval '20 seconds' order by versao", [desde])
    : await pool.query("select colecao, id, dados, excluido, versao from docs where not excluido order by versao");
  return { versao, docs: r.rows.map(d => ({ ...d, versao: Number(d.versao) })) };
}

export async function ler(colecao, id) {
  return (await lerDoc(colecao, id))?.dados ?? null;
}

// Roda `fn` dentro de uma transação: ou todas as gravações entram, ou nenhuma. `fn` recebe a conexão e a repassa
// como último argumento (`q`) para lerDoc, gravar e excluir.
export async function emTransacao(fn) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const r = await fn(c);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// O documento com a versão em que está: quem grava devolve essa versão para provar que ninguém mexeu no meio.
export async function lerDoc(colecao, id, q = pool) {
  const r = await q.query("select dados, versao from docs where colecao = $1 and id = $2 and not excluido", [colecao, id]);
  return r.rows[0] ? { dados: r.rows[0].dados, versao: Number(r.rows[0].versao) } : null;
}

// Grava o documento inteiro e devolve a nova versão. Com `seVersao`, só grava se o documento ainda estiver nessa
// versão; se outra pessoa gravou antes, lança um erro com `conflito: true` e nada muda.
export async function gravar(colecao, id, dados, seVersao = null, q = pool) {
  if (seVersao) {
    const r = await q.query(
      "update docs set dados = $3, versao = nextval('docs_versao'), atualizado = now() where colecao = $1 and id = $2 and versao = $4 and not excluido returning versao",
      [colecao, id, dados, seVersao]);
    if (!r.rowCount) throw Object.assign(new Error("O documento mudou desde a leitura."), { conflito: true });
    return Number(r.rows[0].versao);
  }
  const r = await q.query(
    `insert into docs (colecao, id, dados) values ($1, $2, $3)
     on conflict (colecao, id) do update set dados = excluded.dados, excluido = false, versao = nextval('docs_versao'), atualizado = now()
     returning versao`, [colecao, id, dados]);
  return Number(r.rows[0].versao);
}

// Exclusão lógica: a linha fica marcada para as telas abertas saberem que o documento sumiu.
export async function excluir(colecao, id, q = pool) {
  await q.query("update docs set excluido = true, dados = '{}', versao = nextval('docs_versao'), atualizado = now() where colecao = $1 and id = $2",
    [colecao, id]);
}

export async function todosDocs() {
  return (await pool.query("select colecao, id, dados from docs where not excluido order by colecao, id")).rows;
}

export async function clientePorCpf(cpfDigitos) {
  const r = await pool.query(
    "select id, dados from docs where colecao = 'clientes' and not excluido and regexp_replace(dados->>'cpf', '[^0-9]', '', 'g') = $1 limit 1",
    [cpfDigitos]);
  return r.rows[0] ? { id: r.rows[0].id, ...r.rows[0].dados } : null;
}

export async function auditar({ usuario, acao, colecao = null, id = null, antes = null, depois = null, ip = null }) {
  await pool.query("insert into auditoria (usuario_id, usuario, acao, colecao, doc_id, antes, depois, ip) values ($1, $2, $3, $4, $5, $6, $7, $8)",
    [usuario?.id ?? null, usuario ? `${usuario.nome} <${usuario.email}>` : null, acao, colecao, id, antes, depois, ip]);
}

// Mais recentes primeiro, 100 por página; `antesDe` = id do último registro já mostrado.
export async function listarAuditoria({ antesDe, usuarioId, colecao, busca }) {
  const onde = [], p = [];
  if (antesDe) { p.push(antesDe); onde.push(`id < $${p.length}`); }
  if (usuarioId) { p.push(usuarioId); onde.push(`usuario_id = $${p.length}`); }
  if (colecao) { p.push(colecao); onde.push(`colecao = $${p.length}`); }
  if (busca) { p.push(`%${busca}%`); onde.push(`(doc_id ilike $${p.length} or acao ilike $${p.length} or antes::text ilike $${p.length} or depois::text ilike $${p.length})`); }
  const r = await pool.query(`select id, quando, usuario_id, usuario, acao, colecao, doc_id, antes, depois, ip from auditoria
    ${onde.length ? "where " + onde.join(" and ") : ""} order by id desc limit 100`, p);
  return r.rows.map(x => ({ ...x, id: Number(x.id) }));
}

export const lembretes = {
  // Reserva o lembrete para envio. Devolve false se já foi enviado (ou está sendo). Tenta de novo o que deu erro e o
  // que ficou parado em "enviando" há mais de 15 minutos (o servidor caiu no meio do envio).
  reservar: async l => (await pool.query(
    `insert into lembretes (chave, contrato_id, cliente_id, nome, telefone, valor, vencimento, status) values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (chave) do update set status = excluded.status, quando = now(), erro = null
     where lembretes.status = 'erro' or (lembretes.status = 'enviando' and lembretes.quando < now() - interval '15 minutes') returning chave`,
    [l.chave, l.contratoId, l.clienteId, l.nome, l.telefone, l.valor, l.venc, l.status])).rowCount > 0,
  concluir: async (chave, { status, erro = null, wamid = null }) =>
    pool.query("update lembretes set status = $2, erro = $3, wamid = $4, quando = now() where chave = $1", [chave, status, erro, wamid]),
  situacao: async chaves => chaves.length
    ? Object.fromEntries((await pool.query("select chave, status, erro from lembretes where chave = any($1)", [chaves])).rows.map(r => [r.chave, r]))
    : {},
  recentes: async () => (await pool.query("select chave, quando, nome, telefone, valor, vencimento, status, erro from lembretes order by quando desc limit 100")).rows
    .map(r => ({ ...r, valor: r.valor === null ? null : Number(r.valor) })),
};

export const usuarios = {
  contar: async () => Number((await pool.query("select count(*) as n from usuarios")).rows[0].n),
  porEmail: async email => (await pool.query("select * from usuarios where lower(email) = lower($1)", [email])).rows[0] || null,
  porId: async id => (await pool.query("select * from usuarios where id = $1", [id])).rows[0] || null,
  listar: async () => (await pool.query("select id, email, nome, papel, ativo, trocar_senha, criado from usuarios order by nome")).rows,
  criar: async ({ email, nome, senha, papel, trocarSenha = true }) =>
    (await pool.query("insert into usuarios (email, nome, senha, papel, trocar_senha) values ($1, $2, $3, $4, $5) returning id",
      [email, nome, senha, papel, trocarSenha])).rows[0].id,
  // campos vêm só do servidor (lista fechada de colunas); `derrubarSessoes` invalida os logins abertos
  alterar: async (id, campos, derrubarSessoes = false) => {
    const ks = Object.keys(campos), sets = ks.map((k, i) => `${k} = $${i + 2}`);
    if (derrubarSessoes) sets.push("sessao_versao = sessao_versao + 1");
    if (!sets.length) return;
    await pool.query(`update usuarios set ${sets.join(", ")} where id = $1`, [id, ...ks.map(k => campos[k])]);
  },
};

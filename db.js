// Banco: PostgreSQL. Os dados da carteira ficam como documentos JSON (coleção + id), no mesmo formato da
// versão do claude.ai, para a mesma tela funcionar nos dois lugares. Cada gravação recebe um número de versão
// crescente, e a tela pede só o que mudou desde a última versão que viu.
import pg from "pg";

export const COLECOES = new Set(["clientes", "contratos", "transacoes", "config"]);

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
    const r = await lite.query(sql, params.map(p => (p !== null && typeof p === "object" ? JSON.stringify(p) : p)));
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
}

// desde = última versão que a tela já tem; 0 = tudo (sem os excluídos).
// A versão máxima é lida antes da lista: o que for gravado no meio vem de novo na próxima busca, sem perda.
export async function listar(desde) {
  const versao = Number((await pool.query("select coalesce(max(versao), 0) as m from docs")).rows[0].m);
  const r = desde > 0
    ? await pool.query("select colecao, id, dados, excluido from docs where versao > $1 order by versao", [desde])
    : await pool.query("select colecao, id, dados, excluido from docs where not excluido order by versao");
  return { versao, docs: r.rows };
}

export async function ler(colecao, id) {
  const r = await pool.query("select dados from docs where colecao = $1 and id = $2 and not excluido", [colecao, id]);
  return r.rows[0]?.dados ?? null;
}

export async function gravar(colecao, id, dados) {
  const r = await pool.query(
    "update docs set dados = $3, excluido = false, versao = nextval('docs_versao'), atualizado = now() where colecao = $1 and id = $2",
    [colecao, id, dados]);
  if (r.rowCount) return;
  try {
    await pool.query("insert into docs (colecao, id, dados) values ($1, $2, $3)", [colecao, id, dados]);
  } catch (e) {
    if (e.code !== "23505") throw e; // outro pedido criou o mesmo documento ao mesmo tempo
    return gravar(colecao, id, dados);
  }
}

// Troca só os campos enviados (nível de cima), como o update do claude.ai. Devolve false se o documento não existe.
export async function mesclar(colecao, id, campos) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const r = await c.query("select dados from docs where colecao = $1 and id = $2 and not excluido for update", [colecao, id]);
    if (!r.rowCount) { await c.query("rollback"); return false; }
    await c.query("update docs set dados = $3, versao = nextval('docs_versao'), atualizado = now() where colecao = $1 and id = $2",
      [colecao, id, { ...r.rows[0].dados, ...campos }]);
    await c.query("commit");
    return true;
  } catch (e) {
    await c.query("rollback").catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

// Exclusão lógica: a linha fica marcada para as telas abertas saberem que o documento sumiu.
export async function excluir(colecao, id) {
  await pool.query("update docs set excluido = true, dados = '{}', versao = nextval('docs_versao'), atualizado = now() where colecao = $1 and id = $2",
    [colecao, id]);
}

export async function clientePorCpf(cpfDigitos) {
  const r = await pool.query(
    "select id, dados from docs where colecao = 'clientes' and not excluido and regexp_replace(dados->>'cpf', '[^0-9]', '', 'g') = $1 limit 1",
    [cpfDigitos]);
  return r.rows[0] ? { id: r.rows[0].id, ...r.rows[0].dados } : null;
}

export const usuarios = {
  contar: async () => Number((await pool.query("select count(*) as n from usuarios")).rows[0].n),
  porEmail: async email => (await pool.query("select * from usuarios where lower(email) = lower($1)", [email])).rows[0] || null,
  porId: async id => (await pool.query("select * from usuarios where id = $1", [id])).rows[0] || null,
  listar: async () => (await pool.query("select id, email, nome, papel, ativo, criado from usuarios order by nome")).rows,
  criar: async ({ email, nome, senha, papel }) =>
    (await pool.query("insert into usuarios (email, nome, senha, papel) values ($1, $2, $3, $4) returning id", [email, nome, senha, papel])).rows[0].id,
  alterar: async (id, campos) => {
    const ks = Object.keys(campos);
    if (!ks.length) return;
    await pool.query(`update usuarios set ${ks.map((k, i) => `${k} = $${i + 2}`).join(", ")} where id = $1`, [id, ...ks.map(k => campos[k])]);
  },
};

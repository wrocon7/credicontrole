// Testa a API de ponta a ponta: sobe o servidor com banco embutido em memória, faz as chamadas e derruba.
// Uso: npm test
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORTA = 3399, BASE = `http://127.0.0.1:${PORTA}`;
const senhaNova = () => crypto.randomBytes(9).toString("base64url");
const ADMIN = { email: "admin@teste.local", senha: senhaNova() };
const srv = spawn(process.execPath, ["server.js"], {
  cwd: raiz,
  env: { ...process.env, DATABASE_URL: "", PGLITE_DIR: ":memory:", PORT: String(PORTA), SESSION_SECRET: crypto.randomBytes(16).toString("hex"), ADMIN_EMAIL: ADMIN.email, ADMIN_SENHA: ADMIN.senha },
});
let saida = "";
srv.stdout.on("data", d => (saida += d)); srv.stderr.on("data", d => (saida += d));

let falhas = 0;
const confere = (nome, ok, extra = "") => { if (!ok) falhas++; console.log(`${ok ? "ok    " : "FALHOU"} ${nome}${ok ? "" : " " + extra}`); };

async function chama(metodo, url, corpo, cookie) {
  const r = await fetch(BASE + url, { method: metodo, redirect: "manual", headers: { ...(corpo ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch (_) {}
  return { status: r.status, json, texto, h: r.headers, cookie: (r.headers.get("set-cookie") || "").split(";")[0], local: r.headers.get("location") };
}
const entra = async (email, senha) => (await chama("POST", "/api/login", { email, senha })).cookie;
const trocaSenha = async (cookie, atual, nova) => chama("POST", "/api/minha-senha", { atual, nova }, cookie);

try {
  for (let i = 0; i < 100 && !saida.includes("CrediControle em"); i++) await new Promise(r => setTimeout(r, 100));
  if (!saida.includes("CrediControle em")) throw new Error("servidor não subiu:\n" + saida);

  // acesso sem login
  confere("página principal sem login vai para /login", (await chama("GET", "/")).local === "/login");
  confere("dados sem login dão 401", (await chama("GET", "/api/dados")).status === 401);
  confere("senha errada dá 401", (await chama("POST", "/api/login", { email: ADMIN.email, senha: "errada123" })).status === 401);

  // primeiro acesso do administrador: troca obrigatória
  let adm = await entra(ADMIN.email, ADMIN.senha);
  confere("login do administrador criado pelas variáveis", !!adm);
  confere("/api/eu avisa que precisa trocar a senha", (await chama("GET", "/api/eu", null, adm)).json?.trocarSenha === true);
  const bloq = await chama("GET", "/api/dados", null, adm);
  confere("dados bloqueados até trocar a senha", bloq.status === 403 && bloq.json?.trocarSenha === true);
  confere("página principal manda para /trocar-senha", (await chama("GET", "/", null, adm)).local === "/trocar-senha");
  confere("senha atual errada não troca", (await trocaSenha(adm, "errada123", senhaNova())).status === 400);
  confere("nova senha curta não troca", (await trocaSenha(adm, ADMIN.senha, "curta")).status === 400);
  const novaAdm = senhaNova(), troca = await trocaSenha(adm, ADMIN.senha, novaAdm);
  confere("troca de senha funciona e devolve login novo", troca.status === 200 && !!troca.cookie);
  confere("login de antes da troca deixa de valer", (await chama("GET", "/api/eu", null, adm)).status === 401);
  adm = troca.cookie;
  confere("senha antiga não entra mais", !(await entra(ADMIN.email, ADMIN.senha)));
  confere("login com a senha nova funciona", !!(await entra(ADMIN.email, novaAdm)));

  // cabeçalhos de segurança
  const home = await chama("GET", "/", null, adm), cspHome = home.h.get("content-security-policy") || "";
  const nonce = (cspHome.match(/'nonce-([^']+)'/) || [])[1];
  confere("página principal traz a tela e o web.js", home.status === 200 && home.texto.includes("/assets/web.js") && home.texto.includes("CrediControle"));
  confere("CSP com nonce e todos os scripts da página com o mesmo nonce", !!nonce && home.texto.split("<script").length - 1 === home.texto.split(`<script nonce="${nonce}"`).length - 1);
  confere("CSP bloqueia scripts de fora e moldura", cspHome.includes("script-src 'self' 'nonce-") && cspHome.includes("frame-ancestors 'none'"));
  confere("API não fica em cache", (await chama("GET", "/api/dados", null, adm)).h.get("cache-control") === "no-store");

  // documentos
  confere("grava documento", (await chama("PUT", "/api/doc/clientes/c1", { nome: "Fulano de Tal", status: "ativo" }, adm)).status === 200);
  const tudo = await chama("GET", "/api/dados", null, adm), v1 = tudo.json.versao;
  confere("lista traz o documento", tudo.json.docs.some(d => d.id === "c1" && d.dados.nome === "Fulano de Tal"));
  await chama("PATCH", "/api/doc/clientes/c1", { cpf: "529.982.247-25" }, adm);
  const inc = await chama("GET", `/api/dados?desde=${v1}`, null, adm);
  confere("busca incremental traz só o que mudou, já mesclado", inc.json.docs.length === 1 && inc.json.docs[0].dados.nome === "Fulano de Tal" && inc.json.docs[0].dados.cpf === "529.982.247-25");
  await chama("DELETE", "/api/doc/clientes/c1", null, adm);
  const inc2 = await chama("GET", `/api/dados?desde=${inc.json.versao}`, null, adm);
  confere("exclusão chega na busca incremental", inc2.json.docs.some(d => d.id === "c1" && d.excluido));
  confere("exclusão some da lista completa", !(await chama("GET", "/api/dados", null, adm)).json.docs.some(d => d.id === "c1"));
  confere("coleção desconhecida dá 400", (await chama("PUT", "/api/doc/senhas/x", { a: 1 }, adm)).status === 400);
  confere("mesclar documento inexistente dá 404", (await chama("PATCH", "/api/doc/clientes/nao-existe", { a: 1 }, adm)).status === 404);

  // pré-cadastro público
  confere("info pública tem aviso", !!(await chama("GET", "/api/publico/info")).json?.aviso);
  const pre = { nome: "Maria da Silva", cpf: "529.982.247-25", telefone: "(27) 99999-0000", aceite: true, cidade: "Serra", uf: "es", ref1Nome: "José", ref1Parentesco: "pai", ref1Telefone: "(27) 98888-0000", renda: "2.500,00", franquia: "GC12" };
  confere("CPF inválido é recusado", (await chama("POST", "/api/publico/precadastro", { ...pre, cpf: "111.111.111-11" })).status === 400);
  confere("sem aceite é recusado", (await chama("POST", "/api/publico/precadastro", { ...pre, aceite: false })).status === 400);
  confere("pré-cadastro válido é aceito", (await chama("POST", "/api/publico/precadastro", pre)).status === 200);
  confere("robô (campo escondido) recebe ok mas não grava", (await chama("POST", "/api/publico/precadastro", { ...pre, site: "x" })).status === 200);
  await chama("POST", "/api/publico/precadastro", pre);
  const pres = (await chama("GET", "/api/dados", null, adm)).json.docs.filter(d => d.colecao === "clientes" && d.dados.origem === "link");
  const p0 = pres.find(d => !d.dados.obs)?.dados || {};
  confere("pré-cadastro gravado com status, origem, franquia, UF e renda", pres.length === 2 && p0.status === "pre" && p0.franquia === "GC12" && p0.uf === "ES" && p0.renda === 2500);
  confere("referência formatada", p0.referencias === "José (pai) — (27) 98888-0000");
  confere("CPF repetido fica com aviso", pres.some(d => /^Atenção/.test(d.dados.obs)));
  for (let i = 0; i < 3; i++) await chama("POST", "/api/publico/precadastro", pre);
  confere("limite de 5 envios por hora por aparelho", (await chama("POST", "/api/publico/precadastro", pre)).status === 429);

  // usuários e permissões
  const op = { nome: "Operador Teste", email: "op@teste.local", senha: senhaNova(), papel: "operador" };
  const novo = await chama("POST", "/api/usuarios", op, adm);
  confere("administrador cadastra operador", novo.status === 200);
  confere("e-mail repetido dá 409", (await chama("POST", "/api/usuarios", op, adm)).status === 409);
  let opc = await entra(op.email, op.senha);
  confere("operador novo também precisa trocar a senha", (await chama("GET", "/api/dados", null, opc)).status === 403);
  const novaOp = senhaNova();
  opc = (await trocaSenha(opc, op.senha, novaOp)).cookie;
  confere("depois de trocar, operador lê os dados", (await chama("GET", "/api/dados", null, opc)).status === 200);
  confere("operador não lista usuários", (await chama("GET", "/api/usuarios", null, opc)).status === 403);
  confere("operador é mandado da página de usuários para a principal", (await chama("GET", "/usuarios", null, opc)).local === "/");
  confere("operador não altera configurações", (await chama("PUT", "/api/doc/config/geral", { nome: "X" }, opc)).status === 403);
  confere("operador cria contrato", (await chama("PUT", "/api/doc/contratos/k1", { valor: 500, movimentos: [{ id: "m1", valor: 100 }] }, opc)).status === 200);
  confere("operador registra pagamento novo", (await chama("PATCH", "/api/doc/contratos/k1", { movimentos: [{ id: "m1", valor: 100 }, { id: "m2", valor: 50 }] }, opc)).status === 200);
  confere("operador não estorna pagamento", (await chama("PATCH", "/api/doc/contratos/k1", { movimentos: [{ id: "m1", valor: 100 }] }, opc)).status === 403);
  confere("operador não estorna parcela", (await chama("PUT", "/api/doc/contratos/k2", { parcelas: [{ n: 1, pagamentos: [{ valor: 10 }] }] }, opc)).status === 200
    && (await chama("PATCH", "/api/doc/contratos/k2", { parcelas: [{ n: 1, pagamentos: [] }] }, opc)).status === 403);
  confere("operador não cancela contrato", (await chama("PATCH", "/api/doc/contratos/k1", { cancelado: true }, opc)).status === 403);
  confere("operador não exclui contrato", (await chama("DELETE", "/api/doc/contratos/k1", null, opc)).status === 403);
  await chama("PUT", "/api/doc/clientes/p1", { nome: "Pré Teste", status: "pre" }, opc);
  confere("operador marca cliente como avisado (lembrete manual)", (await chama("PUT", "/api/doc/avisos/k1_saldo_2026-11-03_1", { quando: new Date().toISOString(), por: "Operador Teste" }, opc)).status === 200);
  confere("operador recusa (exclui) pré-cadastro", (await chama("DELETE", "/api/doc/clientes/p1", null, opc)).status === 200);
  confere("administrador exclui contrato", (await chama("DELETE", "/api/doc/contratos/k1", null, adm)).status === 200);

  // auditoria
  const aud = (await chama("GET", "/api/auditoria", null, adm)).json || [];
  const alt = aud.find(x => x.acao === "alterar" && x.doc_id === "k1");
  confere("auditoria registra alteração com quem fez", !!alt && /Operador Teste/.test(alt.usuario));
  confere("auditoria guarda só o que mudou", !!alt && Object.keys(alt.depois).join() === "movimentos" && alt.antes.movimentos.length === 1);
  confere("auditoria registra exclusão com o documento antigo", aud.some(x => x.acao === "excluir" && x.doc_id === "k1" && x.antes?.valor === 500));
  confere("auditoria registra login recusado e troca de senha", aud.some(x => x.acao === "login_falhou") && aud.some(x => x.acao === "trocou_senha"));
  confere("auditoria registra pré-cadastro público", aud.some(x => x.acao === "precadastro_publico"));
  confere("auditoria não guarda senha", !JSON.stringify(aud).includes(novaOp) && !JSON.stringify(aud).includes(op.senha));
  confere("filtro da auditoria por registro", ((await chama("GET", "/api/auditoria?colecao=contratos", null, adm)).json || []).every(x => x.colecao === "contratos"));
  confere("operador não vê a auditoria", (await chama("GET", "/api/auditoria", null, opc)).status === 403);

  // cópia de segurança
  const bk = await chama("GET", "/api/backup", null, adm);
  confere("cópia de segurança baixa como arquivo com os dados", bk.status === 200 && /attachment/.test(bk.h.get("content-disposition") || "") && !!bk.json?.colecoes?.clientes);
  confere("operador não baixa cópia", (await chama("GET", "/api/backup", null, opc)).status === 403);

  // senha redefinida pelo administrador
  await chama("PATCH", `/api/usuarios/${novo.json.id}`, { senha: "provisoria123" }, adm);
  confere("senha redefinida derruba o login aberto do operador", (await chama("GET", "/api/eu", null, opc)).status === 401);
  const opc2 = await entra(op.email, "provisoria123");
  confere("senha provisória obriga nova troca", (await chama("GET", "/api/eu", null, opc2)).json?.trocarSenha === true);
  const eu = (await chama("GET", "/api/eu", null, adm)).json;
  confere("administrador não desativa a si mesmo", (await chama("PATCH", `/api/usuarios/${eu.id}`, { ativo: false }, adm)).status === 400);
  await chama("PATCH", `/api/usuarios/${novo.json.id}`, { ativo: false }, adm);
  confere("operador desativado perde o acesso na hora", (await chama("GET", "/api/eu", null, opc2)).status === 401);
  confere("cookie adulterado não entra", (await chama("GET", "/api/eu", null, adm.replace(/.$/, c => (c === "A" ? "B" : "A")))).status === 401);

  let ultimo;
  for (let i = 0; i < 11; i++) ultimo = await chama("POST", "/api/login", { email: "ninguem@teste.local", senha: "x" });
  confere("limite de tentativas de login", ultimo.status === 429);
} catch (e) {
  falhas++; console.log("ERRO", e.message);
} finally {
  srv.kill();
}
console.log(falhas ? `\n${falhas} teste(s) falharam` : "\nTodos os testes passaram");
process.exit(falhas ? 1 : 0);

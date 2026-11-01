// Testa a API de ponta a ponta: sobe o servidor com banco embutido em memória, faz as chamadas e derruba.
// Uso: npm test
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORTA = 3399, BASE = `http://127.0.0.1:${PORTA}`;
const ADMIN = { email: "admin@teste.local", senha: crypto.randomBytes(9).toString("base64url") };
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
  return { status: r.status, json, texto, cookie: (r.headers.get("set-cookie") || "").split(";")[0], local: r.headers.get("location") };
}
const entra = async (email, senha) => (await chama("POST", "/api/login", { email, senha })).cookie;

try {
  for (let i = 0; i < 100 && !saida.includes("CrediControle em"); i++) await new Promise(r => setTimeout(r, 100));
  if (!saida.includes("CrediControle em")) throw new Error("servidor não subiu:\n" + saida);

  // acesso sem login
  confere("página principal sem login vai para /login", (await chama("GET", "/")).local === "/login");
  confere("dados sem login dão 401", (await chama("GET", "/api/dados")).status === 401);
  confere("senha errada dá 401", (await chama("POST", "/api/login", { email: ADMIN.email, senha: "errada123" })).status === 401);
  const adm = await entra(ADMIN.email, ADMIN.senha);
  confere("login do administrador criado pelas variáveis", !!adm);
  confere("/api/eu devolve o administrador", (await chama("GET", "/api/eu", null, adm)).json?.papel === "admin");
  const home = await chama("GET", "/", null, adm);
  confere("página principal com login traz a tela e o web.js", home.status === 200 && home.texto.includes("/assets/web.js") && home.texto.includes("CrediControle"));

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
  confere("info pública tem nome e aviso", !!(await chama("GET", "/api/publico/info")).json?.aviso);
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

  // usuários
  const op = { nome: "Operador Teste", email: "op@teste.local", senha: crypto.randomBytes(9).toString("base64url"), papel: "operador" };
  const novo = await chama("POST", "/api/usuarios", op, adm);
  confere("administrador cadastra operador", novo.status === 200);
  confere("e-mail repetido dá 409", (await chama("POST", "/api/usuarios", op, adm)).status === 409);
  const opc = await entra(op.email, op.senha);
  confere("operador entra e lê os dados", (await chama("GET", "/api/dados", null, opc)).status === 200);
  confere("operador não lista usuários", (await chama("GET", "/api/usuarios", null, opc)).status === 403);
  confere("operador é mandado da página de usuários para a principal", (await chama("GET", "/usuarios", null, opc)).local === "/");
  const eu = (await chama("GET", "/api/eu", null, adm)).json;
  confere("administrador não desativa a si mesmo", (await chama("PATCH", `/api/usuarios/${eu.id}`, { ativo: false }, adm)).status === 400);
  await chama("PATCH", `/api/usuarios/${novo.json.id}`, { ativo: false }, adm);
  confere("operador desativado perde o acesso na hora", (await chama("GET", "/api/eu", null, opc)).status === 401);
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

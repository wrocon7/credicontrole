// Testa a API de ponta a ponta: sobe o servidor com banco embutido em memória, faz as chamadas e derruba.
// Uso: npm test
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORTA = 3399, BASE = `http://127.0.0.1:${PORTA}`;
const senhaNova = () => crypto.randomBytes(9).toString("base64url");
const ADMIN = { email: "admin@teste.local", senha: senhaNova() };
const EMAILS = path.join(os.tmpdir(), `cc-emails-${process.pid}.jsonl`);
const FICHA = { cpf: "529.982.247-25", rg: "1234567 SPTC/ES", telefone: "(27) 99999-0000", endereco: "RUA A, 1 · CENTRO · SERRA/ES", profissao: "CAIXA",
  empresa: "LOJA X", enderecoTrabalho: "RUA B, 2, CENTRO, SERRA", tempoRegistro: "1 ANO", renda: 2000, referencias: "ANA (MÃE) — (27) 98888-0000\nRUI (PAI) — (27) 97777-0000" };
const srv = spawn(process.execPath, ["server.js"], {
  cwd: raiz,
  env: { ...process.env, DATABASE_URL: "", PGLITE_DIR: ":memory:", PORT: String(PORTA), SESSION_SECRET: crypto.randomBytes(16).toString("hex"), ADMIN_EMAIL: ADMIN.email, ADMIN_SENHA: ADMIN.senha, EMAIL_ARQUIVO: EMAILS, APP_URL: BASE },
});
let saida = "";
srv.stdout.on("data", d => (saida += d)); srv.stderr.on("data", d => (saida += d));

let falhas = 0;
const confere = (nome, ok, extra = "") => { if (!ok) falhas++; console.log(`${ok ? "ok    " : "FALHOU"} ${nome}${ok ? "" : " " + extra}`); };

async function chama(metodo, url, corpo, cookie, extras = {}) {
  const r = await fetch(BASE + url, { method: metodo, redirect: "manual", headers: { ...(corpo ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}), ...extras }, body: corpo ? JSON.stringify(corpo) : undefined });
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
  confere("grava documento", (await chama("PUT", "/api/doc/clientes/c1", { ...FICHA, nome: "Fulano de Tal", status: "ativo" }, adm)).status === 200);
  const incompleto = await chama("PUT", "/api/doc/clientes/c0", { nome: "Hugo Demuner", cpf: "529.982.247-25", telefone: "(27) 99999-0000", status: "ativo" }, adm);
  confere("cliente novo sem os campos obrigatórios é recusado e diz o que falta", incompleto.status === 400 && ["RG", "profissão", "renda mensal", "duas referências (uma por linha)"].every(c => incompleto.json?.erro.includes(c)), JSON.stringify(incompleto.json));
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
  const pre = { nome: "Maria  da silva", cpf: "529.982.247-25", rg: "1234567 sptc/es", telefone: "27999990000", aceite: true,
    cep: "29160-161", logradouro: "Av. João Palácio", numero: "10", bairro: "Eurico Salles", cidade: "Serra", uf: "es",
    profissao: "caixa", empresa: "Mercado Bom Preço", enderecoTrabalho: "Rua das Flores, 20, Centro, Serra", ref1Nome: "José", ref1Parentesco: "pai", ref1Telefone: "(27) 98888-0000", ref2Nome: "Ana", ref2Parentesco: "irmã", ref2Telefone: "27977770000", tempoRegistro: "8 meses", renda: "2.500,00", franquia: "GC12" };
  confere("CPF inválido é recusado", (await chama("POST", "/api/publico/precadastro", { ...pre, cpf: "111.111.111-11" })).status === 400);
  const so3 = await chama("POST", "/api/publico/precadastro", { nome: "Hugo Demuner", cpf: pre.cpf, telefone: pre.telefone, aceite: true });
  confere("só nome, CPF e telefone não passa: lista o que falta", so3.status === 400 && ["RG", "CEP", "profissão", "nome da empresa", "endereço do local de trabalho", "telefone do contato"].every(c => so3.json?.faltam?.includes(c)), JSON.stringify(so3.json));
  confere("sem aceite é recusado", (await chama("POST", "/api/publico/precadastro", { ...pre, aceite: false })).status === 400);
  confere("pré-cadastro válido é aceito", (await chama("POST", "/api/publico/precadastro", pre)).status === 200);
  confere("robô (campo escondido) recebe ok mas não grava", (await chama("POST", "/api/publico/precadastro", { ...pre, site: "x" })).status === 200);
  await chama("POST", "/api/publico/precadastro", pre);
  const pres = (await chama("GET", "/api/dados", null, adm)).json.docs.filter(d => d.colecao === "clientes" && d.dados.origem === "link");
  const p0 = pres.find(d => !d.dados.obs)?.dados || {};
  confere("pré-cadastro gravado com status, origem, franquia, UF e renda", pres.length === 2 && p0.status === "pre" && p0.franquia === "GC12" && p0.uf === "ES" && p0.renda === 2500);
  confere("nome, RG, empresa e endereços em maiúsculas", p0.nome === "MARIA DA SILVA" && p0.rg === "1234567 SPTC/ES" && p0.empresa === "MERCADO BOM PREÇO"
    && p0.enderecoTrabalho === "RUA DAS FLORES, 20, CENTRO, SERRA" && p0.endereco === "AV. JOÃO PALÁCIO, 10 · EURICO SALLES · SERRA/ES · 29160-161", JSON.stringify(p0));
  confere("telefone formatado e e-mail/valor pretendido fora", p0.telefone === "(27) 99999-0000" && !("email" in p0) && !("valorPretendido" in p0));
  confere("as duas referências formatadas", p0.referencias === "JOSÉ (PAI) — (27) 98888-0000\nANA (IRMÃ) — (27) 97777-0000", p0.referencias);
  const sem2 = await chama("POST", "/api/publico/precadastro", { ...pre, ref2Nome: "", renda: "", tempoRegistro: "" });
  confere("sem 2º contato, renda e tempo de carteira não passa", sem2.status === 400 && ["nome do 2º contato", "renda mensal", "tempo de carteira"].every(c => sem2.json?.faltam?.includes(c)), JSON.stringify(sem2.json));
  confere("CPF repetido fica com aviso", pres.some(d => /^Atenção/.test(d.dados.obs)));
  for (let i = 0; i < 3; i++) await chama("POST", "/api/publico/precadastro", pre);
  confere("limite de 5 envios por hora por aparelho", (await chama("POST", "/api/publico/precadastro", pre)).status === 429);

  // usuários e permissões
  const op = { nome: "Operador Teste", email: "op@teste.local", senha: senhaNova(), papel: "operador", rota: "Rota 1" };
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
  const k1 = "/api/doc/contratos/k1", k2 = "/api/doc/contratos/k2", docs = async () => (await chama("GET", "/api/dados", null, adm)).json.docs;
  const saldo = { clienteId: "cx", valor: 500, taxa: 25, modalidade: "saldo", dataContrato: "2026-01-10", vencimento: "2026-02-10", movimentos: [{ id: "m1", data: "2026-01-20", valor: 100 }] };
  const m2 = { id: "m2", data: "2026-01-25", valor: 50 }, m3 = { id: "m3", data: "2026-02-01", valor: 20 };
  // rotas e liberação de baixa: o administrador configura, cria um cliente em cada rota
  await chama("PUT", "/api/doc/config/geral", { nome: "Teste", rotas: "Rota 1, Rota 2", operadorRecebe: true }, adm);
  await chama("PUT", "/api/doc/clientes/cx", { ...FICHA, nome: "CLIENTE DA ROTA 1", cpf: "111.444.777-35", rg: "RG1 SPTC", status: "ativo", rota: "Rota 1" }, adm);
  await chama("PUT", "/api/doc/clientes/cy", { ...FICHA, nome: "CLIENTE DA ROTA 2", cpf: "123.456.789-09", rg: "RG2 SPTC", telefone: "(27) 91111-2222", status: "ativo", rota: "Rota 2" }, adm);
  confere("/api/eu informa a rota do operador", (await chama("GET", "/api/eu", null, opc)).json?.rota === "Rota 1");
  const semMov = { ...saldo, movimentos: [] };
  confere("operador não lança contrato já com pagamento", (await chama("PUT", k1, saldo, opc)).status === 403);
  const criou = await chama("PUT", k1, semMov, opc);
  confere("contrato lançado pelo operador fica aguardando o Pix", criou.status === 200 && criou.json.versao > 0 && (await docs()).find(d => d.id === "k1").dados.pendente === true);
  confere("operador não confirma o Pix", (await chama("PATCH", k1, { pendente: false }, opc)).status === 403);
  confere("contrato aguardando o Pix não recebe pagamento", (await chama("PATCH", k1, { movimentos: saldo.movimentos }, opc)).status === 400);
  confere("administrador confirma o Pix", (await chama("PATCH", k1, { pendente: false }, adm)).status === 200);
  confere("operador registra o primeiro pagamento", (await chama("PATCH", k1, { movimentos: saldo.movimentos }, opc)).status === 200);
  confere("operador registra pagamento novo", (await chama("PATCH", k1, { movimentos: [...saldo.movimentos, m2] }, opc)).status === 200);
  confere("operador não estorna pagamento", (await chama("PATCH", k1, { movimentos: saldo.movimentos }, opc)).status === 403);
  confere("operador não muda o valor de um pagamento já lançado", (await chama("PATCH", k1, { movimentos: [{ ...saldo.movimentos[0], valor: 1 }, m2] }, opc)).status === 403);
  confere("operador não muda valor nem taxa do contrato", (await chama("PATCH", k1, { valor: 50 }, opc)).status === 403 && (await chama("PATCH", k1, { taxa: 1 }, opc)).status === 403);
  confere("operador renegocia vencimento e marca inadimplente", (await chama("PATCH", k1, { vencimento: "2026-03-10", inad: { motivo: "teste", em: "2026-02-11" } }, opc)).status === 200);
  const p1 = { n: 1, venc: "2026-02-10", valor: 330, pagamentos: [{ data: "2026-02-10", valor: 10, txId: "t1" }] };
  const parc = { clienteId: "cx", valor: 300, taxa: 10, modalidade: "simples", dataContrato: "2026-01-10", multa: 2, mora: 0.33, parcelas: [p1] };
  await chama("PUT", k2, parc, adm);
  confere("operador não estorna parcela", (await chama("PATCH", k2, { parcelas: [{ ...p1, pagamentos: [] }] }, opc)).status === 403);
  confere("operador não quita parcela sem lançar o pagamento", (await chama("PATCH", k2, { parcelas: [{ ...p1, quitada: true }] }, opc)).status === 403);
  confere("operador quita parcela lançando o pagamento", (await chama("PATCH", k2, { parcelas: [{ ...p1, pagamentos: [...p1.pagamentos, { data: "2026-02-11", valor: 320, txId: "t2" }], quitada: true }] }, opc)).status === 200);
  confere("operador não cancela contrato", (await chama("PATCH", k1, { cancelado: true }, opc)).status === 403);
  confere("operador não exclui contrato", (await chama("DELETE", k1, null, opc)).status === 403);
  confere("operador lança no caixa", (await chama("PUT", "/api/doc/transacoes/t9", { tipo: "entrada", valor: 10, data: "2026-02-10", contratoId: "k1", clienteId: "cx" }, opc)).status === 200);
  confere("operador não altera lançamento já gravado", (await chama("PUT", "/api/doc/transacoes/t9", { tipo: "entrada", valor: 9999, data: "2026-02-10", contratoId: "k1", clienteId: "cx" }, opc)).status === 403);

  // formato do que é gravado
  confere("contrato com valor em texto é recusado", (await chama("PUT", "/api/doc/contratos/k3", { ...saldo, valor: "500" }, adm)).status === 400);
  confere("pagamento com data torta é recusado", (await chama("PATCH", k1, { movimentos: [...saldo.movimentos, m2, { id: "mx", data: "<img src=x>", valor: 5 }] }, adm)).status === 400);
  confere("lançamento sem valor é recusado", (await chama("PUT", "/api/doc/transacoes/t8", { tipo: "entrada", data: "2026-02-10" }, adm)).status === 400);
  confere("dias de lembrete tortos são recusados", (await chama("PUT", "/api/doc/config/lembretes", { ativo: true, dias: "1,0" }, adm)).status === 400);

  // duas pessoas no mesmo registro
  const v0 = (await docs()).find(d => d.id === "k1").versao;
  const g1 = await chama("PATCH", k1, { obs: "primeira" }, adm, { "If-Match": String(v0) });
  const g2 = await chama("PATCH", k1, { obs: "segunda, baseada na versão antiga" }, adm, { "If-Match": String(v0) });
  confere("quem grava com a versão em dia entra; quem ficou para trás recebe 409", g1.status === 200 && g1.json.versao > v0 && g2.status === 409 && (await docs()).find(d => d.id === "k1").dados.obs === "primeira");

  // lote: tudo ou nada
  const pagamento = valorCaixa => ({ ops: [{ op: "mesclar", col: "contratos", id: "k1", dados: { movimentos: [...saldo.movimentos, m2, m3] } }, { op: "gravar", col: "transacoes", id: "t10", dados: { tipo: "entrada", valor: valorCaixa, data: "2026-02-01", contratoId: "k1", clienteId: "cx" } }] });
  const ruim = await chama("POST", "/api/lote", pagamento(-5), opc), d1 = await docs();
  confere("lote com um item inválido não grava nada", ruim.status === 400 && d1.find(d => d.id === "k1").dados.movimentos.length === 2 && !d1.some(d => d.id === "t10"));
  const bom = await chama("POST", "/api/lote", pagamento(20), opc), d2 = await docs();
  confere("lote válido grava pagamento e caixa juntos", bom.status === 200 && bom.json.versoes.length === 2 && d2.find(d => d.id === "k1").dados.movimentos.length === 3 && d2.find(d => d.id === "t10")?.dados.valor === 20);
  const est = await chama("POST", "/api/lote", { ops: [{ op: "mesclar", col: "contratos", id: "k1", dados: { movimentos: [...saldo.movimentos, m2] } }, { op: "excluir", col: "transacoes", id: "t10" }] }, opc), d3 = await docs();
  confere("operador não estorna por lote", est.status === 403 && d3.find(d => d.id === "k1").dados.movimentos.length === 3 && d3.some(d => d.id === "t10"));
  confere("lote vazio ou torto é recusado", (await chama("POST", "/api/lote", { ops: [] }, adm)).status === 400 && (await chama("POST", "/api/lote", { ops: [{ op: "apagar-tudo", col: "contratos", id: "k1" }] }, adm)).status === 400);

  // pedidos vindos de outro site
  confere("gravação pedida por outro site é recusada", (await chama("PATCH", k1, { obs: "x" }, adm, { Origin: "https://site-malicioso.example" })).status === 403);
  confere("gravação pedida pela própria página passa", (await chama("PATCH", k1, { obs: "ok" }, adm, { Origin: BASE })).status === 200);
  // rotas: o que o operador vê e altera
  await chama("PUT", "/api/doc/contratos/ky", { ...semMov, clienteId: "cy" }, adm);
  const visto = (await chama("GET", "/api/dados", null, opc)).json.docs, cyOp = visto.find(d => d.id === "cy")?.dados || {};
  confere("operador vê só o resumo do cliente de outra rota", cyOp._resumo === true && cyOp.nome === "CLIENTE DA ROTA 2" && cyOp.rg === "RG2 SPTC" && cyOp.status === "ativo" && !("cpf" in cyOp) && !("telefone" in cyOp), JSON.stringify(cyOp));
  confere("operador não recebe contratos de outra rota e recebe os da sua", !visto.some(d => d.id === "ky") && visto.some(d => d.id === "k1") && visto.find(d => d.id === "cx")?.dados.cpf === "111.444.777-35");
  const parcial = (await chama("GET", "/api/dados?desde=1", null, opc)).json.docs;
  confere("na busca por mudanças, o que é de outra rota também não vem", !parcial.some(d => d.id === "ky" && !d.excluido) && !parcial.some(d => d.id === "cy" && d.dados.cpf));
  confere("operador não altera cliente nem contrato de outra rota", (await chama("PATCH", "/api/doc/clientes/cy", { telefone: "x" }, opc)).status === 403
    && (await chama("PATCH", "/api/doc/contratos/ky", { obs: "x" }, opc)).status === 403 && (await chama("PUT", "/api/doc/contratos/kz", { ...semMov, clienteId: "cy" }, opc)).status === 403);
  confere("operador não muda a rota de um cliente", (await chama("PATCH", "/api/doc/clientes/cx", { rota: "Rota 2" }, opc)).status === 403);
  await chama("PUT", "/api/doc/clientes/cn", { ...FICHA, nome: "NOVO DO OPERADOR", status: "ativo", rota: "Rota 2" }, opc);
  confere("cliente criado pelo operador cai na rota dele", (await docs()).find(d => d.id === "cn")?.dados.rota === "Rota 1");
  await chama("PUT", "/api/doc/config/geral", { nome: "Teste", rotas: "Rota 1, Rota 2", operadorRecebe: false }, adm);
  confere("sem liberação, operador não dá baixa", (await chama("PATCH", k1, { movimentos: [...saldo.movimentos, m2, m3, { id: "m4", data: "2026-02-05", valor: 5 }] }, opc)).status === 403
    && (await chama("PUT", "/api/doc/transacoes/t11", { tipo: "entrada", valor: 5, data: "2026-02-05", contratoId: "k1", clienteId: "cx" }, opc)).status === 403);
  confere("operador não lança saída no caixa", (await chama("PUT", "/api/doc/transacoes/t12", { tipo: "saida", valor: 5, data: "2026-02-05", contratoId: "k1", clienteId: "cx" }, opc)).status === 403);
  confere("administrador continua dando baixa", (await chama("PATCH", k1, { movimentos: [...saldo.movimentos, m2, m3, { id: "m4", data: "2026-02-05", valor: 5 }] }, adm)).status === 200);
  await chama("PUT", "/api/doc/clientes/p1", { ...FICHA, nome: "Pré Teste", status: "pre" }, opc);
  confere("operador marca cliente como avisado (lembrete manual)", (await chama("PUT", "/api/doc/avisos/k1_saldo_2026-11-03_1", { quando: new Date().toISOString(), por: "Operador Teste", contratoId: "k1", clienteId: "cx" }, opc)).status === 200);
  confere("operador recusa (exclui) pré-cadastro", (await chama("DELETE", "/api/doc/clientes/p1", null, opc)).status === 200);
  confere("administrador exclui contrato", (await chama("DELETE", "/api/doc/contratos/k1", null, adm)).status === 200);

  // auditoria
  const aud = (await chama("GET", "/api/auditoria", null, adm)).json || [];
  const alt = aud.find(x => x.acao === "alterar" && x.doc_id === "k1" && /Operador Teste/.test(x.usuario) && x.antes?.movimentos?.length === 1);
  confere("auditoria registra alteração com quem fez", !!alt);
  confere("auditoria guarda só o que mudou", !!alt && Object.keys(alt.depois).join() === "movimentos");
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

  // administrador edita outro usuário: nome, e-mail, papel e rota
  const ed = await chama("PATCH", `/api/usuarios/${novo.json.id}`, { nome: "Operador Renomeado", email: "op2@teste.local", rota: "Rota 2" }, adm);
  const lista = (await chama("GET", "/api/usuarios", null, adm)).json || [], opEd = lista.find(u => u.id === novo.json.id) || {};
  confere("administrador muda nome, e-mail e rota de outro usuário", ed.status === 200 && opEd.nome === "Operador Renomeado" && opEd.email === "op2@teste.local" && opEd.rota === "Rota 2", JSON.stringify(opEd));
  confere("e-mail de outro usuário não pode ser repetido", (await chama("PATCH", `/api/usuarios/${novo.json.id}`, { email: ADMIN.email }, adm)).status === 409);
  confere("lista de rotas para o administrador", JSON.stringify((await chama("GET", "/api/rotas", null, adm)).json) === JSON.stringify(["Rota 1", "Rota 2"]));
  confere("operador não lista rotas nem edita usuários", (await chama("GET", "/api/rotas", null, opc)).status !== 200);

  // recuperação de senha
  await chama("PATCH", `/api/usuarios/${novo.json.id}`, { ativo: true }, adm);
  const pNada = await chama("POST", "/api/esqueci", { email: "nao-existe@teste.local" }), pOp = await chama("POST", "/api/esqueci", { email: "op2@teste.local" });
  confere("pedido de nova senha responde igual para e-mail que existe e que não existe", pNada.status === 200 && pOp.status === 200 && pNada.json.mensagem === pOp.json.mensagem);
  await new Promise(r => setTimeout(r, 300));
  const emails = fs.existsSync(EMAILS) ? fs.readFileSync(EMAILS, "utf8").trim().split("\n").map(l => JSON.parse(l)) : [];
  const msg = emails.find(m => (m.to?.[0]?.address || m.envelope?.to?.[0]) === "op2@teste.local");
  const token = (msg?.text || "").match(/\/redefinir\?t=([A-Za-z0-9_-]+)/)?.[1];
  confere("o e-mail sai só para quem existe e leva o link", emails.length === 1 && !!token, JSON.stringify(emails.map(m => m.to)));
  confere("administrador vê que a pessoa pediu nova senha", !!((await chama("GET", "/api/usuarios", null, adm)).json.find(u => u.id === novo.json.id)?.pedido_senha));
  confere("link falso não troca a senha", (await chama("POST", "/api/redefinir", { token: "x".repeat(43), nova: "qualquer-1234" })).status === 400);
  const nova3 = senhaNova(), red = await chama("POST", "/api/redefinir", { token, nova: nova3 });
  confere("link do e-mail troca a senha", red.status === 200 && !!(await entra("op2@teste.local", nova3)));
  confere("o mesmo link não serve duas vezes", (await chama("POST", "/api/redefinir", { token, nova: senhaNova() })).status === 400);
  confere("depois de trocar, o pedido sai da lista do administrador", !(await chama("GET", "/api/usuarios", null, adm)).json.find(u => u.id === novo.json.id)?.pedido_senha);
  fs.rmSync(EMAILS, { force: true });
  let n = 0;
  while (n < 45 && (ultimo = await chama("POST", "/api/login", { email: `mais${n}@teste.local`, senha: "x" })).status === 401) n++;
  confere("limite por aparelho, mesmo trocando de e-mail a cada tentativa", ultimo.status === 429 && n < 40, `parou em ${n} com ${ultimo.status}`);

  // senhas: o formato antigo continua valendo e é marcado para regravar
  process.env.SESSION_SECRET ||= "segredo-so-para-o-teste";
  const { hashSenha, confereSenha, hashFraco } = await import("../auth.js");
  const sal = crypto.randomBytes(16), antigo = `scrypt$${sal.toString("hex")}$${crypto.scryptSync("senha-antiga-1", sal, 32).toString("hex")}`, atual = await hashSenha("senha-nova-1");
  confere("hash no formato antigo ainda confere e pede regravação", (await confereSenha("senha-antiga-1", antigo)) && !(await confereSenha("errada", antigo)) && hashFraco(antigo));
  confere("hash novo confere, recusa senha errada e não pede regravação", (await confereSenha("senha-nova-1", atual)) && !(await confereSenha("senha-nova-2", atual)) && !hashFraco(atual));
  confere("hash corrompido não derruba o servidor", (await confereSenha("x", "scrypt$32768$zz$abcd")) === false && (await confereSenha("x", "lixo")) === false);
} catch (e) {
  falhas++; console.log("ERRO", e.message);
} finally {
  srv.kill();
}
console.log(falhas ? `\n${falhas} teste(s) falharam` : "\nTodos os testes passaram");
process.exit(falhas ? 1 : 0);

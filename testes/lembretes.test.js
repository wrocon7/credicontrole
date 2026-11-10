// Testa os lembretes do WhatsApp com um WhatsApp de mentira: sobe o servidor e um falso "graph.facebook.com",
// cria contratos que vencem hoje e amanhã e confere o que foi enviado.
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { calculadora, hojeBR } from "../calculo.js";

const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORTA = 3396, BASE = `http://127.0.0.1:${PORTA}`, PORTA_META = 3397;
const ADMIN = { email: "admin@teste.local", senha: crypto.randomBytes(9).toString("base64url") }, CRON = crypto.randomBytes(12).toString("hex");

// WhatsApp falso: guarda os pedidos; número terminado em 0000 dá erro
const pedidos = [];
const meta = http.createServer((req, res) => {
  let corpo = "";
  req.on("data", d => (corpo += d)).on("end", () => {
    const j = JSON.parse(corpo || "{}");
    pedidos.push({ url: req.url, auth: req.headers.authorization, corpo: j });
    const erro = String(j.to).endsWith("0000");
    res.writeHead(erro ? 400 : 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(erro ? { error: { message: "Número sem WhatsApp" } } : { messages: [{ id: "wamid.teste" + pedidos.length }] }));
  });
}).listen(PORTA_META);

const srv = spawn(process.execPath, ["server.js"], {
  cwd: raiz,
  env: {
    ...process.env, DATABASE_URL: "", PGLITE_DIR: ":memory:", PORT: String(PORTA), SESSION_SECRET: "x".repeat(32),
    ADMIN_EMAIL: ADMIN.email, ADMIN_SENHA: ADMIN.senha, CRON_TOKEN: CRON,
    WHATSAPP_API_URL: `http://127.0.0.1:${PORTA_META}`, WHATSAPP_PHONE_NUMBER_ID: "123456", WHATSAPP_TOKEN: "token-teste", WHATSAPP_TEMPLATE: "lembrete_vencimento",
  },
});
let saida = "";
srv.stdout.on("data", d => (saida += d)); srv.stderr.on("data", d => (saida += d));

let falhas = 0;
const confere = (nome, ok, extra = "") => { if (!ok) falhas++; console.log(`${ok ? "ok    " : "FALHOU"} ${nome}${ok ? "" : " " + extra}`); };
async function chama(metodo, url, corpo, extras = {}) {
  const r = await fetch(BASE + url, { method: metodo, headers: { ...(corpo ? { "Content-Type": "application/json" } : {}), ...extras }, body: corpo ? JSON.stringify(corpo) : undefined });
  const texto = await r.text();
  let json = null; try { json = JSON.parse(texto); } catch (_) {}
  return { status: r.status, json, cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
}
const espaco = s => String(s).replace(/ /g, " ");

try {
  for (let i = 0; i < 100 && !saida.includes("CrediControle em"); i++) await new Promise(r => setTimeout(r, 100));
  if (!saida.includes("CrediControle em")) throw new Error("servidor não subiu:\n" + saida);
  const c0 = (await chama("POST", "/api/login", ADMIN)).cookie, nova = crypto.randomBytes(9).toString("base64url");
  const adm = { Cookie: (await chama("POST", "/api/minha-senha", { atual: ADMIN.senha, nova }, { Cookie: c0 })).cookie };

  const hoje = hojeBR(), k = calculadora({}, hoje), amanha = k.addDays(hoje, 1), dataBR = s => s.split("-").reverse().join("/");
  const grava = (col, id, dados) => chama("PUT", `/api/doc/${col}/${id}`, dados, adm);
  await grava("clientes", "c1", { nome: "Ana Souza", telefone: "(27) 99999-1234", status: "ativo" });
  await grava("clientes", "c2", { nome: "Bia Lima", telefone: "(27) 98888-0000", status: "ativo" });
  await grava("clientes", "c3", { nome: "Caio Reis", telefone: "(27) 97777-1111", status: "ativo", semLembrete: true });
  await grava("clientes", "c4", { nome: "Davi Melo", telefone: "", status: "ativo" });
  const saldo = (cli, venc, extra = {}) => ({ clienteId: cli, valor: 1000, taxa: 30, modalidade: "saldo", dataContrato: k.addDays(hoje, -10), vencimento: venc, movimentos: [], ...extra });
  await grava("contratos", "k1", saldo("c1", amanha));                                    // amanhã: 1000 × (1 + 1% × 11 dias) = 1.110,00
  const parcela = (cli, valor, extra = {}) => ({ clienteId: cli, valor, taxa: 10, modalidade: "simples", dataContrato: k.addDays(hoje, -30), parcelas: [{ n: 1, venc: hoje, valor, pagamentos: [], ...extra }] });
  await grava("contratos", "k2", parcela("c2", 500)); // hoje: dá erro no WhatsApp
  await grava("contratos", "k3", saldo("c3", amanha));                                    // cliente não quer
  await grava("contratos", "k4", parcela("c4", 300)); // sem celular
  await grava("contratos", "k5", saldo("c1", k.addDays(hoje, 5)));                        // fora dos dias configurados
  await grava("contratos", "k6", saldo("c1", amanha, { cancelado: true }));               // cancelado
  await grava("contratos", "k7", parcela("c1", 200, { quitada: true })); // já pago

  const desligado = await chama("POST", "/api/tarefas/lembretes", null, { Authorization: `Bearer ${CRON}` });
  confere("com os lembretes desligados, a tarefa não envia nada", desligado.json?.desligado === true && pedidos.length === 0);
  await grava("config", "lembretes", { ativo: true, dias: [1, 0] });
  confere("tarefa sem token é recusada", (await chama("POST", "/api/tarefas/lembretes")).status === 401);
  confere("tarefa com token errado é recusada", (await chama("POST", "/api/tarefas/lembretes", null, { Authorization: "Bearer errado" })).status === 401);

  const r1 = (await chama("POST", "/api/tarefas/lembretes", null, { Authorization: `Bearer ${CRON}` })).json || {};
  confere("primeira rodada: 1 enviado, 1 com erro, 2 pulados", r1.enviados === 1 && r1.falhas === 1 && r1.pulados === 2, JSON.stringify(r1));
  const ok = pedidos.find(p => p.corpo.to === "5527999991234");
  confere("chamou a API certa com o token", ok?.url === "/v24.0/123456/messages" && ok?.auth === "Bearer token-teste");
  confere("usou o modelo e o idioma configurados", ok?.corpo.type === "template" && ok?.corpo.template.name === "lembrete_vencimento" && ok?.corpo.template.language.code === "pt_BR");
  const params = ok?.corpo.template.components[0].parameters.map(p => espaco(p.text));
  confere("variáveis: primeiro nome, valor para quitar no vencimento e data", JSON.stringify(params) === JSON.stringify(["Ana", "R$ 1.110,00", dataBR(amanha)]), JSON.stringify(params));
  confere("não mandou para cancelado, quitado, fora do dia, sem celular nem para quem recusou", pedidos.length === 2);

  const r2 = (await chama("POST", "/api/tarefas/lembretes", null, { Authorization: `Bearer ${CRON}` })).json || {};
  confere("segunda rodada não repete o que já foi e tenta de novo o que deu erro", r2.enviados === 0 && r2.jaEnviados === 3 && r2.falhas === 1 && pedidos.length === 3, JSON.stringify(r2));

  const tela = (await chama("GET", "/api/lembretes", null, adm)).json || {};
  const st = Object.fromEntries((tela.previa || []).map(i => [i.contratoId, i.status]));
  confere("tela mostra a situação de cada lembrete de hoje", st.k1 === "enviado" && st.k2 === "erro" && st.k3 === "pulado" && st.k4 === "pulado" && !st.k5, JSON.stringify(st));
  confere("tela mostra WhatsApp e agendamento configurados", tela.whatsapp?.configurado === true && tela.agendamento === true);
  confere("histórico traz o erro do WhatsApp", (tela.historico || []).some(h => h.status === "erro" && /sem WhatsApp/.test(h.erro)));
  confere("tela de lembretes exige login", (await chama("GET", "/api/lembretes")).status === 401);

  await grava("config", "lembretes", { ativo: false, dias: [1, 0] });
  const manual = (await chama("POST", "/api/lembretes/enviar", null, adm)).json || {};
  confere("'Enviar agora' funciona mesmo desligado", manual.desligado === undefined && manual.falhas === 1);

  const pre = { nome: "Eva Rocha Teste", cpf: "529.982.247-25", rg: "7654321 SPTC/ES", telefone: "(27) 99999-5555", aceite: true,
    cep: "29160161", logradouro: "Rua A", numero: "1", bairro: "Centro", cidade: "Serra", uf: "ES",
    empresa: "Loja X", enderecoTrabalho: "Rua B, 2, Centro, Serra", ref1Nome: "Ana", ref1Parentesco: "Mãe", ref1Telefone: "27988887777" };
  await chama("POST", "/api/publico/precadastro", { ...pre, aceitaWhatsapp: true });
  await chama("POST", "/api/publico/precadastro", pre);
  const pres = ((await chama("GET", "/api/dados", null, adm)).json?.docs || []).filter(d => d.dados.origem === "link").map(d => d.dados.semLembrete);
  confere("pré-cadastro guarda se a pessoa aceitou lembretes", pres.length === 2 && pres.includes(true) && pres.includes(false));
} catch (e) {
  falhas++; console.log("ERRO", e.message);
} finally {
  srv.kill(); meta.close();
}
console.log(falhas ? `\n${falhas} teste(s) falharam` : "\nTodos os testes de lembretes passaram");
process.exit(falhas ? 1 : 0);

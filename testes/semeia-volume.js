// Enche um banco LOCAL de teste com contratos fictícios, para medir o sistema com volume parecido com o real.
// Uso: PGLITE_DIR=<pasta de teste> node testes/semeia-volume.js <ativos> <quitados>
// Só roda no banco embutido (PGlite): recusa se houver DATABASE_URL, para nunca encher um banco de verdade.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

if (process.env.DATABASE_URL) { console.error("DATABASE_URL está definida: este script só roda no banco embutido de teste."); process.exit(1); }
if (!process.env.PGLITE_DIR || process.env.PGLITE_DIR === ":memory:") { console.error("Defina PGLITE_DIR com a pasta do banco de teste."); process.exit(1); }
process.env.SESSION_SECRET ||= crypto.randomBytes(24).toString("hex");

const db = await import("../db.js"), { hashSenha } = await import("../auth.js"), { calculadora, hojeBR } = await import("../calculo.js");
const ativos = process.argv[2] === undefined ? 350 : Math.max(0, +process.argv[2] || 0), quitados = Math.max(0, +process.argv[3] || 0);
const hoje = hojeBR(), k = calculadora({}, hoje);
let semente = 12345;
const rnd = () => (semente = (semente * 1103515245 + 12345) % 2147483648) / 2147483648; // sempre os mesmos dados
const entre = (a, b) => a + Math.floor(rnd() * (b - a + 1)), r2 = v => Math.round(v * 100) / 100;
const num = (n, t) => String(n).padStart(t, "0");

await db.migrar();
const jaTem = (await db.todosDocs()).filter(d => d.colecao === "contratos").length;
const docs = [];
const poe = (col, id, dados) => docs.push([col, id, dados]);
let tx = 0;
const caixa = (dados) => { const id = "tx_v" + num(++tx + jaTem * 10, 7); poe("transacoes", id, { forma: "Pix", criadoEm: dados.data + "T12:00:00.000Z", ...dados }); return id; };

function contrato(i, quitado) {
  const cli = "cl_v" + num(i, 5), id = "ct_v" + num(i, 5), nome = "CLIENTE TESTE " + num(i, 5);
  poe("clientes", cli, { nome, cpf: `${num(i, 3)}.${num(entre(0, 999), 3)}.${num(entre(0, 999), 3)}-${num(entre(0, 99), 2)}`, rg: num(entre(1000000, 9999999), 7) + " SPTC/ES",
    telefone: `(27) 9${num(entre(8000, 9999), 4)}-${num(entre(0, 9999), 4)}`, endereco: `RUA ${entre(1, 400)}, ${entre(1, 999)} · CENTRO · SERRA/ES · 29160-000`, empresa: "EMPRESA " + entre(1, 60),
    enderecoTrabalho: `AV. ${entre(1, 90)}, ${entre(1, 999)}, SERRA`, referencias: "FAMILIAR (MÃE) — (27) 98888-0000", status: "ativo", origem: i % 3 ? "link" : "manual", criadoEm: hoje + "T12:00:00.000Z" });
  const valor = entre(3, 30) * 100, base = { tipo: "entrada", contratoId: id, clienteId: cli };
  if (!quitado && i % 10 < 3) { // 30% dos ativos: parcelado em juros simples
    const n = entre(4, 12), taxa = 10, inicio = k.addDays(hoje, -entre(20, 200)), total = r2(valor * (1 + taxa / 100 * n)), p = r2(total / n);
    const pagas = Math.min(n - 1, Math.floor(k.days(inicio, hoje) / 30) - (i % 4 === 0 ? 1 : 0));
    caixa({ tipo: "saida", valor, data: inicio, categoria: "Empréstimo concedido", descricao: "Empréstimo para " + nome, contratoId: id, clienteId: cli });
    const parcelas = Array.from({ length: n }, (_, j) => {
      const venc = k.addDays(inicio, 30 * (j + 1)), paga = j < pagas;
      return { n: j + 1, venc, valor: j === n - 1 ? r2(total - p * (n - 1)) : p, quitada: paga,
        pagamentos: paga ? [{ data: venc, valor: p, forma: "Pix", txId: caixa({ ...base, valor: p, data: venc, categoria: "Recebimento de parcela", descricao: `Parcela ${j + 1}/${n} · ${nome}` }) }] : [] };
    });
    return poe("contratos", id, { clienteId: cli, valor, taxa, modalidade: "simples", periodicidade: "mensal", nParcelas: n, primeiroVenc: parcelas[0].venc, dataContrato: inicio, multa: 2, mora: 0.33, obs: "", parcelas, criadoEm: inicio + "T12:00:00.000Z" });
  }
  // saldo devedor com juros por dia: alguns pagamentos só de juros, cada um empurrando o vencimento 30 dias
  const taxa = i % 2 ? 25 : 27.5, pagos = quitado ? entre(1, 3) : entre(0, 4), fim = quitado ? k.addDays(hoje, -entre(10, 700)) : hoje;
  const inicio = k.addDays(fim, -(30 * (pagos + 1) + entre(0, 25)));
  const c = { clienteId: cli, valor, taxa, modalidade: "saldo", dataContrato: inicio, primeiroVenc: k.addDays(inicio, 30), vencimento: k.addDays(inicio, 30), movimentos: [], renegociacoes: [], parcelas: [], obs: "", criadoEm: inicio + "T12:00:00.000Z" };
  caixa({ tipo: "saida", valor, data: inicio, categoria: "Empréstimo concedido", descricao: "Empréstimo para " + nome, contratoId: id, clienteId: cli });
  for (let j = 0; j < pagos; j++) {
    const data = k.addDays(inicio, 30 * (j + 1)), x = k.extrato({ ...c }, data), ultimo = quitado && j === pagos - 1; // cópia: o extrato fica guardado por objeto
    const v = ultimo ? x.saldoHoje : x.jurosHoje, juros = Math.min(v, x.jurosHoje), capital = r2(v - juros), m = { id: `mv_v${num(i, 5)}_${j}`, data, valor: v, juros, capital, forma: "Pix", criadoEm: data + "T12:00:00.000Z" };
    if (juros > 0) m.txJ = caixa({ ...base, valor: juros, data, categoria: "Pagamento de juros", descricao: "Juros · " + nome });
    if (capital > 0) m.txC = caixa({ ...base, valor: capital, data, categoria: "Pagamento de capital", descricao: "Capital · " + nome });
    if (!ultimo) { m.vencAnterior = c.vencimento; const para = k.addDays(data, 30); c.renegociacoes.push({ data, de: c.vencimento, para, motivo: "Pagamento", movId: m.id }); c.vencimento = para; }
    c.movimentos.push(m);
  }
  if (!quitado && i % 7 === 0) c.vencimento = k.addDays(hoje, -entre(1, 40)); // alguns em atraso
  if (!quitado && i % 9 === 0) c.vencimento = k.addDays(hoje, entre(0, 1));   // alguns vencendo hoje e amanhã (lembretes)
  if (!quitado && i % 31 === 0) c.inad = { motivo: "Não atende o telefone", em: hoje };
  poe("contratos", id, c);
}

for (let i = 1; i <= ativos + quitados; i++) contrato(jaTem + i, i > ativos);
const t0 = Date.now();
await db.emTransacao(async q => { for (const [col, id, dados] of docs) await db.gravar(col, id, dados, null, q); });

// usuário de teste (administrador), com a senha gravada num arquivo ao lado do banco
const arq = path.join(path.dirname(path.resolve(process.env.PGLITE_DIR)), "login-volume.txt");
if (!(await db.usuarios.porEmail("volume@teste.local"))) {
  const senha = crypto.randomBytes(9).toString("base64url");
  await db.usuarios.criar({ email: "volume@teste.local", nome: "Teste de Volume", senha: await hashSenha(senha), papel: "admin", trocarSenha: false });
  fs.writeFileSync(arq, `volume@teste.local\n${senha}\n`);
}
const cont = {};
for (const d of await db.todosDocs()) cont[d.colecao] = (cont[d.colecao] || 0) + 1;
console.log(`gravados ${docs.length} documentos em ${((Date.now() - t0) / 1000).toFixed(1)} s | no banco agora: ${JSON.stringify(cont)} | login em ${arq}`);
process.exit(0);

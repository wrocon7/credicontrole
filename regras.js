// Regras do que pode ser gravado: o que só o administrador faz (proibido) e o formato mínimo de cada registro
// (invalido). Ficam fora do server.js para serem testadas e para conferir dados já existentes contra elas.

// Comparação que não depende da ordem das chaves (o banco reordena as chaves do JSON).
const canonico = v => JSON.stringify(v, (k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(c => [c, x[c]])) : x));
const igual = (a, b) => canonico(a) === canonico(b);
// O que define a dívida: depois de criado o contrato, só o administrador mexe.
const FIXOS_CONTRATO = ["clienteId", "valor", "taxa", "modalidade", "dataContrato", "primeiroVenc", "periodicidade", "nParcelas", "multa", "mora", "parcelaFixa"];

// O que só o administrador pode fazer. Devolve o motivo da recusa, ou null. O operador cria registros, acrescenta
// pagamentos, renegocia vencimento e marca inadimplência; não apaga nem reescreve o que já foi lançado.
// opc.operadorRecebe: o administrador liberou os operadores para registrar recebimentos (dar baixa).
const temPagamento = c => (c.movimentos || []).length > 0 || (c.parcelas || []).some(p => (p.pagamentos || []).length > 0);
const pagamentos = c => (c.movimentos || []).length + (c.parcelas || []).reduce((a, p) => a + (p.pagamentos || []).length, 0);
export function proibido(u, op, col, antes, novo, opc = {}) {
  if (u.papel === "admin") return null;
  const baixa = "Só o administrador dá baixa em pagamentos.";
  if (col === "config") return "Só o administrador altera as configurações.";
  if (op === "excluir") return col === "clientes" && antes?.status === "pre" ? null : "Só o administrador exclui registros.";
  if (col === "transacoes" && !antes) { // o operador só lança no caixa o recebimento de um contrato, e só se estiver liberado
    if (novo.tipo !== "entrada" || !novo.contratoId) return "Só o administrador faz outros lançamentos no caixa.";
    if (!opc.operadorRecebe) return baixa;
  }
  if (col === "contratos" && !antes && temPagamento(novo)) return baixa;
  if (!antes) return null;
  if (col === "transacoes" || col === "avisos") return "Só o administrador altera um lançamento já gravado.";
  if (col === "contratos") {
    if (!!novo.pendente !== !!antes.pendente) return "Só o administrador confirma o Pix de um contrato.";
    if (!opc.operadorRecebe && pagamentos(novo) > pagamentos(antes)) return baixa;
    if (!!novo.cancelado !== !!antes.cancelado) return "Só o administrador cancela ou reativa contratos.";
    if (FIXOS_CONTRATO.some(k => !igual(antes[k], novo[k]))) return "Só o administrador altera valor, taxa ou datas de um contrato.";
    const pagos = "Só o administrador estorna ou altera pagamentos já lançados.";
    const am = antes.movimentos || [], nm = novo.movimentos || [];
    if (am.some((m, i) => !igual(m, nm[i]))) return pagos;
    const ap = antes.parcelas || [], np = novo.parcelas || [];
    if (ap.length !== np.length) return "Só o administrador altera as parcelas de um contrato.";
    for (let i = 0; i < ap.length; i++) {
      const p = ap[i], q = np[i] || {}, pp = p.pagamentos || [], qp = q.pagamentos || [];
      if (p.n !== q.n || p.venc !== q.venc || p.valor !== q.valor) return "Só o administrador altera as parcelas de um contrato.";
      if (pp.some((g, j) => !igual(g, qp[j]))) return pagos;
      if (!!q.quitada !== !!p.quitada && (p.quitada || qp.length === pp.length)) return "Uma parcela só é quitada junto com o registro do pagamento.";
    }
  }
  return null;
}

// Confere o formato do que vai ser gravado: número onde a tela faz conta, data onde a tela compara datas. Um valor
// torto aqui quebraria o painel inteiro (ou entraria como texto na página). Devolve o problema, ou null.
const numero = v => typeof v === "number" && Number.isFinite(v);
const dataISO = v => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
const pagamentoOk = g => g && typeof g === "object" && dataISO(g.data) && numero(g.valor) && g.valor > 0;
export function invalido(col, id, d) {
  if (col === "clientes" && (typeof d.nome !== "string" || !d.nome.trim())) return "Cliente sem nome.";
  if (col === "transacoes" && (!["entrada", "saida"].includes(d.tipo) || !numero(d.valor) || d.valor <= 0 || !dataISO(d.data))) return "Lançamento inválido: confira tipo, valor e data.";
  if (col === "config" && id === "lembretes" && (!Array.isArray(d.dias) || !d.dias.length || d.dias.length > 10 || d.dias.some(n => !Number.isInteger(n) || n < -60 || n > 30))) return "Dias de lembrete inválidos.";
  if (col === "contratos") {
    if (typeof d.clienteId !== "string" || !d.clienteId) return "Contrato sem cliente.";
    if (d.pendente && temPagamento(d)) return "Contrato aguardando a confirmação do Pix ainda não recebe pagamento.";
    if (d.parcelaFixa != null && (!numero(d.parcelaFixa) || d.parcelaFixa <= 0)) return "Valor da parcela inválido.";
    if (!numero(d.valor) || d.valor <= 0) return "Valor do contrato inválido.";
    if (!numero(d.taxa) || d.taxa < 0 || d.taxa > 1000) return "Taxa de juros inválida.";
    if (!dataISO(d.dataContrato)) return "Data do contrato inválida.";
    for (const k of ["multa", "mora"]) if (d[k] != null && (!numero(d[k]) || d[k] < 0)) return "Multa ou mora inválida.";
    if (d.modalidade === "saldo") {
      if (!dataISO(d.vencimento)) return "Vencimento inválido.";
      if (!Array.isArray(d.movimentos ?? []) || (d.movimentos || []).some(m => !pagamentoOk(m) || typeof m.id !== "string")) return "Pagamento inválido: confira valor e data.";
    } else if (["simples", "price", "juros"].includes(d.modalidade)) {
      if (!Array.isArray(d.parcelas) || !d.parcelas.length || d.parcelas.length > 400) return "Parcelas inválidas.";
      for (const p of d.parcelas) {
        if (!p || !Number.isInteger(p.n) || !dataISO(p.venc) || !numero(p.valor) || p.valor < 0) return "Parcela inválida.";
        if (!Array.isArray(p.pagamentos ?? []) || (p.pagamentos || []).some(g => !pagamentoOk(g))) return "Pagamento inválido: confira valor e data.";
      }
    } else return "Modalidade de contrato inválida.";
  }
  return null;
}

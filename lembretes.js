// Lembretes de vencimento pelo WhatsApp: API oficial da Meta (Cloud API) com uma mensagem modelo aprovada.
// Uma tarefa diária (agendada fora daqui, ver DEPLOY.md) chama executar(); cada lembrete sai uma vez só.
import * as db from "./db.js";
import { calculadora, hojeBR } from "./calculo.js";

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const fdata = s => String(s).split("-").reverse().join("/");
export const PADRAO = { ativo: false, dias: [1, 0] };

export const whatsapp = () => ({
  configurado: !!(process.env.WHATSAPP_PHONE_NUMBER_ID && process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_TEMPLATE),
  modelo: process.env.WHATSAPP_TEMPLATE || null,
  idioma: process.env.WHATSAPP_TEMPLATE_LANG || "pt_BR",
});

// Celular no formato que a Meta pede (55 + DDD + número), ou null.
export function telefoneWhats(t) {
  let d = String(t || "").replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;
  return /^55\d{10,11}$/.test(d) ? d : null;
}

// O que vence nos dias configurados. dias = quantos dias faltam para o vencimento: 1 = amanhã, 0 = hoje, -3 = três dias atrasado.
export async function pendentes(hoje = hojeBR()) {
  const conf = { ...PADRAO, ...((await db.ler("config", "lembretes")) || {}) };
  const docs = await db.todosDocs();
  const geral = docs.find(d => d.colecao === "config" && d.id === "geral")?.dados || {};
  const k = calculadora(geral, hoje), clientes = new Map(docs.filter(d => d.colecao === "clientes").map(d => [d.id, d.dados]));
  const itens = [];
  for (const { id, dados: c } of docs.filter(d => d.colecao === "contratos")) {
    if (c.cancelado || c.pendente) continue; // pendente = lançado pelo operador, ainda sem o Pix confirmado
    const vencendo = [];
    if (c.modalidade === "saldo") {
      const x = k.extrato(c, hoje);
      if (x.quitado) continue;
      const v = c.vencimento; // antes do vencimento: o que quita nele; depois: o saldo de hoje (mesma regra da tela)
      vencendo.push({ parcela: "saldo", venc: v, valor: v > hoje ? Math.round(x.saldoBase * (1 + x.taxaDia * Math.max(0, k.days(x.ultima, v))) * 100) / 100 : x.saldoHoje });
    } else {
      for (const p of c.parcelas || []) if (!k.quitadaP(p)) vencendo.push({ parcela: p.n, venc: p.venc, valor: k.encargos(p, c, hoje).devido });
    }
    const cli = clientes.get(c.clienteId) || {};
    for (const it of vencendo) {
      const falta = k.days(hoje, it.venc);
      if (!conf.dias.includes(falta)) continue;
      const telefone = telefoneWhats(cli.telefone);
      itens.push({ chave: `${id}|${it.parcela}|${it.venc}|${falta}`, contratoId: id, clienteId: c.clienteId, nome: cli.nome || "", telefone, falta, ...it,
        motivo: cli.semLembrete ? "cliente não quer" : !telefone ? "sem celular válido" : null });
    }
  }
  return { conf, itens };
}

async function envia(it) {
  const base = process.env.WHATSAPP_API_URL || "https://graph.facebook.com", versao = process.env.WHATSAPP_API_VERSION || "v24.0";
  const r = await fetch(`${base}/${versao}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp", to: it.telefone, type: "template",
      template: {
        name: process.env.WHATSAPP_TEMPLATE, language: { code: whatsapp().idioma },
        components: [{ type: "body", parameters: [it.nome.split(" ")[0] || "cliente", BRL.format(it.valor), fdata(it.venc)].map(text => ({ type: "text", text })) }],
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error?.message || `WhatsApp respondeu ${r.status}`);
  return j.messages?.[0]?.id || null;
}

// forcar = enviar mesmo com os lembretes desligados (botão "Enviar agora" do administrador).
export async function executar({ hoje = hojeBR(), forcar = false } = {}) {
  const { conf, itens } = await pendentes(hoje);
  if (!conf.ativo && !forcar) return { desligado: true, enviados: 0, pulados: 0, falhas: 0 };
  if (!whatsapp().configurado) return { erro: "O WhatsApp não está configurado no servidor.", enviados: 0, pulados: 0, falhas: 0 };
  const total = { enviados: 0, pulados: 0, falhas: 0, jaEnviados: 0 };
  for (const it of itens) {
    if (!(await db.lembretes.reservar({ ...it, status: it.motivo ? "pulado" : "enviando" }))) { total.jaEnviados++; continue; }
    if (it.motivo) { await db.lembretes.concluir(it.chave, { status: "pulado", erro: it.motivo }); total.pulados++; continue; }
    try {
      await db.lembretes.concluir(it.chave, { status: "enviado", wamid: await envia(it) });
      total.enviados++;
    } catch (e) {
      await db.lembretes.concluir(it.chave, { status: "erro", erro: String(e.message).slice(0, 300) });
      total.falhas++;
    }
  }
  return total;
}

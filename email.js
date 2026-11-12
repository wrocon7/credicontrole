// Envio de e-mail (por enquanto, só o link de recuperação de senha). Usa SMTP pelas variáveis SMTP_*; sem elas,
// nada é enviado e o pedido fica só para o administrador ver em Usuários. EMAIL_ARQUIVO é só para os testes:
// grava cada mensagem num arquivo em vez de enviar.
import fs from "node:fs";
import nodemailer from "nodemailer";

let transporte = null;
export const emailConfigurado = () => !!(process.env.SMTP_HOST || process.env.EMAIL_ARQUIVO);

function abre() {
  if (transporte) return transporte;
  if (process.env.SMTP_HOST) {
    const porta = +process.env.SMTP_PORT || 465;
    transporte = nodemailer.createTransport({
      host: process.env.SMTP_HOST, port: porta, secure: porta === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  } else if (process.env.EMAIL_ARQUIVO) transporte = nodemailer.createTransport({ jsonTransport: true });
  return transporte;
}

export async function enviar({ para, assunto, texto }) {
  const t = abre();
  if (!t) return false;
  const r = await t.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER || "CrediControle <nao-responda@localhost>", to: para, subject: assunto, text: texto });
  if (process.env.EMAIL_ARQUIVO) fs.appendFileSync(process.env.EMAIL_ARQUIVO, r.message + "\n");
  return true;
}

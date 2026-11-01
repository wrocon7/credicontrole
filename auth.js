// Senhas com scrypt (nativo do Node) e sessão num cookie assinado com HMAC: sem tabela de sessões nem dependências.
import crypto from "node:crypto";

const SEGREDO = process.env.SESSION_SECRET || (() => {
  console.warn("SESSION_SECRET não definido: todo mundo é deslogado quando o servidor reinicia.");
  return crypto.randomBytes(32).toString("hex");
})();
export const DURACAO_SESSAO = 12 * 3600 * 1000;

export function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  return `scrypt$${sal.toString("hex")}$${crypto.scryptSync(senha, sal, 32).toString("hex")}`;
}

export function confereSenha(senha, guardada) {
  const [tipo, sal, hash] = String(guardada).split("$");
  if (tipo !== "scrypt" || !sal || !hash) return false;
  const calc = crypto.scryptSync(senha, Buffer.from(sal, "hex"), 32);
  return crypto.timingSafeEqual(calc, Buffer.from(hash, "hex"));
}

const assina = texto => crypto.createHmac("sha256", SEGREDO).update(texto).digest("base64url");

export function criarToken(usuarioId) {
  const corpo = `${usuarioId}.${Date.now() + DURACAO_SESSAO}`;
  return `${corpo}.${assina(corpo)}`;
}

// Devolve o id do usuário, ou null se o token é inválido ou venceu.
export function lerToken(token) {
  const [id, vence, assinatura] = String(token || "").split(".");
  if (!assinatura) return null;
  const esperada = assina(`${id}.${vence}`);
  if (esperada.length !== assinatura.length || !crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(assinatura))) return null;
  if (!(+vence > Date.now())) return null;
  return +id || null;
}

export function lerCookies(req) {
  const out = {};
  for (const parte of (req.headers.cookie || "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0) out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}

// Limite simples em memória: até `max` eventos por chave dentro da janela.
export function limitador(max, janelaMs) {
  const mapa = new Map();
  return chave => {
    const agora = Date.now(), lista = (mapa.get(chave) || []).filter(t => agora - t < janelaMs);
    if (lista.length >= max) { mapa.set(chave, lista); return false; }
    lista.push(agora);
    mapa.set(chave, lista);
    if (mapa.size > 5000) mapa.clear();
    return true;
  };
}

export function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += +cpf[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === +cpf[9] && dv(10) === +cpf[10];
}

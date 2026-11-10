// Senhas com scrypt (nativo do Node) e sessão num cookie assinado com HMAC: sem tabela de sessões nem dependências.
import crypto from "node:crypto";
import { promisify } from "node:util";

const SEGREDO = process.env.SESSION_SECRET || (() => {
  console.warn("SESSION_SECRET não definido: todo mundo é deslogado quando o servidor reinicia.");
  return crypto.randomBytes(32).toString("hex");
})();
export const DURACAO_SESSAO = 12 * 3600 * 1000;

if (process.env.NODE_ENV === "production" && SEGREDO.length < 32) console.warn("SESSION_SECRET curto: use um texto aleatório de 32 caracteres ou mais.");

// scrypt fora da linha principal (não trava o servidor enquanto calcula). O custo vai gravado junto do hash, para
// poder subir depois: formato "scrypt$N$sal$hash". O formato antigo, "scrypt$sal$hash", usava N = 16384.
const scrypt = promisify(crypto.scrypt);
const CUSTO = 32768, CUSTO_ANTIGO = 16384;
export const SENHA_MAX = 200; // senha gigante só serve para gastar processamento
const derivar = (senha, sal, N) => scrypt(senha, sal, 32, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const partes = guardada => { const p = String(guardada).split("$"); return p.length === 4 ? { tipo: p[0], N: +p[1], sal: p[2], hash: p[3] } : { tipo: p[0], N: CUSTO_ANTIGO, sal: p[1], hash: p[2] }; };

export async function hashSenha(senha) {
  const sal = crypto.randomBytes(16);
  return `scrypt$${CUSTO}$${sal.toString("hex")}$${(await derivar(senha, sal, CUSTO)).toString("hex")}`;
}

export async function confereSenha(senha, guardada) {
  const { tipo, N, sal, hash } = partes(guardada);
  if (tipo !== "scrypt" || !sal || !hash || ![16384, 32768, 65536].includes(N) || String(senha).length > SENHA_MAX) return false;
  const calc = await derivar(String(senha), Buffer.from(sal, "hex"), N), esperado = Buffer.from(hash, "hex");
  return calc.length === esperado.length && crypto.timingSafeEqual(calc, esperado);
}

// true = a senha foi guardada com custo menor que o atual; quem acabou de conferir a senha pode regravar o hash.
export const hashFraco = guardada => partes(guardada).N < CUSTO;

// Hash de uma senha que ninguém tem: o login confere contra ele quando o e-mail não existe, para a resposta levar
// o mesmo tempo e não revelar quais e-mails estão cadastrados.
export const HASH_FALSO = await hashSenha(crypto.randomBytes(24).toString("hex"));

const assina = texto => crypto.createHmac("sha256", SEGREDO).update(texto).digest("base64url");

// O token leva a versão de sessão do usuário: trocar a senha sobe a versão e os tokens antigos deixam de valer.
export function criarToken(usuario) {
  const corpo = `${usuario.id}.${usuario.sessao_versao}.${Date.now() + DURACAO_SESSAO}`;
  return `${corpo}.${assina(corpo)}`;
}

// Devolve { id, versao }, ou null se o token é inválido ou venceu.
export function lerToken(token) {
  const [id, versao, vence, assinatura] = String(token || "").split(".");
  if (!assinatura) return null;
  const esperada = assina(`${id}.${versao}.${vence}`);
  if (esperada.length !== assinatura.length || !crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(assinatura))) return null;
  if (!(+vence > Date.now()) || !(+id > 0)) return null;
  return { id: +id, versao: +versao };
}

export function lerCookies(req) {
  const out = {};
  for (const parte of (req.headers.cookie || "").split(";")) {
    const i = parte.indexOf("=");
    if (i > 0) out[parte.slice(0, i).trim()] = decodeURIComponent(parte.slice(i + 1).trim());
  }
  return out;
}

// Limite simples em memória: até `max` eventos por chave dentro da janela. A faxina tira só as chaves que já
// venceram (nunca zera quem está bloqueado) e roda no máximo uma vez a cada 10 segundos.
export function limitador(max, janelaMs) {
  const mapa = new Map();
  let faxina = Date.now();
  return chave => {
    const agora = Date.now();
    if (agora - faxina > janelaMs || (mapa.size > 20000 && agora - faxina > 10000)) {
      for (const [k, l] of mapa) if (!(agora - l[l.length - 1] < janelaMs)) mapa.delete(k);
      faxina = agora;
    }
    const lista = (mapa.get(chave) || []).filter(t => agora - t < janelaMs);
    if (lista.length >= max) { mapa.set(chave, lista); return false; }
    lista.push(agora);
    mapa.set(chave, lista);
    return true;
  };
}

export function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += +cpf[i] * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === +cpf[9] && dv(10) === +cpf[10];
}

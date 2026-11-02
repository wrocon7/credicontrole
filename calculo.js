// Cálculo de parcelas, encargos e saldo devedor para o servidor, lido da própria tela (app/credicontrole.html,
// trecho entre "calculo:inicio" e "calculo:fim") para as contas do lembrete baterem sempre com as da tela.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const html = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "app", "credicontrole.html"), "utf8");
const trecho = re => { const m = html.match(re); if (!m) throw new Error("calculo.js: trecho não encontrado na tela: " + re); return m[0]; };
const auxiliares = ["r2", "pad", "iso", "parse", "days", "addDays", "addMonths"].map(n => trecho(new RegExp(`const ${n}=.*\\n`))).join("");
const bloco = trecho(/\/\* calculo:inicio[\s\S]*?\/\* calculo:fim \*\//);

// Data de hoje no fuso de Brasília (o servidor roda em UTC).
export const hojeBR = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);

// config = documento config/geral (multa e mora padrão); hoje = "AAAA-MM-DD"
export function calculadora(config = {}, hoje = hojeBR()) {
  const padrao = { multa: 2, mora: 0.33 };
  return new Function("cfg", "today", `${auxiliares}${bloco}\nreturn { encargos, extrato, pagoP, quitadaP, days, addDays };`)(
    k => config[k] ?? padrao[k], () => hoje);
}

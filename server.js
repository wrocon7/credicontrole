// CrediControle em servidor próprio: login por usuário, a mesma tela da versão do claude.ai (ligada à API por
// public/assets/web.js) e um formulário público de pré-cadastro.
import express from "express";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";
import { hashSenha, confereSenha, criarToken, lerToken, lerCookies, limitador, cpfValido, DURACAO_SESSAO } from "./auth.js";

const raiz = path.dirname(fileURLToPath(import.meta.url));
const PORTA = +process.env.PORT || 3300;
const PRODUCAO = process.env.NODE_ENV === "production";
const AVISO_PADRAO = "Os dados informados serão usados apenas para analisar o seu pedido de crédito e entrar em contato com você. Você pode pedir a correção ou a exclusão dos seus dados a qualquer momento.";

const pagina = readFileSync(path.join(raiz, "app", "credicontrole.html"), "utf8");
const INDEX = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"></head><body><script src="/assets/web.js"></script>\n${pagina}\n</body></html>`;
const arquivo = nome => path.join(raiz, "public", nome);

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "DENY" });
  next();
});
app.use(express.json({ limit: "1mb" }));

const assincrono = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function usuarioDe(req) {
  const id = lerToken(lerCookies(req).cc_sessao);
  if (!id) return null;
  const u = await db.usuarios.porId(id);
  return u && u.ativo ? u : null;
}
const exige = papel => assincrono(async (req, res, next) => {
  const u = await usuarioDe(req);
  if (!u) return res.status(401).json({ erro: "Faça login." });
  if (papel === "admin" && u.papel !== "admin") return res.status(403).json({ erro: "Só administradores." });
  req.u = u;
  next();
});

/* ---------- páginas ---------- */
app.get("/", assincrono(async (req, res) => {
  if (!(await usuarioDe(req))) return res.redirect("/login");
  res.type("html").send(INDEX);
}));
app.get("/login", (req, res) => res.sendFile(arquivo("login.html")));
app.get("/cadastro", (req, res) => res.sendFile(arquivo("cadastro.html")));
app.get("/usuarios", assincrono(async (req, res) => {
  const u = await usuarioDe(req);
  if (!u) return res.redirect("/login");
  if (u.papel !== "admin") return res.redirect("/");
  res.sendFile(arquivo("usuarios.html"));
}));
app.use("/assets", express.static(path.join(raiz, "public", "assets"), { maxAge: PRODUCAO ? "1h" : 0 }));
app.get("/saude", (req, res) => res.json({ ok: true }));

/* ---------- login ---------- */
const tentativas = limitador(10, 15 * 60e3);
app.post("/api/login", assincrono(async (req, res) => {
  const email = String(req.body?.email || "").trim(), senha = String(req.body?.senha || "");
  if (!tentativas(req.ip + "|" + email.toLowerCase())) return res.status(429).json({ erro: "Muitas tentativas. Espere 15 minutos." });
  const u = email && (await db.usuarios.porEmail(email));
  if (!u || !u.ativo || !confereSenha(senha, u.senha)) return res.status(401).json({ erro: "E-mail ou senha incorretos." });
  res.cookie("cc_sessao", criarToken(u.id), { httpOnly: true, sameSite: "lax", secure: PRODUCAO, maxAge: DURACAO_SESSAO, path: "/" });
  res.json({ ok: true });
}));
app.post("/api/logout", (req, res) => { res.clearCookie("cc_sessao", { path: "/" }); res.json({ ok: true }); });
app.get("/api/eu", exige(), (req, res) => res.json({ id: req.u.id, nome: req.u.nome, email: req.u.email, papel: req.u.papel }));

/* ---------- dados da carteira ---------- */
app.get("/api/dados", exige(), assincrono(async (req, res) => res.json(await db.listar(Math.max(0, +req.query.desde || 0)))));

function docValido(req, res, comCorpo = true) {
  const { col, id } = req.params;
  if (!db.COLECOES.has(col) || !/^[A-Za-z0-9_.-]{1,120}$/.test(id)) { res.status(400).json({ erro: "Documento inválido." }); return false; }
  if (comCorpo && (!req.body || typeof req.body !== "object" || Array.isArray(req.body))) { res.status(400).json({ erro: "Dados inválidos." }); return false; }
  return true;
}
app.put("/api/doc/:col/:id", exige(), assincrono(async (req, res) => {
  if (!docValido(req, res)) return;
  await db.gravar(req.params.col, req.params.id, req.body);
  res.json({ ok: true });
}));
app.patch("/api/doc/:col/:id", exige(), assincrono(async (req, res) => {
  if (!docValido(req, res)) return;
  if (!(await db.mesclar(req.params.col, req.params.id, req.body))) return res.status(404).json({ erro: "Documento não encontrado." });
  res.json({ ok: true });
}));
app.delete("/api/doc/:col/:id", exige(), assincrono(async (req, res) => {
  if (!docValido(req, res, false)) return;
  await db.excluir(req.params.col, req.params.id);
  res.json({ ok: true });
}));

/* ---------- usuários (só administrador) ---------- */
const PAPEIS = ["admin", "operador"];
app.get("/api/usuarios", exige("admin"), assincrono(async (req, res) => res.json(await db.usuarios.listar())));
app.post("/api/usuarios", exige("admin"), assincrono(async (req, res) => {
  const nome = String(req.body?.nome || "").trim(), email = String(req.body?.email || "").trim().toLowerCase();
  const senha = String(req.body?.senha || ""), papel = PAPEIS.includes(req.body?.papel) ? req.body.papel : "operador";
  if (!nome || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ erro: "Informe nome e e-mail válidos." });
  if (senha.length < 8) return res.status(400).json({ erro: "A senha precisa ter pelo menos 8 caracteres." });
  try {
    res.json({ id: await db.usuarios.criar({ email, nome, senha: hashSenha(senha), papel }) });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ erro: "Já existe um usuário com esse e-mail." });
    throw e;
  }
}));
app.patch("/api/usuarios/:id", exige("admin"), assincrono(async (req, res) => {
  const id = +req.params.id, b = req.body || {}, campos = {};
  if (!(await db.usuarios.porId(id))) return res.status(404).json({ erro: "Usuário não encontrado." });
  if (id === req.u.id && (b.ativo === false || (b.papel && b.papel !== "admin"))) return res.status(400).json({ erro: "Você não pode desativar nem rebaixar o seu próprio usuário." });
  if (typeof b.ativo === "boolean") campos.ativo = b.ativo;
  if (PAPEIS.includes(b.papel)) campos.papel = b.papel;
  if (typeof b.nome === "string" && b.nome.trim()) campos.nome = b.nome.trim();
  if (b.senha !== undefined) {
    if (String(b.senha).length < 8) return res.status(400).json({ erro: "A senha precisa ter pelo menos 8 caracteres." });
    campos.senha = hashSenha(String(b.senha));
  }
  await db.usuarios.alterar(id, campos);
  res.json({ ok: true });
}));

/* ---------- pré-cadastro público ---------- */
app.get("/api/publico/info", assincrono(async (req, res) => {
  const c = (await db.ler("config", "geral")) || {};
  res.json({ nome: c.empresaPublica || c.nome || "", aviso: c.avisoPrivacidade || AVISO_PADRAO });
}));
const envios = limitador(5, 3600e3);
app.post("/api/publico/precadastro", assincrono(async (req, res) => {
  const b = req.body || {};
  if (b.site) return res.json({ ok: true }); // campo escondido: só robô preenche
  const t = (v, n = 120) => String(v ?? "").trim().slice(0, n);
  const num = v => { const x = parseFloat(String(v ?? "").replace(/\./g, "").replace(",", ".")); return x > 0 ? Math.round(x * 100) / 100 : null; };
  const nome = t(b.nome), cpf = t(b.cpf, 20).replace(/\D/g, ""), telefone = t(b.telefone, 30);
  if (nome.length < 5 || !nome.includes(" ")) return res.status(400).json({ erro: "Informe o nome completo." });
  if (!cpfValido(cpf)) return res.status(400).json({ erro: "CPF inválido." });
  if (telefone.replace(/\D/g, "").length < 10) return res.status(400).json({ erro: "Informe um telefone com DDD." });
  if (b.aceite !== true) return res.status(400).json({ erro: "É preciso concordar com o uso dos dados." });
  if (!envios(req.ip)) return res.status(429).json({ erro: "Muitos envios deste aparelho. Tente de novo mais tarde." });

  const uf = t(b.uf, 2).toUpperCase(), cidade = t(b.cidade, 80);
  const endereco = [[t(b.logradouro), t(b.numero, 20)].filter(Boolean).join(", "), t(b.bairro, 80), cidade && (cidade + (uf ? "/" + uf : "")), t(b.cep, 9)].filter(Boolean).join(" · ");
  const referencias = [1, 2].map(i => [t(b[`ref${i}Nome`], 80), t(b[`ref${i}Parentesco`], 40), t(b[`ref${i}Telefone`], 30)])
    .filter(([n, , f]) => n || f).map(([n, p, f]) => `${n}${p ? ` (${p})` : ""}${f ? ` — ${f}` : ""}`).join("\n");
  const ja = await db.clientePorCpf(cpf), agora = new Date().toISOString();
  await db.gravar("clientes", "cl" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex"), {
    nome, cpf: cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4"), telefone, email: t(b.email),
    endereco, cep: t(b.cep, 9), logradouro: t(b.logradouro), numero: t(b.numero, 20), bairro: t(b.bairro, 80), cidade, uf,
    empresa: t(b.empresa), tempoRegistro: t(b.tempoRegistro, 40), renda: num(b.renda), valorPretendido: num(b.valorPretendido),
    referencias, franquia: t(b.franquia, 30), origem: "link",
    obs: ja ? `Atenção: este CPF já está cadastrado (${ja.nome}).` : "",
    status: "pre", criadoEm: agora, aceitePrivacidadeEm: agora,
  });
  res.json({ ok: true });
}));

app.use((req, res) => res.status(404).json({ erro: "Não encontrado." }));
app.use((e, req, res, next) => {
  console.error(e);
  if (res.headersSent) return next(e);
  res.status(e.type === "entity.parse.failed" ? 400 : 500).json({ erro: e.type === "entity.parse.failed" ? "Dados inválidos." : "Erro no servidor." });
});

await db.migrar();
if ((await db.usuarios.contar()) === 0) {
  const email = process.env.ADMIN_EMAIL, senha = process.env.ADMIN_SENHA;
  if (email && senha && senha.length >= 8) {
    await db.usuarios.criar({ email: email.toLowerCase(), nome: "Administrador", senha: hashSenha(senha), papel: "admin" });
    console.log("Administrador criado:", email);
  } else console.warn("Nenhum usuário cadastrado. Defina ADMIN_EMAIL e ADMIN_SENHA (8+ caracteres) para criar o primeiro administrador.");
}
app.listen(PORTA, () => console.log(`CrediControle em http://localhost:${PORTA}`));

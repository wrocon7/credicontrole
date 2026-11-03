// CrediControle em servidor próprio: login por usuário, a mesma tela da versão do claude.ai (ligada à API por
// public/assets/web.js), um formulário público de pré-cadastro, auditoria de tudo o que muda e cópia de segurança.
import express from "express";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as db from "./db.js";
import * as lembretes from "./lembretes.js";
import { hojeBR } from "./calculo.js";
import { hashSenha, confereSenha, criarToken, lerToken, lerCookies, limitador, cpfValido, DURACAO_SESSAO } from "./auth.js";

const raiz = path.dirname(fileURLToPath(import.meta.url));
const PORTA = +process.env.PORT || 3300;
const PRODUCAO = process.env.NODE_ENV === "production";
const AVISO_PADRAO = "Os dados informados serão usados apenas para analisar o seu pedido de crédito e entrar em contato com você. Você pode pedir a correção ou a exclusão dos seus dados a qualquer momento.";

const ler = nome => readFileSync(path.join(raiz, "public", nome), "utf8");
const PAGINAS = {
  index: `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"></head><body><script src="/assets/web.js"></script>\n${readFileSync(path.join(raiz, "app", "credicontrole.html"), "utf8")}\n</body></html>`,
  login: ler("login.html"), cadastro: ler("cadastro.html"), usuarios: ler("usuarios.html"),
  auditoria: ler("auditoria.html"), "trocar-senha": ler("trocar-senha.html"), lembretes: ler("lembretes.html"),
};

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// Cabeçalhos de segurança. Scripts só do próprio servidor ou com o nonce desta resposta; dados só para cá
// (e para o ViaCEP e a BrasilAPI, que preenchem o endereço pelo CEP no pré-cadastro).
const csp = nonce => [
  "default-src 'self'", `script-src 'self' 'nonce-${nonce}'`, "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self' https://viacep.com.br https://brasilapi.com.br",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'",
].join("; ");
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString("base64");
  res.set({
    "Content-Security-Policy": csp(res.locals.nonce), "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY", "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  if (PRODUCAO) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (req.path.startsWith("/api/")) res.set("Cache-Control", "no-store");
  next();
});
app.use(express.json({ limit: "1mb" }));

const assincrono = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const pagina = (res, nome) => res.type("html").send(PAGINAS[nome].replace(/<script(?=[\s>])/g, `<script nonce="${res.locals.nonce}"`));
const cookieSessao = (res, u) => res.cookie("cc_sessao", criarToken(u), { httpOnly: true, sameSite: "lax", secure: PRODUCAO, maxAge: DURACAO_SESSAO, path: "/" });
const audita = (req, dados) => db.auditar({ usuario: req.u, ip: req.ip, ...dados }).catch(e => console.error("auditoria:", e));

async function usuarioDe(req) {
  const t = lerToken(lerCookies(req).cc_sessao);
  if (!t) return null;
  const u = await db.usuarios.porId(t.id);
  return u && u.ativo && u.sessao_versao === t.versao ? u : null;
}
// papel "admin" exige administrador; `livre` deixa passar quem ainda precisa trocar a senha
const exige = (papel, livre = false) => assincrono(async (req, res, next) => {
  const u = await usuarioDe(req);
  if (!u) return res.status(401).json({ erro: "Faça login." });
  if (u.trocar_senha && !livre) return res.status(403).json({ erro: "Troque a sua senha para continuar.", trocarSenha: true });
  if (papel === "admin" && u.papel !== "admin") return res.status(403).json({ erro: "Só administradores." });
  req.u = u;
  next();
});

/* ---------- páginas ---------- */
const paginaLogada = (nome, soAdmin = false) => assincrono(async (req, res) => {
  const u = await usuarioDe(req);
  if (!u) return res.redirect("/login");
  if (u.trocar_senha && nome !== "trocar-senha") return res.redirect("/trocar-senha");
  if (soAdmin && u.papel !== "admin") return res.redirect("/");
  pagina(res, nome);
});
app.get("/", paginaLogada("index"));
app.get("/trocar-senha", paginaLogada("trocar-senha"));
app.get("/usuarios", paginaLogada("usuarios", true));
app.get("/auditoria", paginaLogada("auditoria", true));
app.get("/lembretes", paginaLogada("lembretes", true));
app.get("/login", (req, res) => pagina(res, "login"));
app.get("/cadastro", (req, res) => pagina(res, "cadastro"));
app.use("/assets", express.static(path.join(raiz, "public", "assets"), { maxAge: PRODUCAO ? "1h" : 0 }));
app.get("/saude", (req, res) => res.json({ ok: true }));
app.get("/favicon.ico", (req, res) => res.status(204).end());

/* ---------- login e senha ---------- */
const tentativas = limitador(10, 15 * 60e3);
app.post("/api/login", assincrono(async (req, res) => {
  const email = String(req.body?.email || "").trim(), senha = String(req.body?.senha || "");
  if (!tentativas(req.ip + "|" + email.toLowerCase())) return res.status(429).json({ erro: "Muitas tentativas. Espere 15 minutos." });
  const u = email && (await db.usuarios.porEmail(email));
  if (!u || !u.ativo || !confereSenha(senha, u.senha)) {
    audita(req, { acao: "login_falhou", depois: { email: email.slice(0, 120) } });
    return res.status(401).json({ erro: "E-mail ou senha incorretos." });
  }
  cookieSessao(res, u);
  req.u = u; audita(req, { acao: "login" });
  res.json({ ok: true, trocarSenha: u.trocar_senha });
}));
app.post("/api/logout", (req, res) => { res.clearCookie("cc_sessao", { path: "/" }); res.json({ ok: true }); });
app.get("/api/eu", exige(null, true), (req, res) => res.json({ id: req.u.id, nome: req.u.nome, email: req.u.email, papel: req.u.papel, trocarSenha: req.u.trocar_senha }));
app.post("/api/minha-senha", exige(null, true), assincrono(async (req, res) => {
  const atual = String(req.body?.atual || ""), nova = String(req.body?.nova || "");
  if (!confereSenha(atual, req.u.senha)) return res.status(400).json({ erro: "A senha atual está errada." });
  if (nova.length < 8) return res.status(400).json({ erro: "A nova senha precisa ter pelo menos 8 caracteres." });
  if (nova === atual) return res.status(400).json({ erro: "A nova senha precisa ser diferente da atual." });
  await db.usuarios.alterar(req.u.id, { senha: hashSenha(nova), trocar_senha: false }, true);
  cookieSessao(res, await db.usuarios.porId(req.u.id)); // este aparelho continua logado; os outros caem
  audita(req, { acao: "trocou_senha" });
  res.json({ ok: true });
}));

/* ---------- dados da carteira ---------- */
app.get("/api/dados", exige(), assincrono(async (req, res) => res.json(await db.listar(Math.max(0, +req.query.desde || 0)))));

function docValido(req, res, comCorpo = true) {
  const { col, id } = req.params;
  if (!db.COLECOES.has(col) || !/^[A-Za-z0-9_.-]{1,120}$/.test(id)) { res.status(400).json({ erro: "Documento inválido." }); return false; }
  if (comCorpo && (!req.body || typeof req.body !== "object" || Array.isArray(req.body))) { res.status(400).json({ erro: "Dados inválidos." }); return false; }
  return true;
}
// O que só o administrador pode fazer. Devolve o motivo da recusa, ou null.
function proibido(u, op, col, antes, novo) {
  if (u.papel === "admin") return null;
  if (col === "config") return "Só o administrador altera as configurações.";
  if (op === "excluir") return col === "clientes" && antes?.status === "pre" ? null : "Só o administrador exclui registros.";
  if (col === "contratos" && antes) {
    if (novo.cancelado && !antes.cancelado) return "Só o administrador cancela contratos.";
    const ids = new Set((novo.movimentos || []).map(m => m.id));
    if ((antes.movimentos || []).some(m => !ids.has(m.id))) return "Só o administrador estorna pagamentos.";
    for (const p of antes.parcelas || []) {
      const q = (novo.parcelas || []).find(x => x.n === p.n);
      if ((p.pagamentos || []).length > (q?.pagamentos || []).length) return "Só o administrador estorna pagamentos.";
    }
  }
  return null;
}
// Guarda só os campos que mudaram.
function diferenca(antes, depois) {
  const a = {}, d = {};
  for (const k of new Set([...Object.keys(antes || {}), ...Object.keys(depois || {})])) {
    if (JSON.stringify(antes?.[k]) !== JSON.stringify(depois?.[k])) { a[k] = antes?.[k] ?? null; d[k] = depois?.[k] ?? null; }
  }
  return Object.keys(d).length ? { antes: a, depois: d } : null;
}
const escrita = op => assincrono(async (req, res) => {
  if (!docValido(req, res, op !== "excluir")) return;
  const { col, id } = req.params, antes = await db.ler(col, id);
  if (op === "mesclar" && !antes) return res.status(404).json({ erro: "Documento não encontrado." });
  const novo = op === "excluir" ? null : op === "mesclar" ? { ...antes, ...req.body } : req.body;
  const motivo = proibido(req.u, op, col, antes, novo);
  if (motivo) return res.status(403).json({ erro: motivo });
  if (op === "excluir") await db.excluir(col, id);
  else if (op === "mesclar") await db.mesclar(col, id, req.body);
  else await db.gravar(col, id, req.body);
  if (op === "excluir") { if (antes) audita(req, { acao: "excluir", colecao: col, id, antes }); }
  else if (!antes) audita(req, { acao: "criar", colecao: col, id, depois: novo });
  else { const d = diferenca(antes, novo); if (d) audita(req, { acao: "alterar", colecao: col, id, ...d }); }
  res.json({ ok: true });
});
app.put("/api/doc/:col/:id", exige(), escrita("gravar"));
app.patch("/api/doc/:col/:id", exige(), escrita("mesclar"));
app.delete("/api/doc/:col/:id", exige(), escrita("excluir"));

/* ---------- administração ---------- */
const PAPEIS = ["admin", "operador"];
const resumoUsuario = u => ({ nome: u.nome, email: u.email, papel: u.papel, ativo: u.ativo });
app.get("/api/usuarios", exige("admin"), assincrono(async (req, res) => res.json(await db.usuarios.listar())));
app.post("/api/usuarios", exige("admin"), assincrono(async (req, res) => {
  const nome = String(req.body?.nome || "").trim(), email = String(req.body?.email || "").trim().toLowerCase();
  const senha = String(req.body?.senha || ""), papel = PAPEIS.includes(req.body?.papel) ? req.body.papel : "operador";
  if (!nome || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ erro: "Informe nome e e-mail válidos." });
  if (senha.length < 8) return res.status(400).json({ erro: "A senha precisa ter pelo menos 8 caracteres." });
  try {
    const id = await db.usuarios.criar({ email, nome, senha: hashSenha(senha), papel });
    audita(req, { acao: "usuario_criado", colecao: "usuarios", id: String(id), depois: { nome, email, papel } });
    res.json({ id });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ erro: "Já existe um usuário com esse e-mail." });
    throw e;
  }
}));
app.patch("/api/usuarios/:id", exige("admin"), assincrono(async (req, res) => {
  const id = +req.params.id, b = req.body || {}, campos = {}, alvo = await db.usuarios.porId(id);
  if (!alvo) return res.status(404).json({ erro: "Usuário não encontrado." });
  if (id === req.u.id && (b.ativo === false || (b.papel && b.papel !== "admin"))) return res.status(400).json({ erro: "Você não pode desativar nem rebaixar o seu próprio usuário." });
  if (typeof b.ativo === "boolean") campos.ativo = b.ativo;
  if (PAPEIS.includes(b.papel)) campos.papel = b.papel;
  if (typeof b.nome === "string" && b.nome.trim()) campos.nome = b.nome.trim();
  if (b.senha !== undefined) {
    if (String(b.senha).length < 8) return res.status(400).json({ erro: "A senha precisa ter pelo menos 8 caracteres." });
    campos.senha = hashSenha(String(b.senha));
    campos.trocar_senha = true; // senha definida pelo administrador: a pessoa troca no próximo acesso
  }
  await db.usuarios.alterar(id, campos, campos.senha !== undefined || campos.ativo === false);
  const { senha, ...semSenha } = campos;
  audita(req, { acao: "usuario_alterado", colecao: "usuarios", id: String(id), antes: resumoUsuario(alvo), depois: { ...semSenha, ...(senha ? { senhaRedefinida: true } : {}) } });
  res.json({ ok: true });
}));
app.get("/api/auditoria", exige("admin"), assincrono(async (req, res) => {
  const q = req.query;
  res.json(await db.listarAuditoria({ antesDe: +q.antes || null, usuarioId: +q.usuario || null, colecao: q.colecao ? String(q.colecao) : null, busca: q.busca ? String(q.busca).slice(0, 80) : null }));
}));
app.get("/api/backup", exige("admin"), assincrono(async (req, res) => {
  const docs = await db.todosDocs(), porColecao = {};
  for (const d of docs) (porColecao[d.colecao] ||= {})[d.id] = d.dados;
  audita(req, { acao: "backup", depois: { documentos: docs.length } });
  res.set("Content-Disposition", `attachment; filename="credicontrole-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ geradoEm: new Date().toISOString(), documentos: docs.length, colecoes: porColecao });
}));

/* ---------- lembretes de vencimento pelo WhatsApp ---------- */
app.get("/api/lembretes", exige("admin"), assincrono(async (req, res) => {
  const hoje = hojeBR(), { conf, itens } = await lembretes.pendentes(hoje), sit = await db.lembretes.situacao(itens.map(i => i.chave));
  res.json({
    hoje, conf, whatsapp: lembretes.whatsapp(), agendamento: !!process.env.CRON_TOKEN,
    previa: itens.map(i => ({ ...i, status: sit[i.chave]?.status || (i.motivo ? "vai pular" : "vai enviar"), erro: sit[i.chave]?.erro || i.motivo })),
    historico: await db.lembretes.recentes(),
  });
}));
app.post("/api/lembretes/enviar", exige("admin"), assincrono(async (req, res) => {
  const r = await lembretes.executar({ forcar: true });
  audita(req, { acao: "lembretes_manual", depois: r });
  res.json(r);
}));
// Chamada pela tarefa agendada (GitHub Actions ou outro cron), com o CRON_TOKEN no cabeçalho Authorization.
app.post("/api/tarefas/lembretes", assincrono(async (req, res) => {
  const esperado = process.env.CRON_TOKEN, veio = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!esperado) return res.status(503).json({ erro: "CRON_TOKEN não configurado no servidor." });
  const a = crypto.createHash("sha256").update(veio).digest(), b = crypto.createHash("sha256").update(esperado).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ erro: "Token inválido." });
  const r = await lembretes.executar();
  db.auditar({ acao: "lembretes_automaticos", depois: r, ip: req.ip }).catch(() => {});
  res.json(r);
}));

/* ---------- pré-cadastro público ---------- */
app.get("/api/publico/info", assincrono(async (req, res) => {
  const c = (await db.ler("config", "geral")) || {};
  res.json({ nome: c.empresaPublica || c.nome || "", aviso: c.avisoPrivacidade || AVISO_PADRAO });
}));
const envios = limitador(5, 3600e3);
const maiusculas = s => String(s ?? "").toLocaleUpperCase("pt-BR");
// "27981732823" → "(27) 98173-2823"; o que não for celular/fixo com DDD fica como veio
const telefoneBR = v => {
  const d = String(v || "").replace(/\D/g, "").replace(/^55(?=\d{10,11}$)/, "");
  return d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : String(v || "").trim();
};
app.post("/api/publico/precadastro", assincrono(async (req, res) => {
  const b = req.body || {};
  if (b.site) return res.json({ ok: true }); // campo escondido: só robô preenche
  const t = (v, n = 120) => String(v ?? "").trim().replace(/\s+/g, " ").slice(0, n);
  const M = (v, n) => maiusculas(t(v, n)); // nomes e endereços ficam em maiúsculas, como vão para o contrato
  const num = v => { const x = parseFloat(String(v ?? "").replace(/\./g, "").replace(",", ".")); return x > 0 ? Math.round(x * 100) / 100 : null; };
  const d = { nome: M(b.nome), cpf: t(b.cpf, 20).replace(/\D/g, ""), rg: M(b.rg, 30), telefone: t(b.telefone, 30),
    cep: t(b.cep, 9).replace(/\D/g, ""), logradouro: M(b.logradouro), numero: M(b.numero, 20), bairro: M(b.bairro, 80), cidade: M(b.cidade, 80), uf: M(b.uf, 2),
    empresa: M(b.empresa), enderecoTrabalho: M(b.enderecoTrabalho, 200), ref1Nome: M(b.ref1Nome, 80), ref1Parentesco: M(b.ref1Parentesco, 40), ref1Telefone: t(b.ref1Telefone, 30) };
  const digitos = v => v.replace(/\D/g, "").length;
  const faltam = [
    [d.nome.length >= 5 && d.nome.includes(" "), "nome completo"], [cpfValido(d.cpf), "CPF válido"], [d.rg.replace(/[^0-9A-Z]/g, "").length >= 5, "RG"],
    [digitos(d.telefone) >= 10, "telefone com DDD"], [d.cep.length === 8, "CEP"], [d.logradouro, "rua"], [d.numero, "número"], [d.bairro, "bairro"],
    [d.cidade, "cidade"], [/^[A-Z]{2}$/.test(d.uf), "UF"], [d.empresa, "nome da empresa"], [d.enderecoTrabalho.length >= 8, "endereço do local de trabalho"],
    [d.ref1Nome, "nome do contato de referência"], [d.ref1Parentesco, "parentesco do contato"], [digitos(d.ref1Telefone) >= 10, "telefone do contato"],
  ].filter(([ok]) => !ok).map(([, rotulo]) => rotulo);
  if (faltam.length) return res.status(400).json({ erro: `Preencha: ${faltam.join(", ")}.`, faltam });
  if (b.aceite !== true) return res.status(400).json({ erro: "É preciso concordar com o uso dos dados." });
  if (!envios(req.ip)) return res.status(429).json({ erro: "Muitos envios deste aparelho. Tente de novo mais tarde." });

  const cep = d.cep.replace(/(\d{5})(\d{3})/, "$1-$2"), nome = d.nome, cpf = d.cpf;
  const endereco = [`${d.logradouro}, ${d.numero}`, d.bairro, `${d.cidade}/${d.uf}`, cep].join(" · ");
  const referencias = [[d.ref1Nome, d.ref1Parentesco, d.ref1Telefone], [M(b.ref2Nome, 80), M(b.ref2Parentesco, 40), t(b.ref2Telefone, 30)]]
    .filter(([n, , f]) => n || f).map(([n, p, f]) => `${n}${p ? ` (${p})` : ""}${f ? ` — ${telefoneBR(f)}` : ""}`).join("\n");
  const ja = await db.clientePorCpf(cpf), agora = new Date().toISOString(), id = "cl" + Date.now().toString(36) + crypto.randomBytes(3).toString("hex");
  await db.gravar("clientes", id, {
    nome, cpf: cpf.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4"), rg: d.rg, telefone: telefoneBR(d.telefone),
    endereco, cep, logradouro: d.logradouro, numero: d.numero, bairro: d.bairro, cidade: d.cidade, uf: d.uf,
    empresa: d.empresa, enderecoTrabalho: d.enderecoTrabalho, tempoRegistro: t(b.tempoRegistro, 40), renda: num(b.renda),
    referencias, franquia: t(b.franquia, 30), origem: "link", semLembrete: b.aceitaWhatsapp !== true,
    obs: ja ? `Atenção: este CPF já está cadastrado (${ja.nome}).` : "",
    status: "pre", criadoEm: agora, aceitePrivacidadeEm: agora,
  });
  audita(req, { acao: "precadastro_publico", colecao: "clientes", id, depois: { nome, franquia: t(b.franquia, 30) } });
  res.json({ ok: true });
}));

app.use((req, res) => res.status(404).json({ erro: "Não encontrado." }));
app.use((e, req, res, next) => {
  console.error(e);
  if (res.headersSent) return next(e);
  res.status(e.type === "entity.parse.failed" ? 400 : 500).json({ erro: e.type === "entity.parse.failed" ? "Dados inválidos." : "Erro no servidor." });
});

await db.migrar();
// Cadastros antigos com nome ou endereço em minúsculas (ex.: "HUGO demuner") passam para maiúsculas, igual aos novos.
for (const { id, dados } of (await db.todosDocs()).filter(d => d.colecao === "clientes")) {
  const novo = { ...dados };
  for (const k of ["nome", "rg", "empresa", "enderecoTrabalho", "endereco", "logradouro", "numero", "bairro", "cidade", "uf"]) if (typeof novo[k] === "string") novo[k] = maiusculas(novo[k]);
  if (JSON.stringify(novo) === JSON.stringify(dados)) continue;
  await db.gravar("clientes", id, novo);
  await db.auditar({ acao: "padronizar_maiusculas", colecao: "clientes", id, antes: { nome: dados.nome }, depois: { nome: novo.nome } });
  console.log("Cadastro padronizado em maiúsculas:", id);
}
if ((await db.usuarios.contar()) === 0) {
  const email = process.env.ADMIN_EMAIL, senha = process.env.ADMIN_SENHA;
  if (email && senha && senha.length >= 8) {
    // a senha inicial fica nas variáveis do servidor, então o administrador troca no primeiro acesso
    await db.usuarios.criar({ email: email.toLowerCase(), nome: "Administrador", senha: hashSenha(senha), papel: "admin" });
    console.log("Administrador criado:", email);
  } else console.warn("Nenhum usuário cadastrado. Defina ADMIN_EMAIL e ADMIN_SENHA (8+ caracteres) para criar o primeiro administrador.");
}
app.listen(PORTA, () => console.log(`CrediControle em http://localhost:${PORTA}`));

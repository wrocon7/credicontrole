// Liga a tela do CrediControle (feita para o banco do claude.ai) à API deste servidor.
// Implementa o mesmo pedaço da interface que a tela usa: collection().limit().onSnapshot e
// doc().set/update/delete/onSnapshot. Busca mudanças a cada 4 s e confere tudo a cada 10 min.
(function () {
  "use strict";
  const docs = {}, vers = {}, ouvintes = []; // vers = versão de cada documento, devolvida ao servidor em cada gravação
  let versao = 0, eu = null, puxando = false, denovo = null; // denovo: busca pedida enquanto outra estava em curso (true = completa)
  const copia = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  // Avisa só quem acompanha as coleções que mudaram: cada aviso faz a tela copiar a coleção inteira e se redesenhar.
  const avisa = cols => ouvintes.forEach(o => { if (cols.has(o.col)) o.f(); });
  const ouve = (col, f) => { ouvintes.push({ col, f }); pronto.then(f); };
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(m) {
    document.querySelectorAll(".toast").forEach(x => x.remove());
    const el = document.createElement("div");
    el.className = "toast"; el.textContent = m; document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  async function api(metodo, url, corpo, cabecalhos = {}) {
    const r = await fetch(url, {
      method: metodo, credentials: "same-origin",
      headers: { ...(corpo ? { "Content-Type": "application/json" } : {}), ...cabecalhos },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (r.status === 401) { location.href = "/login"; throw new Error("Sessão encerrada"); }
    const j = await r.json().catch(() => ({}));
    if (r.status === 403 && j.trocarSenha) { location.href = "/trocar-senha"; throw new Error(j.erro); }
    if (!r.ok) throw new Error(j.erro || "Erro " + r.status);
    return j;
  }

  async function puxa(tudo) {
    if (puxando) { denovo = denovo || tudo; return; }
    puxando = true;
    try {
      const j = await api("GET", "/api/dados" + (tudo ? "" : "?desde=" + versao)), mudou = new Set();
      if (tudo) {
        // recarga completa: troca só o que está diferente do que a tela já tem (quase sempre, nada)
        const novos = {};
        for (const d of j.docs) novos[d.colecao + "/" + d.id] = d;
        for (const k in docs) if (!novos[k]) { mudou.add(k.split("/")[0]); delete docs[k]; delete vers[k]; }
        for (const k in novos) if (docs[k] === undefined || vers[k] !== novos[k].versao) { mudou.add(novos[k].colecao); docs[k] = novos[k].dados; vers[k] = novos[k].versao; }
      } else {
        for (const d of j.docs) {
          const k = d.colecao + "/" + d.id;
          if (d.excluido ? docs[k] === undefined : vers[k] === d.versao) continue; // já visto: o servidor repete as mudanças dos últimos segundos
          mudou.add(d.colecao);
          if (d.excluido) { delete docs[k]; delete vers[k]; } else { docs[k] = d.dados; vers[k] = d.versao; }
        }
      }
      versao = tudo ? j.versao : Math.max(versao, j.versao);
      if (mudou.size) avisa(mudou);
    } catch (e) { console.warn("CrediControle:", e.message); }
    finally { puxando = false; if (denovo !== null) { const completa = denovo; denovo = null; puxa(completa); } }
  }

  const anota = (p, v) => { if (v) vers[p] = Math.max(vers[p] || 0, v); else delete vers[p]; };

  // Aplica na tela na hora e confirma no servidor; se o servidor recusar, recarrega tudo. A versão em que a tela se
  // baseou vai junto (If-Match): se outra pessoa gravou antes, o servidor recusa em vez de gravar por cima.
  async function escreve(metodo, col, id, corpo, local) {
    const p = col + "/" + id, base = metodo !== "DELETE" && vers[p] ? { "If-Match": String(vers[p]) } : {};
    local(); avisa(new Set([col]));
    try { anota(p, (await api(metodo, `/api/doc/${col}/${encodeURIComponent(id)}`, corpo, base)).versao); }
    catch (e) { delete vers[p]; toast("Não foi possível salvar: " + e.message); await puxa(true); throw e; } // sem versão, a recarga repõe o registro
    puxa(false);
  }

  // Várias gravações que só fazem sentido juntas: no servidor entram todas ou nenhuma.
  // ops = [{ op: "gravar" | "mesclar" | "excluir", col, id, dados }]
  async function lote(ops) {
    const corpo = ops.map(o => ({ op: o.op, col: o.col, id: o.id, dados: o.dados, base: o.op !== "excluir" ? vers[o.col + "/" + o.id] : undefined }));
    for (const o of ops) {
      const p = o.col + "/" + o.id;
      if (o.op === "excluir") delete docs[p];
      else docs[p] = o.op === "mesclar" ? { ...(docs[p] || {}), ...copia(o.dados) } : copia(o.dados);
    }
    avisa(new Set(ops.map(o => o.col)));
    try { const j = await api("POST", "/api/lote", { ops: corpo }); ops.forEach((o, i) => anota(o.col + "/" + o.id, j.versoes[i])); }
    catch (e) { ops.forEach(o => delete vers[o.col + "/" + o.id]); toast("Não foi possível salvar: " + e.message); await puxa(true); throw e; }
    puxa(false);
  }

  const snapCol = col => ({ docs: Object.keys(docs).filter(k => k.startsWith(col + "/")).map(k => ({ id: k.slice(col.length + 1), data: () => copia(docs[k]) })) });
  let pronto;
  const db = {
    lote,
    collection: col => ({ limit: () => ({ onSnapshot: cb => ouve(col, () => cb(snapCol(col))) }) }),
    doc: p => {
      const [col, id] = p.split("/");
      return {
        onSnapshot: cb => ouve(col, () => cb({ exists: docs[p] !== undefined, data: () => copia(docs[p]) })),
        set: v => escreve("PUT", col, id, v, () => { docs[p] = copia(v); }),
        update: v => escreve("PATCH", col, id, v, () => { docs[p] = { ...(docs[p] || {}), ...copia(v) }; }),
        delete: () => escreve("DELETE", col, id, null, () => { delete docs[p]; }),
      };
    },
  };

  window.claude = { use: async nome => { if (nome === "db") { await pronto; return db; } if (nome === "user") return { can: async () => true }; return null; } };
  pronto = (async () => {
    eu = await api("GET", "/api/eu");
    if (eu.trocarSenha) { location.href = "/trocar-senha"; return; }
    window.__ccUsuario = eu.nome; window.__ccEu = eu; // a tela usa o papel e a rota de quem está logado // a tela grava quem avisou cada cliente nos lembretes
    // Operador não vê o que só o administrador pode fazer (o servidor recusa de qualquer jeito).
    if (eu.papel !== "admin") {
      const s = document.createElement("style");
      s.textContent = ['[data-act="delContrato"]', '[data-act="estornar"]', '[data-act="estornarSaldo"]', '[data-act="cancelarC"]', '[data-act="delCliente"]',
        '[data-act="delLanc"]', '[data-act="limparEx"]', '#nav a[data-v="ajustes"]', '#nav a[data-v="caixa"]'].join(",") + "{display:none!important}";
      document.head.appendChild(s);
    }
    await puxa(true);
  })();
  setInterval(() => puxa(false), 4000);
  setInterval(() => puxa(true), 600000); // rede de segurança: confere tudo a cada 10 minutos
  document.addEventListener("visibilitychange", () => { if (!document.hidden) puxa(false); });

  // Rodapé do menu: usuário, link público de pré-cadastro, administração (só admin), senha e sair.
  document.addEventListener("DOMContentLoaded", () => pronto.then(() => {
    const side = document.getElementById("side");
    if (!side || !eu || eu.trocarSenha) return;
    const a = "color:var(--side-fg);text-decoration:none";
    const box = document.createElement("div");
    box.style.cssText = "margin-top:18px;padding:14px 10px 4px;border-top:1px solid rgba(255,255,255,.1);display:grid;gap:8px;font-size:13px";
    box.innerHTML = `<div style="color:var(--side-muted)">Conectado como<br><b style="color:#fff">${esc(eu.nome)}</b> · ${eu.papel === "admin" ? "administrador" : "operador" + (eu.rota ? " · " + esc(eu.rota) : " (sem rota)")}</div>
      <a href="#" id="ccLink" style="${a}">Copiar mensagem do pré-cadastro</a>
      ${eu.papel === "admin" ? `<a href="/usuarios" style="${a}">Usuários</a><a href="/lembretes" style="${a}">Lembretes no WhatsApp</a><a href="/auditoria" style="${a}">Auditoria</a><a href="/api/backup" download style="${a}">Baixar cópia de segurança</a>` : ""}
      <a href="/trocar-senha" style="${a}">Minha senha</a>
      <a href="#" id="ccSair" style="${a}">Sair</a>`;
    side.appendChild(box);
    // Copia a mensagem pronta para mandar ao cliente, já com o link do formulário.
    document.getElementById("ccLink").onclick = e => {
      e.preventDefault();
      const url = location.origin + "/cadastro" + (eu.rota ? "?f=" + encodeURIComponent(eu.rota) : ""); // o pré-cadastro já cai na rota do operador
      const msg = `Enquanto seus dados são analisados, favor preencher o formulário a seguir:\n${url}\n\n⚠️ ATENÇÃO ⚠️\nEm "Contatos de referência", coloque um número para recado: o telefone de um familiar, com o nome e o grau de parentesco.`;
      navigator.clipboard?.writeText(msg).then(() => toast("Mensagem com o link copiada. É só colar na conversa do cliente."), () => toast(url));
    };
    document.getElementById("ccSair").onclick = async e => { e.preventDefault(); await fetch("/api/logout", { method: "POST" }); location.href = "/login"; };
  }));
})();

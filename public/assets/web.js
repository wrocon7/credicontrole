// Liga a tela do CrediControle (feita para o banco do claude.ai) à API deste servidor.
// Implementa o mesmo pedaço da interface que a tela usa: collection().limit().onSnapshot e
// doc().set/update/delete/onSnapshot. Busca mudanças a cada 4 s e recarrega tudo a cada 2 min.
(function () {
  "use strict";
  const docs = {}, ouvintes = [];
  let versao = 0, eu = null, puxando = false, denovo = false;
  const copia = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const avisa = () => ouvintes.forEach(f => f());
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function toast(m) {
    document.querySelectorAll(".toast").forEach(x => x.remove());
    const el = document.createElement("div");
    el.className = "toast"; el.textContent = m; document.body.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  async function api(metodo, url, corpo) {
    const r = await fetch(url, {
      method: metodo, credentials: "same-origin",
      headers: corpo ? { "Content-Type": "application/json" } : {},
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (r.status === 401) { location.href = "/login"; throw new Error("Sessão encerrada"); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || "Erro " + r.status);
    return j;
  }

  async function puxa(tudo) {
    if (puxando) { denovo = true; return; }
    puxando = true;
    try {
      const j = await api("GET", "/api/dados" + (tudo ? "" : "?desde=" + versao));
      if (tudo) for (const k in docs) delete docs[k];
      for (const d of j.docs) { const k = d.colecao + "/" + d.id; if (d.excluido) delete docs[k]; else docs[k] = d.dados; }
      versao = tudo ? j.versao : Math.max(versao, j.versao);
      if (tudo || j.docs.length) avisa();
    } catch (e) { console.warn("CrediControle:", e.message); }
    finally { puxando = false; if (denovo) { denovo = false; puxa(false); } }
  }

  // Aplica na tela na hora e confirma no servidor; se o servidor recusar, recarrega tudo.
  async function escreve(metodo, col, id, corpo, local) {
    local(); avisa();
    try { await api(metodo, `/api/doc/${col}/${encodeURIComponent(id)}`, corpo); }
    catch (e) { toast("Não foi possível salvar: " + e.message); await puxa(true); throw e; }
    puxa(false);
  }

  const snapCol = col => ({ docs: Object.keys(docs).filter(k => k.startsWith(col + "/")).map(k => ({ id: k.slice(col.length + 1), data: () => copia(docs[k]) })) });
  let pronto;
  const db = {
    collection: col => ({ limit: () => ({ onSnapshot: cb => { const f = () => cb(snapCol(col)); ouvintes.push(f); pronto.then(f); } }) }),
    doc: p => {
      const [col, id] = p.split("/");
      return {
        onSnapshot: cb => { const f = () => cb({ exists: docs[p] !== undefined, data: () => copia(docs[p]) }); ouvintes.push(f); pronto.then(f); },
        set: v => escreve("PUT", col, id, v, () => { docs[p] = copia(v); }),
        update: v => escreve("PATCH", col, id, v, () => { docs[p] = { ...(docs[p] || {}), ...copia(v) }; }),
        delete: () => escreve("DELETE", col, id, null, () => { delete docs[p]; }),
      };
    },
  };

  window.claude = { use: async nome => { if (nome === "db") { await pronto; return db; } if (nome === "user") return { can: async () => true }; return null; } };
  pronto = (async () => { eu = await api("GET", "/api/eu"); await puxa(true); })();
  setInterval(() => puxa(false), 4000);
  setInterval(() => puxa(true), 120000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) puxa(false); });

  // Rodapé do menu: usuário, link público de pré-cadastro, usuários (admin) e sair.
  document.addEventListener("DOMContentLoaded", () => pronto.then(() => {
    const side = document.getElementById("side");
    if (!side) return;
    const a = "color:var(--side-fg);text-decoration:none";
    const box = document.createElement("div");
    box.style.cssText = "margin-top:18px;padding:14px 10px 4px;border-top:1px solid rgba(255,255,255,.1);display:grid;gap:8px;font-size:13px";
    box.innerHTML = `<div style="color:var(--side-muted)">Conectado como<br><b style="color:#fff">${esc(eu.nome)}</b></div>
      <a href="#" id="ccLink" style="${a}">Copiar link de pré-cadastro</a>
      ${eu.papel === "admin" ? `<a href="/usuarios" style="${a}">Usuários</a>` : ""}
      <a href="#" id="ccSair" style="${a}">Sair</a>`;
    side.appendChild(box);
    document.getElementById("ccLink").onclick = e => {
      e.preventDefault();
      const url = location.origin + "/cadastro";
      navigator.clipboard?.writeText(url).then(() => toast("Link copiado: " + url), () => toast(url));
    };
    document.getElementById("ccSair").onclick = async e => { e.preventDefault(); await fetch("/api/logout", { method: "POST" }); location.href = "/login"; };
  }));
})();

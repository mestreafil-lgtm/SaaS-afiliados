(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const TOKEN_KEY = "metricly_access_token";
  const USER_KEY = "metricly_user";

  const state = {
    panel: "overview",
    users: [],
    pending: [],
    page: 1,
    pendingPage: 1,
    pageSize: 10,
    selectedId: null,
    colFilters: {},
    sort: { key: "createdAt", dir: "desc" },
  };

  function getToken() { return localStorage.getItem(TOKEN_KEY) || ""; }
  function setSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token || "");
    localStorage.setItem(USER_KEY, JSON.stringify(user || {}));
  }
  function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }
  function fmtDate(v) {
    if (!v) return "—";
    try { return new Date(v).toLocaleString("pt-BR"); } catch { return String(v); }
  }
  function statusLabel(status) {
    return ({
      pending: "Pendente",
      approved: "Aprovado",
      rejected: "Recusado",
      suspended: "Suspenso",
    })[status] || status;
  }
  function pill(status) {
    return `<span class="pill ${escapeHtml(status)}">${escapeHtml(statusLabel(status))}</span>`;
  }

  async function readJsonResponse(res) {
    const text = await res.text();
    const trimmed = (text || "").trim();
    if (!trimmed) {
      throw new Error(`Resposta vazia (HTTP ${res.status}). Use http://localhost:3790 com o servidor Node ligado.`);
    }
    if (trimmed[0] === "<" || trimmed.startsWith("<!")) {
      throw new Error(
        `Servidor devolveu HTML em vez de JSON (HTTP ${res.status}). Abra http://localhost:3790 (npm start).`,
      );
    }
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error(`Resposta inválida (HTTP ${res.status}): ${trimmed.slice(0, 120)}`);
    }
  }

  async function api(path, opts = {}) {
    const headers = { ...(opts.headers || {}) };
    if (!(opts.body instanceof FormData)) headers["Content-Type"] = "application/json";
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(path, { ...opts, headers });
    const data = await readJsonResponse(res);
    if (!res.ok) {
      const err = new Error(data.error || res.statusText || `HTTP ${res.status}`);
      err.code = data.code;
      err.data = data;
      throw err;
    }
    return data;
  }

  function renderPager(el, page, total, pageSize, onPage) {
    if (!el) return;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    const from = total ? (page - 1) * pageSize + 1 : 0;
    const to = Math.min(total, page * pageSize);
    const btns = [];
    btns.push(`<button type="button" data-p="${page - 1}" ${page <= 1 ? "disabled" : ""}>Ant.</button>`);
    for (let i = 1; i <= pages && i <= 7; i++) {
      btns.push(`<button type="button" class="${i === page ? "active" : ""}" data-p="${i}">${i}</button>`);
    }
    btns.push(`<button type="button" data-p="${page + 1}" ${page >= pages ? "disabled" : ""}>Prox.</button>`);
    el.innerHTML = `<div>${from}–${to} de <strong style="color:#111827">${total}</strong></div><div class="pager-btns">${btns.join("")}</div>`;
    el.querySelectorAll("button[data-p]").forEach((b) => {
      b.addEventListener("click", () => {
        const p = Number(b.dataset.p);
        if (p >= 1 && p <= pages) onPage(p);
      });
    });
  }

  function showAuth() {
    $("#admin-auth").classList.remove("hidden");
    $("#admin-app").classList.add("hidden");
  }
  function initials(email) {
    const s = String(email || "AD").replace(/[^a-z0-9]/gi, "");
    return (s.slice(0, 2) || "AD").toUpperCase();
  }

  function showApp(user) {
    $("#admin-auth").classList.add("hidden");
    $("#admin-app").classList.remove("hidden");
    const email = user?.email || "Admin";
    $("#admin-user-label").textContent = email;
    const avatar = $("#admin-avatar");
    if (avatar) avatar.textContent = initials(email);
  }

  function setSidebarOpen(open) {
    document.body.classList.toggle("sidebar-open", !!open);
    const backdrop = $("#sidebar-backdrop");
    if (backdrop) {
      backdrop.classList.toggle("hidden", !open);
      backdrop.hidden = !open;
    }
  }

  function setPanel(name) {
    state.panel = name;
    $$(".rail-item").forEach((b) => b.classList.toggle("active", b.dataset.panel === name));
    $$(".panel-block").forEach((p) => p.classList.add("hidden"));
    $(`#panel-${name}`)?.classList.remove("hidden");
    const titles = {
      overview: ["Admin", "Resumo", "Contas, fila de aprovação e últimos acessos."],
      pending: ["Admin", "Pendentes", "Cadastros aguardando liberação."],
      users: ["Admin", "Usuários", "Busca, filtro e status de cada conta."],
    };
    const t = titles[name] || ["Admin", name, ""];
    $("#panel-eyebrow").textContent = t[0];
    $("#panel-title").textContent = t[1];
    $("#panel-desc").textContent = t[2];
    const filters = $("#users-filters");
    if (filters) filters.classList.toggle("hidden", name === "overview");
  }

  function compareSort(a, b, dir) {
    const mul = dir === "desc" ? -1 : 1;
    if (a == null && b == null) return 0;
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === "number" && typeof b === "number") return a === b ? 0 : (a > b ? mul : -mul);
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (!Number.isNaN(ta) && !Number.isNaN(tb) && String(a).match(/\d{4}-\d{2}/)) {
      return ta === tb ? 0 : (ta > tb ? mul : -mul);
    }
    return String(a).localeCompare(String(b), "pt-BR", { sensitivity: "base", numeric: true }) * mul;
  }

  function filteredUsers() {
    const q = ($("#users-q")?.value || "").trim().toLowerCase();
    const status = $("#users-status")?.value || "all";
    let rows = state.users.filter((u) => {
      if (status !== "all" && u.status !== status) return false;
      if (!q) return true;
      const blob = [u.email, u.displayName, u.company, u.role, u.status].join(" ").toLowerCase();
      return blob.includes(q);
    });
    const key = state.sort.key;
    if (key) {
      rows = [...rows].sort((a, b) => compareSort(a[key], b[key], state.sort.dir));
    }
    return rows;
  }

  function paintUserSortHeaders() {
    $$("#panel-users th[data-sort]").forEach((th) => {
      const active = state.sort.key === th.dataset.sort;
      th.classList.add("th-sort");
      th.classList.toggle("asc", active && state.sort.dir === "asc");
      th.classList.toggle("desc", active && state.sort.dir === "desc");
    });
  }

  function renderStats(stats) {
    const items = [
      ["total", "Contas", stats.total],
      ["pending", "Pendentes", stats.pending],
      ["approved", "Aprovados", stats.approved],
      ["rejected", "Recusados", stats.rejected],
      ["suspended", "Suspensos", stats.suspended],
    ];
    $("#stat-grid").innerHTML = items.map(([k, label, val]) => `
      <div class="stat ${k}">
        <div class="lbl">${label}</div>
        <div class="val">${val ?? 0}</div>
      </div>`).join("");
    $("#badge-pending").textContent = String(stats.pending || 0);
    $("#queue-hint").textContent = `${stats.pending || 0} aguardando`;
  }

  function actionButtons(u) {
    if (u.status === "pending") {
      return `
        <button type="button" class="btn soft tiny" data-act="approved" data-id="${escapeHtml(u.userId)}">Aprovar</button>
        <button type="button" class="btn danger tiny" data-act="rejected" data-id="${escapeHtml(u.userId)}">Recusar</button>
        <button type="button" class="btn ghost tiny" data-del="${escapeHtml(u.userId)}">Excluir</button>`;
    }
    if (u.role === "admin") {
      return `<button type="button" class="btn ghost tiny" data-open="${escapeHtml(u.userId)}">Abrir</button>`;
    }
    return `
      <button type="button" class="btn ghost tiny" data-open="${escapeHtml(u.userId)}">Abrir</button>
      <button type="button" class="btn ghost tiny" data-del="${escapeHtml(u.userId)}">Excluir</button>`;
  }

  function renderOverview() {
    const recent = [...state.users]
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, 8);
    $("#recent-accounts").innerHTML = recent.map((u) => `
      <tr data-id="${escapeHtml(u.userId)}">
        <td>${escapeHtml(u.email)}</td>
        <td>${pill(u.status)}</td>
        <td>${escapeHtml(u.company || "—")}</td>
        <td>${escapeHtml(fmtDate(u.createdAt))}</td>
        <td class="num"><div class="row-actions">${actionButtons(u)}</div></td>
      </tr>`).join("") || `<tr><td colspan="5">Nenhuma conta cadastrada ainda.</td></tr>`;

    const pending = state.users.filter((u) => u.status === "pending").slice(0, 5);
    $("#queue-box").innerHTML = pending.length
      ? pending.map((u) => `
        <div class="queue-row">
          <div>
            <div class="email">${escapeHtml(u.email)}</div>
            <div class="meta">${escapeHtml(u.company || u.displayName || "Sem empresa")} · ${escapeHtml(fmtDate(u.createdAt))}</div>
          </div>
          <div class="row-actions">
            <button type="button" class="btn soft tiny" data-act="approved" data-id="${escapeHtml(u.userId)}">Aprovar</button>
            <button type="button" class="btn danger tiny" data-act="rejected" data-id="${escapeHtml(u.userId)}">Recusar</button>
          </div>
        </div>`).join("")
      : `<div class="queue-empty">Nenhuma solicitação pendente.<br>Novos cadastros aparecem aqui.</div>`;

    const logins = [...state.users]
      .filter((u) => u.lastLoginAt)
      .sort((a, b) => String(b.lastLoginAt || "").localeCompare(String(a.lastLoginAt || "")))
      .slice(0, 6);
    $("#logins-box").innerHTML = logins.length
      ? logins.map((u) => `
        <div class="queue-row">
          <div>
            <div class="email">${escapeHtml(u.email)}</div>
            <div class="meta">${escapeHtml(statusLabel(u.status))} · ${escapeHtml(fmtDate(u.lastLoginAt))}</div>
          </div>
          ${u.role === "admin" ? '<span class="pill admin">Admin</span>' : pill(u.status)}
        </div>`).join("")
      : `<div class="queue-empty">Ainda sem registros de login.</div>`;
  }

  function renderPending() {
    const all = state.users.filter((u) => u.status === "pending");
    state.pending = all;
    const pages = Math.max(1, Math.ceil(all.length / state.pageSize));
    if (state.pendingPage > pages) state.pendingPage = pages;
    const slice = all.slice((state.pendingPage - 1) * state.pageSize, state.pendingPage * state.pageSize);
    $("#pending-tbody").innerHTML = slice.map((u) => `
      <tr>
        <td>${escapeHtml(u.email)}</td>
        <td>${escapeHtml(u.displayName || "—")}</td>
        <td>${escapeHtml(u.company || "—")}</td>
        <td>${escapeHtml(fmtDate(u.createdAt))}</td>
        <td class="num">
          <div class="row-actions">
            <button type="button" class="btn soft tiny" data-act="approved" data-id="${escapeHtml(u.userId)}">Aprovar</button>
            <button type="button" class="btn danger tiny" data-act="rejected" data-id="${escapeHtml(u.userId)}">Recusar</button>
            <button type="button" class="btn ghost tiny" data-del="${escapeHtml(u.userId)}">Excluir</button>
          </div>
        </td>
      </tr>`).join("") || `<tr><td colspan="5">Fila vazia — nenhum cadastro aguardando.</td></tr>`;
    renderPager($("#pending-pager"), state.pendingPage, all.length, state.pageSize, (p) => {
      state.pendingPage = p;
      renderPending();
    });
  }

  function renderUsers() {
    paintUserSortHeaders();
    const all = filteredUsers();
    $("#users-count").textContent = `${all.length} contas`;
    const pages = Math.max(1, Math.ceil(all.length / state.pageSize));
    if (state.page > pages) state.page = pages;
    const slice = all.slice((state.page - 1) * state.pageSize, state.page * state.pageSize);
    $("#users-tbody").innerHTML = slice.map((u) => `
      <tr data-id="${escapeHtml(u.userId)}" class="${u.userId === state.selectedId ? "active" : ""}">
        <td>${escapeHtml(u.email)}</td>
        <td>${escapeHtml(u.displayName || "—")}</td>
        <td>${escapeHtml(u.company || "—")}</td>
        <td>${u.role === "admin" ? '<span class="pill admin">Admin</span>' : "Usuário"}</td>
        <td>${pill(u.status)}</td>
        <td>${escapeHtml(fmtDate(u.createdAt))}</td>
        <td>${escapeHtml(fmtDate(u.lastLoginAt))}</td>
      </tr>`).join("") || `<tr><td colspan="7">Nenhum usuário com esses filtros.</td></tr>`;
    renderPager($("#users-pager"), state.page, all.length, state.pageSize, (p) => {
      state.page = p;
      renderUsers();
    });
  }

  async function openDetail(userId) {
    state.selectedId = userId;
    renderUsers();
    $("#detail-body").innerHTML = `<div class="detail-empty">Carregando…</div>`;
    try {
      const d = await api(`/api/admin/users/${userId}`);
      const p = d.profile;
      $("#user-detail .card-head .hint").textContent = statusLabel(p.status);
      const canDelete = p.role !== "admin";
      $("#detail-body").outerHTML = `
        <div id="detail-body" class="detail-body">
          <div class="detail-title">${escapeHtml(p.email)}</div>
          <div>${pill(p.status)} ${p.role === "admin" ? '<span class="pill admin">Admin</span>' : ""}</div>
          <div class="meta-grid">
            <div class="meta-box"><div class="k">Nome</div><div class="v">${escapeHtml(p.displayName || "—")}</div></div>
            <div class="meta-box"><div class="k">Empresa</div><div class="v">${escapeHtml(p.company || "—")}</div></div>
            <div class="meta-box"><div class="k">Criado</div><div class="v">${escapeHtml(fmtDate(p.createdAt))}</div></div>
            <div class="meta-box"><div class="k">Último acesso</div><div class="v">${escapeHtml(fmtDate(p.lastLoginAt))}</div></div>
            <div class="meta-box"><div class="k">Shopee</div><div class="v">${d.shopee?.configured ? escapeHtml(d.shopee.appId) : "não configurada"}</div></div>
            <div class="meta-box"><div class="k">Meta Ads</div><div class="v">${d.meta?.configured ? `${d.meta.accounts.length} contas` : "não configurada"}</div></div>
            <div class="meta-box"><div class="k">Pedidos</div><div class="v">${Number(d.activity?.ordersCount || 0).toLocaleString("pt-BR")}</div></div>
            <div class="meta-box"><div class="k">Última sync</div><div class="v">${escapeHtml(fmtDate(d.activity?.lastSyncAt))}</div></div>
          </div>
          <div class="detail-actions">
            <button type="button" class="btn soft tiny" data-act="approved" data-id="${escapeHtml(p.userId)}">Aprovar</button>
            <button type="button" class="btn warn tiny" data-act="suspended" data-id="${escapeHtml(p.userId)}">Suspender</button>
            <button type="button" class="btn danger tiny" data-act="rejected" data-id="${escapeHtml(p.userId)}">Recusar</button>
            <button type="button" class="btn ghost tiny" data-act="pending" data-id="${escapeHtml(p.userId)}">Marcar pendente</button>
            ${canDelete ? `<button type="button" class="btn danger-strong tiny" data-del="${escapeHtml(p.userId)}">Excluir conta</button>` : ""}
          </div>
        </div>`;
    } catch (err) {
      $("#detail-body").innerHTML = `<div class="detail-empty">${escapeHtml(err.message)}</div>`;
    }
  }

  async function setStatus(userId, status) {
    await api(`/api/admin/users/${userId}/status`, {
      method: "POST",
      body: JSON.stringify({ status }),
    });
    await refresh();
    if (state.selectedId === userId) openDetail(userId);
  }

  async function deleteUser(userId) {
    const u = state.users.find((x) => x.userId === userId);
    const ok = window.confirm(
      `Excluir permanentemente ${u?.email || "esta conta"}?\n\nIsso remove login, credenciais e dados sincronizados. Não dá para desfazer.`,
    );
    if (!ok) return;
    await api(`/api/admin/users/${userId}/delete`, { method: "POST", body: "{}" });
    state.selectedId = null;
    $("#detail-body").outerHTML = `<div id="detail-body" class="detail-empty">Conta excluída.</div>`;
    $("#user-detail .card-head .hint").textContent = "Selecione na lista";
    await refresh();
  }

  async function refresh() {
    const [overview, usersRes] = await Promise.all([
      api("/api/admin/overview"),
      api("/api/admin/users?status=all"),
    ]);
    state.users = usersRes.users || [];
    renderStats(overview.stats || {});
    renderOverview();
    renderPending();
    renderUsers();
  }

  async function bootSession() {
    const token = getToken();
    if (!token) {
      showAuth();
      return;
    }
    try {
      const me = await api("/api/auth/me");
      if (me.user?.role !== "admin" && me.user?.profile?.role !== "admin") {
        clearSession();
        showAuth();
        $("#admin-login-status").className = "form-status is-err";
        $("#admin-login-status").textContent = "Esta conta não é administradora.";
        return;
      }
      showApp(me.user);
      await refresh();
    } catch (_) {
      clearSession();
      showAuth();
    }
  }

  function wire() {
    $("#admin-login").addEventListener("submit", async (e) => {
      e.preventDefault();
      const status = $("#admin-login-status");
      status.className = "form-status";
      status.textContent = "Entrando…";
      try {
        const r = await api("/api/auth/login", {
          method: "POST",
          body: JSON.stringify({
            email: $("#admin-email").value,
            password: $("#admin-password").value,
          }),
        });
        if (r.user?.role !== "admin" && r.user?.profile?.role !== "admin") {
          throw new Error("Somente administradores acessam esta área.");
        }
        setSession(r.access_token, r.user);
        showApp(r.user);
        status.textContent = "";
        await refresh();
      } catch (err) {
        status.classList.add("is-err");
        status.textContent = err.message;
      }
    });

    $("#admin-logout").addEventListener("click", () => {
      clearSession();
      showAuth();
    });
    $("#btn-refresh").addEventListener("click", () => refresh().catch((e) => alert(e.message)));
    $("#users-q").addEventListener("input", () => { state.page = 1; renderUsers(); });
    $("#users-status").addEventListener("change", () => { state.page = 1; renderUsers(); });
    $("#panel-users thead")?.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort]");
      if (!th) return;
      const key = th.dataset.sort;
      if (state.sort.key === key) state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      else {
        state.sort.key = key;
        state.sort.dir = "asc";
      }
      state.page = 1;
      renderUsers();
    });

    $$(".rail-item").forEach((b) => b.addEventListener("click", () => {
      setPanel(b.dataset.panel);
      setSidebarOpen(false);
    }));
    $("#btn-sidebar-open")?.addEventListener("click", () => setSidebarOpen(true));
    $("#btn-sidebar-close")?.addEventListener("click", () => setSidebarOpen(false));
    $("#sidebar-backdrop")?.addEventListener("click", () => setSidebarOpen(false));

    document.addEventListener("click", (e) => {
      const go = e.target.closest("[data-goto-panel]");
      if (go) {
        e.preventDefault();
        setPanel(go.dataset.gotoPanel);
        return;
      }
      const open = e.target.closest("[data-open]");
      if (open) {
        e.preventDefault();
        setPanel("users");
        openDetail(open.dataset.open);
        return;
      }
      const del = e.target.closest("[data-del]");
      if (del) {
        e.preventDefault();
        deleteUser(del.dataset.del).catch((err) => alert(err.message));
        return;
      }
      const act = e.target.closest("[data-act]");
      if (act) {
        e.preventDefault();
        setStatus(act.dataset.id, act.dataset.act).catch((err) => alert(err.message));
        return;
      }
      const row = e.target.closest("#users-tbody tr[data-id], #recent-accounts tr[data-id]");
      if (row && !e.target.closest("button")) {
        setPanel("users");
        openDetail(row.dataset.id);
      }
    });
  }

  wire();
  bootSession();
})();

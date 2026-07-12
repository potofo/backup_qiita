/**
 * Web UI(タスク5) — 接続確認 / ダッシュボード / 実行状況 の3画面
 * - SSE(/api/backup/events)を購読して進捗を更新する(5.3)
 */

type ConnectionStatus =
  | { state: "unchecked"; maskedToken: string | null }
  | { state: "connected"; userId: string; itemsCount: number; maskedToken: string | null }
  | { state: "invalid"; reason: "missing" | "unauthorized" | "forbidden"; maskedToken: string | null };

type ArticleListItem = {
  id: string;
  title: string;
  url: string;
  updatedAt: string;
  private: boolean;
  commentsCount: number;
  likesCount: number;
  stocksCount: number;
  status: "notBackedUp" | "upToDate" | "qiitaUpdated" | "localModified" | "deletedOnQiita";
  lastBackupAt: string | null;
  folderName: string | null;
};

type Aggregate = {
  total: number;
  notBackedUp: number;
  upToDate: number;
  qiitaUpdated: number;
  localModified: number;
  deletedOnQiita: number;
  needsBackup: number;
};

type RunSummary = {
  runId: string;
  mode: string;
  startedAt: string;
  finishedAt: string;
  total: number;
  succeeded: number;
  failed: number;
  imageFailures: { articleId: string; articleTitle: string; url: string; reason: string }[];
  cancelled: boolean;
  commit: { hash: string; message: string; committedAt: string } | null;
};

const STATUS_LABEL: Record<ArticleListItem["status"], string> = {
  notBackedUp: "未バックアップ",
  upToDate: "最新",
  qiitaUpdated: "Qiita更新あり",
  localModified: "ローカル変更あり",
  deletedOnQiita: "Qiitaから削除済",
};

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`要素が見つかりません: ${id}`);
  return el as T;
};

const fmtDate = (iso: string | null): string => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---- 状態 -----------------------------------------------------------------

let articles: ArticleListItem[] = [];
let connected = false;

// ---- 画面切り替え ------------------------------------------------------------

type ViewName = "connection" | "dashboard" | "progress";

const showView = (view: ViewName): void => {
  $("view-connection").hidden = view !== "connection";
  $("view-dashboard").hidden = view !== "dashboard";
  $("view-progress").hidden = view !== "progress";
};

// ---- 接続確認画面(5.1) ------------------------------------------------------

const renderBadge = (status: ConnectionStatus): void => {
  const badge = $("connection-badge");
  badge.classList.remove("badge-connected", "badge-invalid", "badge-unknown");
  if (status.state === "connected") {
    badge.textContent = `接続済(@${status.userId})`;
    badge.classList.add("badge-connected");
  } else if (status.state === "invalid") {
    badge.textContent = "トークン無効";
    badge.classList.add("badge-invalid");
  } else {
    badge.textContent = "未確認";
    badge.classList.add("badge-unknown");
  }
};

const renderConnection = (status: ConnectionStatus): void => {
  renderBadge(status);
  connected = status.state === "connected";
  $("masked-token").textContent = status.maskedToken ?? "(未設定)";

  const success = $("conn-success");
  const error = $("conn-error");
  success.hidden = status.state !== "connected";
  error.hidden = status.state !== "invalid";

  if (status.state === "connected") {
    $("conn-success-user").textContent = `✓ 接続済: @${status.userId}`;
    $("conn-success-count").textContent = `投稿記事数: ${status.itemsCount}件(スコープ: read_qiita)`;
  }
};

const showConnectionError = (message: string): void => {
  $("conn-error").hidden = false;
  $("conn-error-message").textContent = message;
};

const verify = async (token?: string, save?: boolean): Promise<void> => {
  const res = await fetch("/api/connection/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, save }),
  });
  if (res.ok) {
    const body = (await res.json()) as { userId: string; itemsCount: number; savedToEnv: boolean };
    renderConnection({
      state: "connected",
      userId: body.userId,
      itemsCount: body.itemsCount,
      maskedToken: token ? `****${token.slice(-4)}` : $("masked-token").textContent,
    });
    ($("token-input") as HTMLInputElement).value = "";
    // 接続できたらダッシュボードへ遷移して一覧を取得する
    showView("dashboard");
    await loadArticles(true);
  } else {
    const body = (await res.json()) as { error: { code: string; message: string } };
    renderConnection({ state: "invalid", reason: "unauthorized", maskedToken: $("masked-token").textContent });
    showConnectionError(`⚠ ${body.error.message}`);
  }
};

// ---- ダッシュボード(5.2) -----------------------------------------------------

const TILE_DEFS: { key: keyof Aggregate; label: string; cls: string }[] = [
  { key: "total", label: "全記事", cls: "" },
  { key: "upToDate", label: "最新", cls: "ok-num" },
  { key: "notBackedUp", label: "未バックアップ", cls: "" },
  { key: "qiitaUpdated", label: "Qiita更新あり", cls: "warn-num" },
  { key: "localModified", label: "ローカル変更あり", cls: "warn-num" },
  { key: "deletedOnQiita", label: "Qiita側削除", cls: "ng-num" },
];

const renderTiles = (aggregate: Aggregate): void => {
  $("tiles").innerHTML = TILE_DEFS.map(
    (t) =>
      `<div class="tile"><div class="label">${t.label}</div><div class="num ${t.cls}">${aggregate[t.key]}</div></div>`,
  ).join("");
};

const renderTable = (): void => {
  const filter = ($("filter-status") as HTMLSelectElement).value;
  const order = ($("sort-order") as HTMLSelectElement).value;

  let rows = articles.slice();
  if (filter) rows = rows.filter((a) => a.status === filter);
  rows.sort((a, b) => {
    switch (order) {
      case "updatedAsc":
        return (a.updatedAt || "").localeCompare(b.updatedAt || "");
      case "titleAsc":
        return a.title.localeCompare(b.title, "ja");
      case "statusAsc":
        return a.status.localeCompare(b.status);
      default:
        return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    }
  });

  $("articles-table").hidden = articles.length === 0;
  $("articles-empty").hidden = articles.length > 0;

  $("articles-body").innerHTML = rows
    .map((a) => {
      const deleted = a.status === "deletedOnQiita";
      const titleCell = deleted
        ? `<span class="muted">${escapeHtml(a.title)}</span>`
        : `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.title)}</a>`;
      const openBtn = a.folderName
        ? `<button class="link-btn" data-open="${escapeHtml(a.id)}">フォルダを開く</button>`
        : `<span class="muted">—</span>`;
      const check = deleted ? "" : `<input type="checkbox" class="row-check" value="${escapeHtml(a.id)}" />`;
      const privateMark = a.private ? ' <span class="chip chip-private">限定共有</span>' : "";
      return `<tr>
        <td>${check}</td>
        <td><span class="chip chip-${a.status}">${STATUS_LABEL[a.status]}</span></td>
        <td>${titleCell}${privateMark}</td>
        <td class="num">${deleted ? "—" : a.commentsCount}</td>
        <td class="num">${deleted ? "—" : a.likesCount}</td>
        <td class="num">${deleted ? "—" : a.stocksCount}</td>
        <td>${deleted ? "—" : fmtDate(a.updatedAt)}</td>
        <td>${fmtDate(a.lastBackupAt)}</td>
        <td>${openBtn}</td>
      </tr>`;
    })
    .join("");

  for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-open]")) {
    btn.addEventListener("click", () => {
      void fetch(`/api/articles/${btn.dataset["open"]}/open-folder`, { method: "POST" });
    });
  }
};

const loadArticles = async (refresh: boolean): Promise<void> => {
  const res = await fetch(`/api/articles${refresh ? "?refresh=true" : ""}`);
  if (!res.ok) {
    const body = (await res.json()) as { error: { code: string; message: string } };
    alert(body.error.message);
    if (body.error.code === "TOKEN_INVALID") showView("connection");
    return;
  }
  const body = (await res.json()) as {
    articles: ArticleListItem[];
    aggregate: Aggregate;
    gitAvailable: boolean;
  };
  articles = body.articles;
  renderTiles(body.aggregate);
  renderTable();
  $("git-warning").hidden = body.gitAvailable; // Git利用不可時の警告(6.6)
};

const startBackup = async (mode: "all" | "diff" | "selected", ids?: string[]): Promise<void> => {
  const post = async (confirmOverwrite: boolean): Promise<Response> =>
    fetch("/api/backup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, ids, confirmOverwrite }),
    });

  let res = await post(false);
  if (res.status === 400) {
    const body = (await res.json()) as { error: { code: string; message: string } };
    if (body.error.code === "OVERWRITE_CONFIRM_REQUIRED") {
      // ローカル変更ありの上書き確認(5.5)
      const okToOverwrite = window.confirm(
        "ローカルで変更された記事が含まれています。\nローカルの変更はQiita側の内容で上書きされます。続行しますか?",
      );
      if (!okToOverwrite) return;
      res = await post(true);
    } else {
      alert(body.error.message);
      return;
    }
  }
  if (!res.ok) {
    const body = (await res.json()) as { error: { message: string } };
    alert(body.error.message);
    return;
  }
  enterProgressView();
};

// ---- 実行状況(5.3) ----------------------------------------------------------

const enterProgressView = (): void => {
  $("progress-running").hidden = false;
  $("progress-summary").hidden = true;
  $("progress-log").innerHTML = "";
  $("rate-limit-notice").hidden = true;
  $("run-error-notice").hidden = true;
  updateProgressBar(0, 0, "");
  showView("progress");
};

const updateProgressBar = (done: number, total: number, currentTitle: string): void => {
  const pct = total > 0 ? Math.floor((done / total) * 100) : 0;
  const bar = $("progress-bar");
  bar.style.width = `${pct}%`;
  bar.textContent = `${pct}%`;
  $("progress-count").textContent = `${done} / ${total} 件(${pct}%)`;
  $("progress-current").textContent = currentTitle ? `現在処理中: ${currentTitle}` : "";
};

const appendLog = (line: string, cls: "ok" | "ng" | ""): void => {
  const div = document.createElement("div");
  if (cls) div.className = cls;
  div.textContent = line;
  const log = $("progress-log");
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
};

const renderSummary = async (summary: RunSummary): Promise<void> => {
  $("progress-running").hidden = true;
  $("progress-summary").hidden = false;
  $("summary-heading").textContent = summary.cancelled ? "バックアップ中断(処理済み分は保存済み)" : "バックアップ完了";
  $("sum-total").textContent = `${summary.total} 件`;
  $("sum-succeeded").textContent = `${summary.succeeded} 件`;
  $("sum-failed").textContent = `${summary.failed} 件`;
  $("sum-commit").textContent = summary.commit
    ? `Gitコミット: ${summary.commit.hash.slice(0, 7)}(${fmtDate(summary.commit.committedAt)})`
    : "Gitコミット: なし(変更なし、またはGit利用不可)";

  const failures = summary.imageFailures;
  $("image-failures-block").hidden = failures.length === 0;
  if (failures.length > 0) {
    $("image-failures-heading").textContent = `画像取得失敗一覧(${failures.length}件)`;
    $("image-failures-body").innerHTML = failures
      .map(
        (f) =>
          `<tr><td>${escapeHtml(f.articleTitle)}</td><td class="mono">${escapeHtml(f.url)}</td><td class="ng-num">${escapeHtml(f.reason)}</td></tr>`,
      )
      .join("");
  }

  // 実行履歴(直近コミット情報含む — 5.8)
  const res = await fetch("/api/history");
  if (res.ok) {
    const body = (await res.json()) as { history: RunSummary[] };
    $("history-list").innerHTML = body.history
      .slice(0, 10)
      .map((h) => {
        const commit = h.commit ? ` / commit ${h.commit.hash.slice(0, 7)}` : "";
        const state = h.cancelled ? "中断" : "完了";
        return `<div>${fmtDate(h.startedAt)} [${escapeHtml(h.mode)}] ${state}: 対象${h.total}件 成功${h.succeeded}件 失敗${h.failed}件${commit}</div>`;
      })
      .join("");
  }
};

const connectEvents = (): void => {
  const source = new EventSource("/api/backup/events");

  source.addEventListener("snapshot", (e) => {
    // 再接続時の状態回復: 実行中なら進捗画面へ
    const snap = JSON.parse((e as MessageEvent).data) as {
      running: boolean;
      done: number;
      total: number;
      currentTitle: string | null;
    };
    if (snap.running) {
      enterProgressView();
      updateProgressBar(snap.done, snap.total, snap.currentTitle ?? "");
    }
  });
  source.addEventListener("run-start", () => {
    enterProgressView();
  });
  source.addEventListener("progress", (e) => {
    const p = JSON.parse((e as MessageEvent).data) as { done: number; total: number; currentTitle: string };
    updateProgressBar(p.done, p.total, p.currentTitle);
    $("rate-limit-notice").hidden = true;
  });
  source.addEventListener("article-done", (e) => {
    const a = JSON.parse((e as MessageEvent).data) as {
      title: string;
      ok: boolean;
      imageFailed: number;
      reason?: string;
    };
    if (a.ok) {
      const suffix = a.imageFailed > 0 ? `完了(画像${a.imageFailed}件失敗)` : "完了";
      appendLog(`${a.title} … ${suffix}`, "ok");
    } else {
      appendLog(`${a.title} … 失敗(${a.reason ?? "リトライ上限"})`, "ng");
    }
  });
  source.addEventListener("waiting-rate-limit", (e) => {
    const w = JSON.parse((e as MessageEvent).data) as { resumeAt: string };
    const notice = $("rate-limit-notice");
    notice.hidden = false;
    notice.textContent = `Qiitaのレート制限中です。${fmtDate(w.resumeAt)} 頃に自動再開します…`;
  });
  source.addEventListener("run-error", (e) => {
    const err = JSON.parse((e as MessageEvent).data) as { message: string };
    const notice = $("run-error-notice");
    notice.hidden = false;
    notice.textContent = `⚠ ${err.message}`;
  });
  source.addEventListener("run-done", (e) => {
    const { summary } = JSON.parse((e as MessageEvent).data) as { summary: RunSummary };
    void renderSummary(summary);
    void loadArticles(false).catch(() => undefined);
  });
};

// ---- 初期化 -----------------------------------------------------------------

const init = async (): Promise<void> => {
  // イベント配線
  $("btn-verify").addEventListener("click", () => void verify());
  $("btn-verify-input").addEventListener("click", () => {
    const token = ($("token-input") as HTMLInputElement).value.trim();
    const save = ($("save-token") as HTMLInputElement).checked;
    if (!token) {
      showConnectionError("⚠ トークンを入力してください");
      return;
    }
    void verify(token, save);
  });
  $("nav-connection").addEventListener("click", (e) => {
    e.preventDefault();
    showView("connection");
  });
  $("btn-refresh").addEventListener("click", () => void loadArticles(true));
  $("btn-backup-diff").addEventListener("click", () => void startBackup("diff"));
  $("btn-backup-all").addEventListener("click", () => void startBackup("all"));
  $("btn-backup-selected").addEventListener("click", () => {
    const ids = Array.from(document.querySelectorAll<HTMLInputElement>(".row-check:checked")).map((c) => c.value);
    if (ids.length === 0) {
      alert("バックアップする記事を選択してください。");
      return;
    }
    void startBackup("selected", ids);
  });
  $("check-all").addEventListener("change", () => {
    const checked = ($("check-all") as HTMLInputElement).checked;
    for (const c of document.querySelectorAll<HTMLInputElement>(".row-check")) c.checked = checked;
  });
  $("filter-status").addEventListener("change", renderTable);
  $("sort-order").addEventListener("change", renderTable);
  $("btn-cancel").addEventListener("click", () => {
    void fetch("/api/backup/cancel", { method: "POST" });
    $("btn-cancel").setAttribute("disabled", "true");
    setTimeout(() => $("btn-cancel").removeAttribute("disabled"), 3000);
  });
  $("btn-back-to-list").addEventListener("click", () => {
    showView("dashboard");
    void loadArticles(false);
  });

  connectEvents();

  // 起動時: 接続状態で初期画面を決める(1.8)
  const res = await fetch("/api/connection");
  const status = (await res.json()) as ConnectionStatus;
  renderConnection(status);
  if (status.state === "connected") {
    showView("dashboard");
    await loadArticles(true);
  } else {
    showView("connection");
    // トークンがあれば自動で接続確認まで行う
    if (status.maskedToken) await verify();
  }
};

void init();

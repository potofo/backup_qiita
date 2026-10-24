/**
 * Web UI(タスク5 / article-upload-sync 10.1, 10.2) — 接続確認 / ダッシュボード / 実行状況 の3画面
 * - SSE(/api/backup/events)を購読して進捗を更新する(5.3)。Run方向(backup/upload)対応
 * - アップロードは実行前確認ダイアログ(428応答の確認情報)を経てのみ実行する(4.3, 8.1)
 * - 画像の自動アップロード(image-upload-automation 1.3, 1.4, 3.1, 3.2, 4.3, 6.5, 9.2): 設定パネル・同意・確認画面の画像欄・
 *   ログイン待機の案内・結果サマリの画像欄
 */

type WriteAccess = "unknown" | "granted" | "denied";

type ConnectionStatus =
  | { state: "unchecked"; maskedToken: string | null; writeAccess: WriteAccess }
  | { state: "connected"; userId: string; itemsCount: number; maskedToken: string | null; writeAccess: WriteAccess }
  | { state: "invalid"; reason: "missing" | "unauthorized" | "forbidden"; maskedToken: string | null; writeAccess: WriteAccess };

type ArticleListItem = {
  id: string;
  title: string;
  url: string;
  updatedAt: string;
  private: boolean;
  commentsCount: number;
  likesCount: number;
  stocksCount: number;
  status:
    | "notBackedUp"
    | "upToDate"
    | "qiitaUpdated"
    | "localModified"
    | "deletedOnQiita"
    | "localNew"
    | "conflict"
    | "localMissing";
  lastBackupAt: string | null;
  folderName: string | null;
  invalidReasons?: string[];
};

type Aggregate = {
  total: number;
  notBackedUp: number;
  upToDate: number;
  qiitaUpdated: number;
  localModified: number;
  deletedOnQiita: number;
  localNew: number;
  conflict: number;
  localMissing: number;
  needsBackup: number;
  needsUpload: number;
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
  direction?: "backup" | "upload";
  failures?: { id: string; title: string; reason: string }[];
  imageUpload?: {
    uploaded: number;
    reused: number;
    failed: { articleKey: string; articleTitle: string; ref: string; reason: string }[];
    workDraftUrl: string | null;
    aborted: string | null;
    abortMessage?: string;
  };
};

type ImagePlanStatus =
  | { kind: "upload" }
  | { kind: "reuse"; url: string }
  | { kind: "missing" }
  | { kind: "outsideFolder" }
  | { kind: "unsupported"; reason: string };

type ImageUploadPlan = {
  articles: { key: string; title: string; entries: { ref: string; bytes: number | null; status: ImagePlanStatus }[] }[];
  uploadCount: number;
  uploadBytes: number;
  reuseCount: number;
};

type UploadConfirmInfo = {
  targets: { key: string; title: string; kind: "create" | "update" }[];
  publicUpdates: { id: string; title: string }[];
  conflicts: { id: string; title: string }[];
  imageWarnings: { key: string; title: string; refs: string[] }[];
  imagePlan?: ImageUploadPlan;
};

type ImageUploadSettingsView = {
  enabled: boolean;
  consentedAt: string | null;
  persistSession: boolean;
  workDraftUrl: string | null;
  available: boolean;
  unavailableReason: string | null;
  hasSavedSession: boolean;
};

const STATUS_LABEL: Record<ArticleListItem["status"], string> = {
  notBackedUp: "未バックアップ",
  upToDate: "最新",
  qiitaUpdated: "Qiita更新あり",
  localModified: "ローカル変更あり",
  deletedOnQiita: "Qiitaから削除済",
  localNew: "ローカル新規",
  conflict: "競合",
  localMissing: "ローカル欠落",
};

const WRITE_ACCESS_LABEL: Record<WriteAccess, string> = {
  unknown: "書込: 未確認",
  granted: "読み書き",
  denied: "読み取りのみ",
};

const directionLabel = (direction?: string): string =>
  direction === "upload" ? "アップロード" : "バックアップ";

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
    // 権限種別(読み取りのみ/読み書き/未確認)を接続バッジへ含める(upload-sync 6.4)
    badge.textContent = `接続済(@${status.userId} / ${WRITE_ACCESS_LABEL[status.writeAccess]})`;
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
    $("conn-success-count").textContent =
      `投稿記事数: ${status.itemsCount}件(権限種別: ${WRITE_ACCESS_LABEL[status.writeAccess]})`;
  }
};

const showConnectionError = (message: string): void => {
  $("conn-error").hidden = false;
  $("conn-error-message").textContent = message;
};

/** 接続状態を取得し直してバッジ・接続画面を更新する(writeAccess反映 — upload-sync 6.4) */
const refreshConnection = async (): Promise<ConnectionStatus> => {
  const res = await fetch("/api/connection");
  const status = (await res.json()) as ConnectionStatus;
  renderConnection(status);
  return status;
};

const verify = async (token?: string, save?: boolean): Promise<void> => {
  const res = await fetch("/api/connection/verify", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token, save }),
  });
  if (res.ok) {
    await refreshConnection();
    ($("token-input") as HTMLInputElement).value = "";
    // 接続できたらダッシュボードへ遷移して一覧を取得する
    showView("dashboard");
    await loadArticles(true);
  } else {
    const body = (await res.json()) as { error: { code: string; message: string } };
    renderConnection({
      state: "invalid",
      reason: "unauthorized",
      maskedToken: $("masked-token").textContent,
      writeAccess: "unknown",
    });
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
  { key: "needsUpload", label: "アップロード候補", cls: "up-num" },
  { key: "conflict", label: "競合", cls: "ng-num" },
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
      const isLocalNew = a.status === "localNew";
      const invalidReasons = a.invalidReasons ?? [];
      // ローカル新規行: URLが無いためリンクにしない。不備理由を表示する(1.3)
      const reasonNote =
        isLocalNew && invalidReasons.length > 0
          ? `<div class="invalid-reasons">⚠ アップロード不可: ${invalidReasons.map(escapeHtml).join(" / ")}</div>`
          : "";
      const missingNote =
        a.status === "localMissing"
          ? `<div class="invalid-reasons">本文ファイルがありません(選択バックアップで復元できます)</div>`
          : "";
      const titleCell =
        deleted || isLocalNew || !a.url
          ? `<span${deleted ? ' class="muted"' : ""}>${escapeHtml(a.title)}</span>`
          : `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(a.title)}</a>`;
      const openBtn =
        a.folderName && !isLocalNew
          ? `<button class="link-btn" data-open="${escapeHtml(a.id)}">フォルダを開く</button>`
          : `<span class="muted">—</span>`;
      // 不備のあるローカル新規行は選択不可(アップロード不可 — 1.3)
      const selectable = !deleted && !(isLocalNew && invalidReasons.length > 0);
      const check = selectable ? `<input type="checkbox" class="row-check" value="${escapeHtml(a.id)}" />` : "";
      const privateMark = a.private && !isLocalNew ? ' <span class="chip chip-private">限定共有</span>' : "";
      return `<tr>
        <td>${check}</td>
        <td><span class="chip chip-${a.status}">${STATUS_LABEL[a.status]}</span></td>
        <td>${titleCell}${privateMark}${reasonNote}${missingNote}</td>
        <td class="num">${deleted || isLocalNew ? "—" : a.commentsCount}</td>
        <td class="num">${deleted || isLocalNew ? "—" : a.likesCount}</td>
        <td class="num">${deleted || isLocalNew ? "—" : a.stocksCount}</td>
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
  const { runId } = (await res.json()) as { runId: string };
  enterProgressView(undefined, runId);
};

// ---- 画像の自動アップロード設定(image-upload-automation 1.3, 1.4, 5.1〜5.3) ---------

/** 容量の表示(1MB未満はKB) */
const fmtMb = (bytes: number): string =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;

const renderImageSettings = (view: ImageUploadSettingsView): void => {
  $("img-status-label").textContent = !view.available ? "利用できません" : view.enabled ? "有効" : "無効";
  $("img-unavailable").hidden = view.available;
  $("img-unavailable-reason").textContent = view.unavailableReason ?? "";
  $("img-controls").hidden = !view.available;
  ($("img-enabled") as HTMLInputElement).checked = view.enabled;
  ($("img-persist") as HTMLInputElement).checked = view.persistSession;
  $("img-session-line").hidden = !view.hasSavedSession;
  $("img-draft-line").hidden = !view.workDraftUrl;
  const link = $("img-draft-link") as HTMLAnchorElement;
  link.href = view.workDraftUrl ?? "#";
  link.textContent = view.workDraftUrl ?? "";
};

const loadImageSettings = async (): Promise<void> => {
  const res = await fetch("/api/image-upload/settings");
  if (!res.ok) {
    $("image-upload-panel").hidden = true; // 機能が組み込まれていない
    return;
  }
  renderImageSettings((await res.json()) as ImageUploadSettingsView);
};

const putImageSettings = async (patch: Record<string, unknown>): Promise<void> => {
  const res = await fetch("/api/image-upload/settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const body = (await res.json()) as { error: { message: string } };
    alert(body.error.message);
  }
  await loadImageSettings();
};

/** 初回有効化時の同意ダイアログ(1.4) */
const askImageConsent = (): Promise<boolean> =>
  new Promise((resolve) => {
    const overlay = $("image-consent-overlay");
    overlay.hidden = false;
    const close = (agreed: boolean): void => {
      overlay.hidden = true;
      $("btn-image-consent").removeEventListener("click", onAgree);
      $("btn-image-consent-cancel").removeEventListener("click", onCancel);
      resolve(agreed);
    };
    const onAgree = (): void => close(true);
    const onCancel = (): void => close(false);
    $("btn-image-consent").addEventListener("click", onAgree);
    $("btn-image-consent-cancel").addEventListener("click", onCancel);
  });

const onImageEnabledChange = async (): Promise<void> => {
  const checkbox = $("img-enabled") as HTMLInputElement;
  if (!checkbox.checked) {
    await putImageSettings({ enabled: false });
    return;
  }
  const res = await fetch("/api/image-upload/settings");
  const view = (await res.json()) as ImageUploadSettingsView;
  if (!view.consentedAt && !(await askImageConsent())) {
    checkbox.checked = false;
    return;
  }
  await putImageSettings({ enabled: true, consent: true });
};

// ---- アップロード(upload-sync 10.1, 10.2) ------------------------------------

const IMAGE_STATUS_LABEL: Record<ImagePlanStatus["kind"], string> = {
  upload: "アップロード",
  reuse: "再利用(送信済み)",
  missing: "送れません: ファイルがありません",
  outsideFolder: "送れません: 記事フォルダの外を指しています",
  unsupported: "送れません",
};

/** 実行前確認の画像欄(3.1, 3.2) */
const renderImagePlan = (plan: ImageUploadPlan | undefined, hasWarnings: boolean): void => {
  const box = $("upload-confirm-image-plan");
  box.hidden = !plan;
  const check = $("upload-images-check") as HTMLInputElement;
  check.checked = false;
  const syncWarnings = (): void => {
    // 画像をアップロードする場合は、ローカル画像の警告(8.3)の代わりに画像欄の一覧で示す
    $("upload-confirm-images").hidden = !hasWarnings || (Boolean(plan) && check.checked);
    // 画像を送るかどうかを実行ボタンの文言でも示す(チェックの見落としで画像なしのまま送らないように)
    $("btn-upload-approve").textContent = !plan
      ? "アップロードを実行"
      : check.checked
        ? "画像をアップロードしてから記事をアップロード"
        : "画像はアップロードせずに記事だけをアップロード";
  };
  check.onchange = syncWarnings;
  syncWarnings();
  if (!plan) return;
  $("upload-image-plan-summary").textContent =
    `送信する画像: ${plan.uploadCount}枚(合計 ${fmtMb(plan.uploadBytes)})/ 再利用: ${plan.reuseCount}件`;
  $("upload-image-plan-list").innerHTML = plan.articles
    .filter((a) => a.entries.length > 0)
    .map((a) => {
      const rows = a.entries
        .map((e) => {
          const reason = e.status.kind === "unsupported" ? `: ${escapeHtml(e.status.reason)}` : "";
          const size = e.bytes !== null && e.status.kind === "upload" ? `(${fmtMb(e.bytes)})` : "";
          const cls = e.status.kind === "upload" || e.status.kind === "reuse" ? "" : ' class="ng"';
          return `<div${cls}>　${escapeHtml(e.ref)} ${size} … ${IMAGE_STATUS_LABEL[e.status.kind]}${reason}</div>`;
        })
        .join("");
      return `<div><strong>${escapeHtml(a.title)}</strong></div>${rows}`;
    })
    .join("");
};

/** 確認ダイアログを表示し、承認/キャンセルと画像アップロードの選択をPromiseで返す(4.3, 3.4, 3.5, 5.2, 8.3) */
const showUploadConfirm = (info: UploadConfirmInfo): Promise<{ approved: boolean; uploadImages: boolean }> =>
  new Promise((resolve) => {
    const creates = info.targets.filter((t) => t.kind === "create").length;
    const updates = info.targets.length - creates;
    $("upload-confirm-count").textContent =
      `対象: ${info.targets.length}件(新規登録 ${creates}件 / 更新 ${updates}件)`;
    $("upload-confirm-targets").innerHTML = info.targets
      .map((t) => `<div>${t.kind === "create" ? "🆕 新規" : "✏ 更新"}: ${escapeHtml(t.title)}</div>`)
      .join("");

    const publicBox = $("upload-confirm-public");
    publicBox.hidden = info.publicUpdates.length === 0;
    if (info.publicUpdates.length > 0) {
      publicBox.innerHTML =
        `<strong>⚠ 公開中の記事への更新が含まれます(即時に公開へ反映されます):</strong><br>` +
        info.publicUpdates.map((p) => escapeHtml(p.title)).join(" / ");
    }

    const conflictBox = $("upload-confirm-conflicts");
    conflictBox.hidden = info.conflicts.length === 0;
    if (info.conflicts.length > 0) {
      conflictBox.innerHTML =
        `<strong>⚠ 競合記事が含まれます。Qiita側の変更がローカルの内容で上書きされます:</strong><br>` +
        info.conflicts.map((c) => escapeHtml(c.title)).join(" / ");
    }

    const imageBox = $("upload-confirm-images");
    if (info.imageWarnings.length > 0) {
      imageBox.innerHTML =
        `<strong>⚠ ローカル画像の参照が含まれます。Qiita上では表示されません(画像アップロードはAPI非対応):</strong><br>` +
        info.imageWarnings
          .map((w) => `${escapeHtml(w.title)}: ${w.refs.map(escapeHtml).join(", ")}`)
          .join("<br>");
    }
    renderImagePlan(info.imagePlan, info.imageWarnings.length > 0);

    const overlay = $("upload-confirm-overlay");
    overlay.hidden = false;
    const close = (approved: boolean): void => {
      overlay.hidden = true;
      $("btn-upload-approve").removeEventListener("click", onApprove);
      $("btn-upload-cancel-dialog").removeEventListener("click", onCancel);
      const uploadImages = Boolean(info.imagePlan) && ($("upload-images-check") as HTMLInputElement).checked;
      resolve({ approved, uploadImages });
    };
    const onApprove = (): void => close(true);
    const onCancel = (): void => close(false);
    $("btn-upload-approve").addEventListener("click", onApprove);
    $("btn-upload-cancel-dialog").addEventListener("click", onCancel);
  });

const startUpload = async (mode: "changes" | "selected", ids?: string[]): Promise<void> => {
  const post = async (confirmed: boolean, uploadImages = false): Promise<Response> =>
    fetch("/api/upload", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode, ids, confirmed, uploadImages }),
    });

  // 1回目は確認なしで送信し、428の確認情報でダイアログを表示する(4.3)
  let res = await post(false);
  if (res.status === 428) {
    const body = (await res.json()) as { info: UploadConfirmInfo };
    const decision = await showUploadConfirm(body.info);
    if (!decision.approved) return;
    res = await post(true, decision.uploadImages); // 画像の送信は明示的に選んだ場合だけ(3.3)
  }
  if (!res.ok) {
    const body = (await res.json()) as {
      error: { code: string; message: string };
      details?: { key: string; reason: string }[];
    };
    const details = body.details
      ? `\n\n${body.details.map((d) => `・${d.key}: ${d.reason}`).join("\n")}`
      : "";
    alert(`${body.error.message}${details}`);
    return;
  }
  const { runId } = (await res.json()) as { runId: string };
  enterProgressView(undefined, runId);
};

// ---- 実行状況(5.3) ----------------------------------------------------------

/** 実行中RunのRun方向(中断先エンドポイント・見出しの切替に使う — upload-sync 7.6) */
let currentDirection: "backup" | "upload" = "backup";

/** 表示中のRun。SSEの run-start とPOSTの応答の到着順は不定なため、同じRunでは表示を初期化し直さない */
let progressRunId: string | null = null;

const enterProgressView = (direction?: "backup" | "upload", runId?: string): void => {
  if (runId && runId === progressRunId) {
    showView("progress");
    return;
  }
  if (runId) progressRunId = runId;
  if (direction) currentDirection = direction;
  $("progress-heading").textContent = `${directionLabel(currentDirection)}実行中…`;
  $("progress-running").hidden = false;
  $("progress-summary").hidden = true;
  $("progress-log").innerHTML = "";
  $("rate-limit-notice").hidden = true;
  $("run-error-notice").hidden = true;
  stopLoginCountdown();
  $("image-progress-line").hidden = true;
  updateProgressBar(0, 0, "");
  showView("progress");
};

// ---- 画像フェーズの表示(image-upload-automation 4.3, 6.5) -----------------------------

let loginTimer: ReturnType<typeof setInterval> | null = null;

const stopLoginCountdown = (): void => {
  if (loginTimer) clearInterval(loginTimer);
  loginTimer = null;
  $("image-login-notice").hidden = true;
};

/** ログイン待機の案内と残り時間 */
const startLoginCountdown = (timeoutAt: string): void => {
  stopLoginCountdown();
  const notice = $("image-login-notice");
  notice.hidden = false;
  const tick = (): void => {
    const remain = Math.max(0, Math.floor((new Date(timeoutAt).getTime() - Date.now()) / 1000));
    const mm = Math.floor(remain / 60);
    const ss = String(remain % 60).padStart(2, "0");
    notice.textContent = `開いたブラウザでQiitaにログインしてください。ログインが完了すると画像のアップロードを始めます(残り ${mm}:${ss})`;
  };
  tick();
  loginTimer = setInterval(tick, 1000);
};

const updateImageProgress = (done: number, total: number, name: string): void => {
  stopLoginCountdown();
  const line = $("image-progress-line");
  line.hidden = false;
  line.textContent = `画像のアップロード: ${done} / ${total} 枚${done < total ? `(処理中: ${name})` : ""}`;
};

/** 結果サマリの画像欄(9.2, 10.3) */
const renderImageSummary = (image: RunSummary["imageUpload"]): void => {
  $("image-upload-block").hidden = !image;
  if (!image) return;
  $("image-upload-counts").textContent =
    `アップロード ${image.uploaded}枚 / 再利用 ${image.reused}件 / 失敗 ${image.failed.length}件`;
  const abort = $("image-upload-abort");
  abort.hidden = !image.abortMessage;
  abort.textContent = image.abortMessage ? `⚠ ${image.abortMessage}` : "";
  $("image-upload-failures").hidden = image.failed.length === 0;
  $("image-upload-failures-body").innerHTML = image.failed
    .map(
      (f) =>
        `<tr><td>${escapeHtml(f.articleTitle)}</td><td class="mono">${escapeHtml(f.ref)}</td><td class="ng-num">${escapeHtml(f.reason)}</td></tr>`,
    )
    .join("");
  const draft = $("image-upload-draft");
  draft.hidden = !image.workDraftUrl;
  if (image.workDraftUrl) {
    draft.innerHTML =
      `画像の投入に使った作業用の下書きがQiita上に残っています: ` +
      `<a href="${escapeHtml(image.workDraftUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(image.workDraftUrl)}</a>` +
      `<br>次回の画像アップロードでも同じ下書きを使います。不要になったら、削除はQiita上でご自身で行ってください。`;
  }
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
  const kind = directionLabel(summary.direction);
  $("summary-heading").textContent = summary.cancelled
    ? `${kind}中断(処理済み分は保存済み)`
    : `${kind}完了`;
  $("sum-total").textContent = `${summary.total} 件`;
  $("sum-succeeded").textContent = `${summary.succeeded} 件`;
  $("sum-failed").textContent = `${summary.failed} 件`;
  $("sum-commit").textContent = summary.commit
    ? `Gitコミット: ${summary.commit.hash.slice(0, 7)}(${fmtDate(summary.commit.committedAt)})`
    : "Gitコミット: なし(変更なし、またはGit利用不可)";

  stopLoginCountdown();
  renderImageSummary(summary.imageUpload);

  // アップロード失敗記事の一覧と理由(9.4)
  const uploadFailures = summary.failures ?? [];
  $("upload-failures-block").hidden = uploadFailures.length === 0;
  if (uploadFailures.length > 0) {
    $("upload-failures-heading").textContent = `アップロード失敗一覧(${uploadFailures.length}件)`;
    $("upload-failures-body").innerHTML = uploadFailures
      .map((f) => `<tr><td>${escapeHtml(f.title)}</td><td class="ng-num">${escapeHtml(f.reason)}</td></tr>`)
      .join("");
  }

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

  // 実行履歴(直近コミット情報含む — 5.8)。Run方向を表示する(upload-sync 7.6)
  const res = await fetch("/api/history");
  if (res.ok) {
    const body = (await res.json()) as { history: RunSummary[] };
    $("history-list").innerHTML = body.history
      .slice(0, 10)
      .map((h) => {
        const commit = h.commit ? ` / commit ${h.commit.hash.slice(0, 7)}` : "";
        const state = h.cancelled ? "中断" : "完了";
        return `<div>${fmtDate(h.startedAt)} [${directionLabel(h.direction)}/${escapeHtml(h.mode)}] ${state}: 対象${h.total}件 成功${h.succeeded}件 失敗${h.failed}件${commit}</div>`;
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
      runId: string | null;
      direction: "backup" | "upload" | null;
      done: number;
      total: number;
      currentTitle: string | null;
      loginWaitingUntil?: string | null;
      image?: { done: number; total: number; currentName: string } | null;
    };
    if (snap.running) {
      enterProgressView(snap.direction ?? "backup", snap.runId ?? undefined);
      updateProgressBar(snap.done, snap.total, snap.currentTitle ?? "");
      if (snap.loginWaitingUntil) startLoginCountdown(snap.loginWaitingUntil);
      if (snap.image) updateImageProgress(snap.image.done, snap.image.total, snap.image.currentName);
    }
  });
  source.addEventListener("image-login-waiting", (e) => {
    const w = JSON.parse((e as MessageEvent).data) as { timeoutAt: string };
    startLoginCountdown(w.timeoutAt);
  });
  source.addEventListener("image-progress", (e) => {
    const p = JSON.parse((e as MessageEvent).data) as { done: number; total: number; currentName: string };
    updateImageProgress(p.done, p.total, p.currentName);
  });
  source.addEventListener("image-done", (e) => {
    const d = JSON.parse((e as MessageEvent).data) as { name: string; ok: boolean; reason?: string };
    appendLog(`🖼 ${d.name} … ${d.ok ? "アップロード完了" : `失敗(${d.reason ?? "不明"})`}`, d.ok ? "ok" : "ng");
  });
  source.addEventListener("run-start", (e) => {
    const start = JSON.parse((e as MessageEvent).data) as { runId: string; direction?: "backup" | "upload" };
    enterProgressView(start.direction ?? "backup", start.runId);
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
    // アップロード結果で権限種別が変わり得るため接続バッジを更新する(6.4)
    void refreshConnection().catch(() => undefined);
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
    const ids = Array.from(document.querySelectorAll<HTMLInputElement>(".row-check:checked"))
      .map((c) => c.value)
      .filter((id) => !id.startsWith("local:")); // ローカル新規はダウンロード不能
    if (ids.length === 0) {
      alert("バックアップする記事を選択してください。");
      return;
    }
    void startBackup("selected", ids);
  });
  $("btn-upload-changes").addEventListener("click", () => void startUpload("changes"));
  $("btn-upload-selected").addEventListener("click", () => {
    const ids = Array.from(document.querySelectorAll<HTMLInputElement>(".row-check:checked")).map((c) => c.value);
    if (ids.length === 0) {
      alert("アップロードする記事を選択してください。");
      return;
    }
    void startUpload("selected", ids);
  });
  $("check-all").addEventListener("change", () => {
    const checked = ($("check-all") as HTMLInputElement).checked;
    for (const c of document.querySelectorAll<HTMLInputElement>(".row-check")) c.checked = checked;
  });
  $("filter-status").addEventListener("change", renderTable);
  $("sort-order").addEventListener("change", renderTable);
  $("btn-cancel").addEventListener("click", () => {
    // 実行中Runの方向に応じて中断先を切り替える(upload-sync 7.2)
    const endpoint = currentDirection === "upload" ? "/api/upload/cancel" : "/api/backup/cancel";
    void fetch(endpoint, { method: "POST" });
    $("btn-cancel").setAttribute("disabled", "true");
    setTimeout(() => $("btn-cancel").removeAttribute("disabled"), 3000);
  });
  $("btn-back-to-list").addEventListener("click", () => {
    showView("dashboard");
    void loadArticles(false);
    void loadImageSettings().catch(() => undefined);
  });
  // 画像の自動アップロード設定(image-upload-automation 1.4, 5.3)
  $("img-enabled").addEventListener("change", () => void onImageEnabledChange());
  $("img-persist").addEventListener("change", () => {
    void putImageSettings({ persistSession: ($("img-persist") as HTMLInputElement).checked });
  });
  $("btn-img-clear-session").addEventListener("click", () => {
    if (!window.confirm("保存済みのQiitaのログイン状態を削除します。よろしいですか?")) return;
    void fetch("/api/image-upload/session", { method: "DELETE" }).then(async (res) => {
      if (!res.ok) alert(((await res.json()) as { error: { message: string } }).error.message);
      await loadImageSettings();
    });
  });
  void loadImageSettings().catch(() => undefined);

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

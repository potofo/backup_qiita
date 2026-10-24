/**
 * テスト用の模擬Qiitaエディタ画面(image-upload-automation タスク1.3, 2.6)
 * - 2026-10-25 に観測した実画面の挙動を最小限に再現する(research.md「Qiitaエディタの挙動」)
 *   - 未ログインで /drafts/new を開くと /login?redirect_to=... へリダイレクト
 *   - input[type=file] へ画像を投入すると、本文(.cm-editor)へ ![ファイル名](画像URL) が挿入される
 *   - 最初の投入で URL が /drafts/{id}/edit に変わる(自動保存)
 * - 本文のDOMは 2026-10-25 に実画面で確認した構造に合わせる:
 *   - `.cm-content`(contenteditable)の中に1行ずつ `.cm-line` が並ぶ
 *   - 本文が空のときは1行目に案内文 `<span class="cm-placeholder">` が入る(innerText に案内文が含まれる)
 *   - CodeMirror の EditorView(cmView)は外から参照できない。exposeCmView: true のときだけ参照できる版にする
 */
import { createServer, type Server } from "node:http";

export type MockEditorOptions = {
  /** true: ログインCookieがないとログイン画面へリダイレクトする */
  requireLogin?: boolean;
  /** true: 画像投入欄を置かない(画面変更の再現 — 8.1) */
  omitFileInput?: boolean;
  /** 画像URLのホスト(既定: qiita-image-store.s3.ap-northeast-1.amazonaws.com) */
  imageHost?: string;
  /** true: 投入してもURLを挿入しない(タイムアウトの再現 — 6.4) */
  neverInsert?: boolean;
  /** 挿入までの遅延ms(既定50) */
  insertDelayMs?: number;
  /** true: `.cm-editor` に cmView.view を置く(EditorView に届く版の再現)。既定は実画面と同じく置かない */
  exposeCmView?: boolean;
};

export type MockQiitaEditor = {
  origin: string;
  /** サーバが受けたリクエストのパス */
  requestedPaths: string[];
  close: () => Promise<void>;
};

const DRAFT_ID = "mockdraft0001";

const editorHtml = (options: MockEditorOptions): string => `<!doctype html>
<html><head><meta charset="utf-8"><title>記事を新規作成 - Qiita</title></head>
<body>
<div class="cm-editor"><div class="cm-content" contenteditable="true"></div></div>
${options.omitFileInput ? "" : '<input type="file" accept="image/*">'}
<button id="publish">記事を投稿</button>
<script>
  const content = document.querySelector(".cm-content");
  const editor = document.querySelector(".cm-editor");
  const PLACEHOLDER = "エンジニアに関わる知識をMarkdown記法で書いて共有しよう";
  // 本文はDOM(.cm-line)が正。案内文は本文に含めない
  const readText = () =>
    [...content.querySelectorAll(".cm-line")]
      .map((line) => [...line.childNodes].filter((n) => !(n.classList && n.classList.contains("cm-placeholder"))).map((n) => n.textContent).join(""))
      .join("\\n");
  const render = (text) => {
    content.innerHTML = "";
    for (const lineText of text.split("\\n")) {
      const line = document.createElement("div");
      line.className = "cm-line";
      line.textContent = lineText;
      content.appendChild(line);
    }
    if (text === "") {
      const ph = document.createElement("span");
      ph.className = "cm-placeholder";
      ph.setAttribute("contenteditable", "false");
      ph.textContent = PLACEHOLDER;
      content.firstChild.appendChild(ph);
    }
  };
  render("");
  // キー操作で消されたら、実画面と同じく空行+案内文に戻す
  content.addEventListener("input", () => render(readText().replace(/\\n+$/, "")));
  ${
    options.exposeCmView
      ? `editor.cmView = { view: {
    get state() { const t = readText(); return { doc: { toString: () => t, get length() { return t.length; } } }; },
    dispatch(tr) { const t = readText(); const c = tr.changes; render(t.slice(0, c.from) + (c.insert || "") + t.slice(c.to === undefined ? c.from : c.to)); },
  } };`
      : ""
  }
  let counter = 0;
  const input = document.querySelector('input[type=file]');
  if (input) input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    if (!file) return;
    ${options.neverInsert ? "return;" : ""}
    setTimeout(() => {
      counter += 1;
      const current = readText();
      const inserted = "![" + file.name + "](https://${options.imageHost ?? "qiita-image-store.s3.ap-northeast-1.amazonaws.com"}/0/1/mock-" + Date.now() + "-" + counter + ".png)";
      render(current === "" ? inserted : current + "\\n" + inserted);
      if (location.pathname === "/drafts/new") history.replaceState(null, "", "/drafts/${DRAFT_ID}/edit");
      input.value = "";
    }, ${options.insertDelayMs ?? 50});
  });
</script>
</body></html>`;

const loginHtml = `<!doctype html>
<html><head><meta charset="utf-8"><title>ログイン - Qiita</title></head>
<body>
<input name="identity"><input name="password" type="password">
<button id="login">ログイン</button>
<script>
  document.getElementById("login").addEventListener("click", () => {
    document.cookie = "mock_session=1; path=/";
    const params = new URLSearchParams(location.search);
    location.href = params.get("redirect_to") || "/drafts/new";
  });
</script>
</body></html>`;

export async function startMockQiitaEditor(options: MockEditorOptions = {}): Promise<MockQiitaEditor> {
  const requestedPaths: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    requestedPaths.push(url.pathname);
    const loggedIn = /(?:^|;\s*)mock_session=1/.test(req.headers.cookie ?? "");

    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(loginHtml);
      return;
    }
    const isEditor = url.pathname === "/drafts/new" || url.pathname === `/drafts/${DRAFT_ID}/edit`;
    if (isEditor) {
      if (options.requireLogin && !loggedIn) {
        res.writeHead(302, { location: `/login?redirect_to=${encodeURIComponent(url.pathname)}` }).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(editorHtml(options));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" }).end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no address");

  return {
    origin: `http://127.0.0.1:${address.port}`,
    requestedPaths,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

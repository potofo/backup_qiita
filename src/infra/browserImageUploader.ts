/**
 * Qiitaエディタへの画像投入(image-upload-automation 1.3, 4.1〜4.3, 5.1, 5.2, 6.1〜6.4, 6.7, 8.1, 9.3, 11.1〜11.3)
 * - playwright-core を import してよい唯一のモジュール(動的 import — steering tech.md)。未導入なら「利用不可」
 * - 画面ありのブラウザを Edge → Chrome の順に起動する(ブラウザ本体は同梱しない)
 * - ログインは利用者がブラウザ上で行う。ID・パスワード欄、保存・投稿・公開のボタン、設定画面には触れない(4.2, 6.7)
 * - Cookie・ストレージの値を読まない・ログに出さない(5.4, 11.3)。アクセストークンには依存しない(11.2)
 * - ツール自身の遷移先は QiitaEditorProfile のオリジンに限る(11.1)
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { CancelToken, Result } from "../types/index.js";
import { ok, err } from "../types/index.js";
import { QIITA_EDITOR_PROFILE, isEditorUrl, type QiitaEditorProfile } from "./qiitaEditorProfile.js";
import { removeDirRecursive } from "./removeDir.js";
import type { Logger } from "../config/logger.js";

export type OpenOptions = {
  persistSession: boolean;
  /** 前回の作業用下書き(なければ新規作成画面を開く — 9.1) */
  workDraftUrl: string | null;
};

export type UploaderError =
  | { kind: "launchFailed"; message: string }
  | { kind: "timeout" }
  | { kind: "closedByUser" }
  | { kind: "cancelled" }
  | { kind: "editorElementMissing"; element: string }
  | { kind: "noUrlObserved" };

export interface EditorSession {
  /** ログイン完了と画像投入欄の出現を待つ(4.3) */
  waitUntilReady(timeoutMs: number, cancel: CancelToken): Promise<Result<void, UploaderError>>;
  /** 画像1枚を投入し、Qiitaが発行したURLを返す(6.1, 6.2) */
  uploadImage(absPath: string, timeoutMs: number): Promise<Result<string, UploaderError>>;
  /** 現在開いている作業用下書きのURL(自動保存後に確定する) */
  currentDraftUrl(): string | null;
  /** ブラウザを閉じ、一時プロファイルなら削除する。何度呼んでもよい */
  close(): Promise<void>;
}

export type UploaderAvailability = { available: true } | { available: false; reason: string };

export interface EditorImageUploader {
  availability(): Promise<UploaderAvailability>;
  open(options: OpenOptions): Promise<Result<EditorSession, UploaderError>>;
}

// ---- playwright-core の利用部分の構造型(未導入でも型チェックが通るよう、必要な面だけを定義する) ----

export type PageLike = {
  goto(url: string): Promise<{ status(): number } | null>;
  url(): string;
  isClosed?(): boolean;
  locator(selector: string): {
    count(): Promise<number>;
    first(): { setInputFiles(files: string): Promise<void>; click(): Promise<void> };
  };
  evaluate<R>(expression: string): Promise<R>;
  keyboard: { press(key: string): Promise<void> };
  click(selector: string): Promise<void>;
  close(): Promise<void>;
};

export type BrowserContextLike = {
  pages(): PageLike[];
  newPage(): Promise<PageLike>;
  on(event: "close", listener: () => void): void;
  close(): Promise<void>;
};

export type PlaywrightLike = {
  chromium: {
    launchPersistentContext(
      userDataDir: string,
      options: { channel?: string; headless?: boolean; viewport?: null },
    ): Promise<BrowserContextLike>;
  };
};

/** テスト用の補助操作を持つセッション(EditorSession の拡張) */
export interface BrowserEditorSession extends EditorSession {
  /** 本文エディタの現在の内容(検証用) */
  editorText(): Promise<string | null>;
  /** 利用者の操作をテストで再現するためのページ */
  debugPage(): PageLike;
}

type Options = {
  /** セッションを保存する場合のプロファイル(.image-upload/browser-profile/) */
  persistentProfileDir: string;
  profile?: QiitaEditorProfile;
  /** テスト用。本番は常に画面あり(4.1) */
  headless?: boolean;
  channels?: string[];
  loadPlaywright?: () => Promise<PlaywrightLike>;
  /** ログイン待機中に画面要素の不在を判定するまでの猶予ms(8.1) */
  elementGraceMs?: number;
  pollIntervalMs?: number;
  logger?: Logger;
};

const PLAYWRIGHT_MODULE = "playwright-core";

const defaultLoader = async (): Promise<PlaywrightLike> => {
  // 文字列変数経由で import し、未導入でも型チェック・ビルドが通るようにする(任意依存)
  const loaded = (await import(PLAYWRIGHT_MODULE)) as { chromium?: unknown; default?: { chromium?: unknown } };
  const chromium = (loaded.chromium ?? loaded.default?.chromium) as PlaywrightLike["chromium"] | undefined;
  if (!chromium || typeof chromium.launchPersistentContext !== "function") {
    throw new Error(`${PLAYWRIGHT_MODULE} の読み込み結果が想定と異なります`);
  }
  return { chromium };
};

/** エディタ本文から画像URL(Markdown画像記法・imgタグ)を取り出す */
const IMAGE_URL_PATTERN = /!\[[^\]]*\]\((\S+?)\)|<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const imageUrlsIn = (text: string): string[] =>
  [...text.matchAll(IMAGE_URL_PATTERN)].map((m) => (m[1] ?? m[2])!).filter((u) => /^https?:\/\//.test(u));

type EditorSelectors = QiitaEditorProfile["selectors"];

/**
 * ページ内で実行するスクリプト(文字列式)。サーバ側の型定義に DOM を含めないため関数ではなく文字列で渡す。
 * EditorView(cmView.view)に届く場合はそれを使う。2026-10-25 時点の実画面では届かないため、
 * 本文は行要素(.cm-line)から案内文(.cm-placeholder)を除いて読み、消去はキー操作で行う
 */
const findViewScript = (sel: EditorSelectors): string => `
  const content = document.querySelector(${JSON.stringify(sel.content)});
  const editor = document.querySelector(${JSON.stringify(sel.editor)});
  const view = (content && content.cmView && content.cmView.view) || (editor && editor.cmView && editor.cmView.view);`;

/** 本文を読む(EditorView が取れなければ行要素から。本文要素がなければ null) */
const readEditorScript = (sel: EditorSelectors): string =>
  `(() => {${findViewScript(sel)}
    if (view) return view.state.doc.toString();
    if (!content) return null;
    const lines = content.querySelectorAll(${JSON.stringify(sel.line)});
    const sources = lines.length > 0 ? [...lines] : [content];
    return sources
      .map((line) => {
        const copy = line.cloneNode(true);
        for (const extra of copy.querySelectorAll(${JSON.stringify(sel.ignoredInText)})) extra.remove();
        return copy.textContent;
      })
      .join("\\n");
  })()`;

/** EditorView で本文を空にする(できなければ false) */
const clearEditorScript = (sel: EditorSelectors): string =>
  `(() => {${findViewScript(sel)}
    if (!view) return false;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
    return true;
  })()`;

class BrowserSession implements BrowserEditorSession {
  private closed = false;
  private disposed = false;

  constructor(
    private readonly context: BrowserContextLike,
    private readonly page: PageLike,
    private readonly profile: QiitaEditorProfile,
    private readonly tempProfileDir: string | null,
    private readonly options: { elementGraceMs: number; pollIntervalMs: number; logger?: Logger },
  ) {
    context.on("close", () => {
      this.closed = true;
    });
  }

  private isGone(): boolean {
    return this.closed || (this.page.isClosed?.() ?? false);
  }

  /** 画面要素の不在を調べる(不足があればその要素のセレクタを返す) */
  private async missingElement(): Promise<string | null> {
    const { selectors } = this.profile;
    if ((await this.page.locator(selectors.fileInput).count()) === 0) return selectors.fileInput;
    const hasEditor =
      (await this.page.locator(selectors.content).count()) > 0 || (await this.page.locator(selectors.editor).count()) > 0;
    return hasEditor ? null : selectors.content;
  }

  async waitUntilReady(timeoutMs: number, cancel: CancelToken): Promise<Result<void, UploaderError>> {
    const deadline = Date.now() + timeoutMs;
    let onEditorSince: number | null = null;
    for (;;) {
      if (cancel.cancelled) return err({ kind: "cancelled" });
      if (this.isGone()) return err({ kind: "closedByUser" });
      try {
        if (isEditorUrl(this.profile, this.page.url())) {
          const missing = await this.missingElement();
          if (missing === null) return ok(undefined);
          // 読み込み途中の可能性があるため、エディタ画面に居続けて猶予を過ぎたら画面変更とみなす(8.1)
          onEditorSince ??= Date.now();
          if (Date.now() - onEditorSince >= this.options.elementGraceMs) {
            return err({ kind: "editorElementMissing", element: missing });
          }
        } else {
          onEditorSince = null; // ログイン画面・外部の認証画面など(利用者の操作中)
        }
      } catch {
        if (this.isGone()) return err({ kind: "closedByUser" });
        // 画面遷移中の一時的な失敗は次の確認で回復する
      }
      if (Date.now() >= deadline) return err({ kind: "timeout" });
      await delay(this.options.pollIntervalMs);
    }
  }

  async editorText(): Promise<string | null> {
    return this.page.evaluate<string | null>(readEditorScript(this.profile.selectors));
  }

  private async clearEditor(): Promise<boolean> {
    if (await this.page.evaluate<boolean>(clearEditorScript(this.profile.selectors))) return true;
    // EditorView に届かない場合は利用者と同じキー操作で全選択して消す
    const content = this.page.locator(this.profile.selectors.content);
    if ((await content.count()) === 0) return false;
    await content.first().click();
    await this.page.keyboard.press("Control+A");
    await this.page.keyboard.press("Delete");
    // エディタは表示の更新を次の描画まで遅らせることがあるため、空になるまで少し待つ
    const deadline = Date.now() + 2_000;
    for (;;) {
      if ((await this.editorText())?.trim() === "") return true;
      if (Date.now() >= deadline) return false;
      await delay(100);
    }
  }

  async uploadImage(absPath: string, timeoutMs: number): Promise<Result<string, UploaderError>> {
    if (this.isGone()) return err({ kind: "closedByUser" });
    try {
      if (!isEditorUrl(this.profile, this.page.url())) {
        return err({ kind: "editorElementMissing", element: "エディタ画面" });
      }
      const missing = await this.missingElement();
      if (missing) return err({ kind: "editorElementMissing", element: missing });
      // 本文を空にしてから投入し、投入後に現れた新しいURLだけを採る(9.3 — 下書きに記事内容を残さない)
      if (!(await this.clearEditor())) return err({ kind: "editorElementMissing", element: this.profile.selectors.content });
      const before = new Set(imageUrlsIn((await this.editorText()) ?? ""));
      await this.page.locator(this.profile.selectors.fileInput).first().setInputFiles(absPath);

      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (this.isGone()) return err({ kind: "closedByUser" });
        const fresh = imageUrlsIn((await this.editorText()) ?? "").find((u) => !before.has(u));
        if (fresh) {
          await this.clearEditor();
          return ok(fresh);
        }
        if (Date.now() >= deadline) return err({ kind: "timeout" }); // 6.4
        await delay(this.options.pollIntervalMs);
      }
    } catch (cause) {
      if (this.isGone()) return err({ kind: "closedByUser" });
      this.options.logger?.warn("画像の投入中に画面操作が失敗しました", { cause: String(cause).split("\n")[0] });
      return err({ kind: "noUrlObserved" });
    }
  }

  currentDraftUrl(): string | null {
    if (this.isGone()) return null;
    const url = this.page.url();
    // 自動保存で /drafts/{id}/edit に変わった後だけ確定とする
    return isEditorUrl(this.profile, url) && !new URL(url).pathname.endsWith(this.profile.newDraftPath) ? url : null;
  }

  debugPage(): PageLike {
    return this.page;
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      if (!this.closed) await this.context.close();
    } catch {
      // 既に閉じている
    }
    this.closed = true;
    if (this.tempProfileDir) await removeTempProfile(this.tempProfileDir, this.options.logger);
  }
}

/** 一時プロファイルを削除する。ブラウザ終了直後はファイルが掴まれていることがあるため数回試す(5.1) */
const removeTempProfile = async (dir: string, logger?: Logger): Promise<void> => {
  let failed: string[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    failed = removeDirRecursive(dir);
    if (failed.length === 0) return;
    await delay(200);
  }
  logger?.warn("一時ブラウザプロファイルを削除できませんでした", { remaining: failed.length });
};

export class BrowserImageUploaderImpl implements EditorImageUploader {
  private readonly profile: QiitaEditorProfile;
  private readonly loadPlaywright: () => Promise<PlaywrightLike>;

  constructor(private readonly options: Options) {
    this.profile = options.profile ?? QIITA_EDITOR_PROFILE;
    this.loadPlaywright = options.loadPlaywright ?? defaultLoader;
  }

  async availability(): Promise<UploaderAvailability> {
    try {
      await this.loadPlaywright();
      return { available: true };
    } catch (cause) {
      return {
        available: false,
        reason: `ブラウザ操作ライブラリ(${PLAYWRIGHT_MODULE})を読み込めません: ${String(cause).split("\n")[0]}`,
      };
    }
  }

  async open(options: OpenOptions): Promise<Result<BrowserEditorSession, UploaderError>> {
    let playwright: PlaywrightLike;
    try {
      playwright = await this.loadPlaywright();
    } catch (cause) {
      return err({ kind: "launchFailed", message: `${PLAYWRIGHT_MODULE} を読み込めません: ${String(cause).split("\n")[0]}` });
    }

    const tempProfileDir = options.persistSession ? null : mkdtempSync(join(tmpdir(), "qbt-browser-"));
    const userDataDir = tempProfileDir ?? this.options.persistentProfileDir;
    const errors: string[] = [];
    for (const channel of this.options.channels ?? ["msedge", "chrome"]) {
      let context: BrowserContextLike;
      try {
        context = await playwright.chromium.launchPersistentContext(userDataDir, {
          channel,
          headless: this.options.headless ?? false,
          viewport: null,
        });
      } catch (cause) {
        errors.push(`${channel}: ${String(cause).split("\n")[0]}`);
        continue;
      }
      try {
        const page = context.pages()[0] ?? (await context.newPage());
        const session = new BrowserSession(context, page, this.profile, tempProfileDir, {
          elementGraceMs: this.options.elementGraceMs ?? 3_000,
          pollIntervalMs: this.options.pollIntervalMs ?? 300,
          ...(this.options.logger ? { logger: this.options.logger } : {}),
        });
        // ツールが開くのはQiitaのエディタ画面だけ(11.1)。記録済みの下書きがQiitaのエディタでなければ新規作成画面
        const newDraftUrl = `${this.profile.origin}${this.profile.newDraftPath}`;
        const target =
          options.workDraftUrl && isEditorUrl(this.profile, options.workDraftUrl) ? options.workDraftUrl : newDraftUrl;
        const response = await page.goto(target);
        if (target !== newDraftUrl && response && response.status() >= 400) {
          await page.goto(newDraftUrl); // 作業用下書きが削除済みなら新規作成に戻す
        }
        this.options.logger?.info("画像アップロード用のブラウザを起動しました", { channel });
        return ok(session);
      } catch (cause) {
        await context.close().catch(() => undefined);
        errors.push(`${channel}: ${String(cause).split("\n")[0]}`);
      }
    }
    if (tempProfileDir) await removeTempProfile(tempProfileDir, this.options.logger);
    return err({ kind: "launchFailed", message: `ブラウザ(Edge / Chrome)を起動できませんでした。${errors.join(" / ")}` });
  }
}

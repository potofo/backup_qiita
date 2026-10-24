/**
 * Qiitaエディタ画面の定義(image-upload-automation 2.5, 6.3, 8.1, 11.1)
 * - 自動化が前提とする画面の事実(URL・セレクタ・画像URLの許可ホスト・受け付ける画像)をこの1か所に集約する。
 *   Qiitaの画面が変わったら、まずここを直す(steering qiita-api.md の例外規定)
 * - 根拠: 2026-10-25 の手動作業での観測(.kiro/specs/image-upload-automation/research.md「Qiitaエディタの挙動」)
 *   - 未ログインで /drafts/new を開くと /login?redirect_to=... へリダイレクトされ、ログイン後に戻る
 *   - 画像投入欄は input[type=file](accept="image/*", multiple=false)が1つ、本文は CodeMirror 6(.cm-editor / .cm-content)
 *   - 画像を投入すると ![元ファイル名](https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/{ユーザ番号}/{UUID}.png) が挿入される
 *   - 最初の投入で下書きが自動保存され、URLが /drafts/{下書きID}/edit に変わる
 *   - 本文は .cm-content の中に1行ずつ .cm-line が並ぶ。本文が空のときは1行目に案内文
 *     <span class="cm-placeholder">エンジニアに関わる知識をMarkdown記法で書いて共有しよう</span> が入る
 *   - EditorView(cmView)は .cm-content / .cm-editor のどちらからも参照できない(実画面で確認)
 */
import { extname } from "node:path";
import type { Result } from "../types/index.js";
import { ok, err } from "../types/index.js";

export type QiitaEditorProfile = {
  /** ツールが自ら遷移してよいオリジン(本番は https://qiita.com。テストでは模擬画面に差し替える) */
  origin: string;
  newDraftPath: string;
  /** エディタ画面のパス(新規作成・下書き編集) */
  editorPathPattern: RegExp;
  selectors: {
    fileInput: string;
    /** CodeMirror の本文要素(contenteditable) */
    content: string;
    editor: string;
    /** 本文の1行 */
    line: string;
    /** 本文として読まない要素(本文が空のときの案内文など) */
    ignoredInText: string;
  };
};

export const createQiitaEditorProfile = (origin: string): QiitaEditorProfile => ({
  origin: new URL(origin).origin,
  newDraftPath: "/drafts/new",
  editorPathPattern: /^\/drafts\/(?:new|[A-Za-z0-9]+\/edit)$/,
  selectors: {
    fileInput: 'input[type="file"]',
    content: ".cm-content",
    editor: ".cm-editor",
    line: ".cm-line",
    ignoredInText: ".cm-placeholder, .cm-widgetBuffer",
  },
});

export const QIITA_EDITOR_PROFILE = createQiitaEditorProfile("https://qiita.com");

const parseUrl = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** ツール自身の遷移先として認めるURL(11.1) */
export const isQiitaUrl = (profile: QiitaEditorProfile, url: string): boolean =>
  parseUrl(url)?.origin === profile.origin;

export const isEditorUrl = (profile: QiitaEditorProfile, url: string): boolean => {
  const parsed = parseUrl(url);
  return parsed !== null && parsed.origin === profile.origin && profile.editorPathPattern.test(parsed.pathname);
};

/** Qiitaの画像配信ホスト(qiita-image-store.s3[.{region}].amazonaws.com)の https URL だけを認める(6.3) */
const IMAGE_HOST_PATTERN = /^qiita-image-store\.s3(?:\.[a-z0-9-]+)?\.amazonaws\.com$/;

export const isAllowedImageUrl = (url: string): boolean => {
  const parsed = parseUrl(url);
  return parsed !== null && parsed.protocol === "https:" && IMAGE_HOST_PATTERN.test(parsed.hostname);
};

// ---- 受け付ける画像(2.5) ---------------------------------------------------

export type AcceptedImageType = "png" | "jpeg" | "gif";

const IMAGE_TYPES: { type: AcceptedImageType; exts: string[]; magic: number[] }[] = [
  { type: "png", exts: [".png"], magic: [0x89, 0x50, 0x4e, 0x47] },
  { type: "jpeg", exts: [".jpg", ".jpeg"], magic: [0xff, 0xd8, 0xff] },
  { type: "gif", exts: [".gif"], magic: [0x47, 0x49, 0x46, 0x38] },
];

/**
 * 1ファイルの容量上限。Qiita公式の現行値は未確認(research.md)。
 * 上限を超えてQiitaに拒否されてもURLが得られない失敗として安全に扱えるため、ここでは目安として持つ
 */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 拡張子と先頭バイトの両方が一致する形式を返す(どちらかが合わなければ対象外) */
export const detectImageType = (fileName: string, head: Buffer): Result<AcceptedImageType, string> => {
  const ext = extname(fileName).toLowerCase();
  const byExt = IMAGE_TYPES.find((t) => t.exts.includes(ext));
  if (!byExt) return err(`対応していない画像形式です(${ext || "拡張子なし"})。PNG・JPEG・GIFのみアップロードできます`);
  const matches = byExt.magic.every((byte, i) => head[i] === byte);
  if (!matches) return err(`ファイルの中身が拡張子(${ext})と一致しません`);
  return ok(byExt.type);
};

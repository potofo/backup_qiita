/**
 * 画像フェーズの統括(image-upload-automation 4.1〜4.5, 6.1〜6.6, 8.1〜8.3, 8.5, 9.1, 10.4)
 * - ブラウザ起動 → 利用者のログイン待機 → 画像を1枚ずつ投入 → 対応表へ記録 → 後始末、を1回の run で行う
 * - 呼び出し元(UploadService)が保持するRunリースの中でだけ動く。自分ではリースを取らない(10.1)
 * - 送る画像は内容ハッシュ単位で1回だけ投入し、得たURLは得られた時点で参照元の全記事へ記録する(6.6, 8.2)
 * - どの終了経路でもブラウザを閉じる(8.5, 10.4)
 */
import type {
  ArticleImagePlan,
  CancelToken,
  ImageFailureEntry,
  ImagePlanEntry,
  ImageUploadPlan,
  Result,
} from "../types/index.js";
import { ok, err } from "../types/index.js";
import type { EditorImageUploader, EditorSession } from "../infra/browserImageUploader.js";
import type { ImageMapStore } from "../infra/imageMapStore.js";
import type { ImageUploadSettingsStore } from "../infra/imageUploadSettingsStore.js";
import { isAllowedImageUrl } from "../infra/qiitaEditorProfile.js";
import type { ProgressBus } from "./progressBus.js";
import type { Logger } from "../config/logger.js";

export type ArticleImageResult =
  | { ok: true; mapping: Map<string, string> } // ref → URL(再利用分を含む)
  | { ok: false; failedRefs: string[] };

export type ImagePhaseResult = {
  /** 記事キー → 記事の画像の状態 */
  articles: Map<string, ArticleImageResult>;
  uploaded: number;
  reused: number;
  failed: ImageFailureEntry[];
  workDraftUrl: string | null;
};

/** 画像フェーズ全体の中止。記事アップロードをどこまで続けるかは UploadService が判断する */
export type ImagePhaseError =
  | { kind: "browserUnavailable"; message: string } // 1.3
  | { kind: "loginTimeout" } // 4.4
  | { kind: "browserClosed" } // 4.4
  | { kind: "cancelledBeforeUpload" } // 4.5
  | { kind: "editorUnavailable"; missing: string; partial: ImagePhaseResult } // 8.1
  | { kind: "cancelled"; partial: ImagePhaseResult } // 6.6
  | { kind: "unexpected"; message: string; partial: ImagePhaseResult }; // 8.5

export interface ImageUploadService {
  run(plan: ImageUploadPlan, cancel: CancelToken): Promise<Result<ImagePhaseResult, ImagePhaseError>>;
}

type Deps = {
  uploader: EditorImageUploader;
  imageMapStore: ImageMapStore;
  progressBus: ProgressBus;
  settingsStore: ImageUploadSettingsStore;
  logger?: Logger;
};

type Options = {
  /** ログイン待機の上限(既定5分 — 4.4) */
  loginTimeoutMs?: number;
  /** 画像1枚の上限(既定90秒 — 6.4) */
  imageTimeoutMs?: number;
};

/** 内容ハッシュ単位の投入対象と、それを参照する記事・参照 */
type UploadUnit = {
  sha256: string;
  absPath: string;
  name: string;
  bytes: number;
  refs: { article: ArticleImagePlan; entry: ImagePlanEntry }[];
};

/** 内容ハッシュごとの投入結果 */
type UnitOutcome = { ok: true; url: string } | { ok: false; reason: string };

const baseName = (path: string): string => path.split("/").pop() ?? path;

export class ImageUploadServiceImpl implements ImageUploadService {
  private readonly loginTimeoutMs: number;
  private readonly imageTimeoutMs: number;

  constructor(
    private readonly deps: Deps,
    options: Options = {},
  ) {
    this.loginTimeoutMs = options.loginTimeoutMs ?? 5 * 60_000;
    this.imageTimeoutMs = options.imageTimeoutMs ?? 90_000;
  }

  async run(plan: ImageUploadPlan, cancel: CancelToken): Promise<Result<ImagePhaseResult, ImagePhaseError>> {
    const units = this.collectUnits(plan);
    const outcomes = new Map<string, UnitOutcome>();
    if (units.length === 0) return ok(this.buildResult(plan, outcomes, null));

    const { uploader, settingsStore, progressBus, logger } = this.deps;
    const settings = settingsStore.get();
    const opened = await uploader.open({ persistSession: settings.persistSession, workDraftUrl: settings.workDraftUrl });
    if (!opened.ok) {
      const message = opened.error.kind === "launchFailed" ? opened.error.message : opened.error.kind;
      return err({ kind: "browserUnavailable", message });
    }
    const session = opened.value;
    let workDraftUrl: string | null = null;
    try {
      // ログイン待機(4.3〜4.5)
      progressBus.emit({ type: "image-login-waiting", timeoutAt: new Date(Date.now() + this.loginTimeoutMs).toISOString() });
      const ready = await session.waitUntilReady(this.loginTimeoutMs, cancel);
      if (!ready.ok) {
        switch (ready.error.kind) {
          case "cancelled":
            return err({ kind: "cancelledBeforeUpload" });
          case "closedByUser":
            return err({ kind: "browserClosed" });
          case "editorElementMissing":
            return err({ kind: "editorUnavailable", missing: ready.error.element, partial: this.buildResult(plan, outcomes, null) });
          default:
            return err({ kind: "loginTimeout" });
        }
      }

      // 画像を1枚ずつ投入する(6.1〜6.6)
      for (let i = 0; i < units.length; i++) {
        if (cancel.cancelled) {
          workDraftUrl = session.currentDraftUrl();
          return err({ kind: "cancelled", partial: this.buildResult(plan, outcomes, workDraftUrl) });
        }
        const unit = units[i]!;
        progressBus.emit({ type: "image-progress", done: i, total: units.length, currentName: unit.name });
        const uploaded = await session.uploadImage(unit.absPath, this.imageTimeoutMs);
        if (!uploaded.ok && uploaded.error.kind === "editorElementMissing") {
          workDraftUrl = session.currentDraftUrl();
          logger?.warn("Qiitaエディタの画面要素が見つからないため画像アップロードを中止します", { element: uploaded.error.element });
          for (const rest of units.slice(i)) {
            outcomes.set(rest.sha256, { ok: false, reason: "Qiitaの画面が想定と異なるため中止しました" });
          }
          return err({
            kind: "editorUnavailable",
            missing: uploaded.error.element,
            partial: this.buildResult(plan, outcomes, workDraftUrl),
          });
        }
        if (!uploaded.ok && uploaded.error.kind === "closedByUser") return err({ kind: "browserClosed" });

        const outcome = await this.settle(unit, uploaded);
        outcomes.set(unit.sha256, outcome);
        progressBus.emit({
          type: "image-done",
          name: unit.name,
          ok: outcome.ok,
          ...(outcome.ok ? {} : { reason: outcome.reason }),
        });
        progressBus.emit({ type: "image-progress", done: i + 1, total: units.length, currentName: unit.name });
      }
      workDraftUrl = session.currentDraftUrl();
      return ok(this.buildResult(plan, outcomes, workDraftUrl));
    } catch (cause) {
      logger?.error("画像アップロード中に予期しないエラーが発生しました", { cause: String(cause).split("\n")[0] });
      return err({ kind: "unexpected", message: String(cause).split("\n")[0]!, partial: this.buildResult(plan, outcomes, workDraftUrl) });
    } finally {
      // 予期しないエラーの経路でも下書きURLを拾えるよう、閉じる前に取得する
      const draftUrl = workDraftUrl ?? safeDraftUrl(session);
      await session.close();
      this.rememberWorkDraft(draftUrl);
    }
  }

  /** 送る画像を内容ハッシュ単位にまとめる(出現順) */
  private collectUnits(plan: ImageUploadPlan): UploadUnit[] {
    const units = new Map<string, UploadUnit>();
    for (const article of plan.articles) {
      for (const entry of article.entries) {
        if (entry.status.kind !== "upload" || !entry.sha256 || !entry.absPath) continue;
        const unit = units.get(entry.sha256) ?? {
          sha256: entry.sha256,
          absPath: entry.absPath,
          name: baseName(entry.path ?? entry.ref),
          bytes: entry.bytes ?? 0,
          refs: [],
        };
        unit.refs.push({ article, entry });
        units.set(entry.sha256, unit);
      }
    }
    return [...units.values()];
  }

  /** 1枚の投入結果を検証し、成功なら参照元の全記事の対応表へ記録する(6.3, 7.4) */
  private async settle(unit: UploadUnit, uploaded: Result<string, { kind: string }>): Promise<UnitOutcome> {
    if (!uploaded.ok) {
      const reason =
        uploaded.error.kind === "timeout"
          ? "時間内に画像URLが得られませんでした"
          : "画像URLを取得できませんでした";
      return { ok: false, reason };
    }
    if (!isAllowedImageUrl(uploaded.value)) {
      this.deps.logger?.warn("許可されていないホストの画像URLを受け取ったため使用しません", { name: unit.name });
      return { ok: false, reason: "Qiitaの画像配信ホスト以外のURLが返されたため使用しません(許可ホスト外)" };
    }
    const uploadedAt = new Date().toISOString();
    const failures: string[] = [];
    const byFolder = new Map<string, string[]>();
    for (const { article, entry } of unit.refs) {
      const paths = byFolder.get(article.folderName) ?? [];
      if (entry.path && !paths.includes(entry.path)) paths.push(entry.path);
      byFolder.set(article.folderName, paths);
    }
    for (const [folderName, paths] of byFolder) {
      const recorded = await this.deps.imageMapStore.record(folderName, {
        sha256: unit.sha256,
        paths,
        url: uploaded.value,
        bytes: unit.bytes,
        uploadedAt,
      });
      if (!recorded.ok) failures.push(recorded.error.message);
    }
    this.deps.logger?.info("画像をアップロードしました", { name: unit.name, url: uploaded.value });
    // 記録に失敗してもURLは得られているため、今回の置換には使う(次回は再アップロードになる)
    if (failures.length > 0) this.deps.logger?.warn("画像の対応表を保存できませんでした", { name: unit.name });
    return { ok: true, url: uploaded.value };
  }

  /** 記事ごとの結果と件数をまとめる */
  private buildResult(plan: ImageUploadPlan, outcomes: Map<string, UnitOutcome>, workDraftUrl: string | null): ImagePhaseResult {
    const articles = new Map<string, ArticleImageResult>();
    const failed: ImageFailureEntry[] = [];
    let reused = 0;
    for (const article of plan.articles) {
      const mapping = new Map<string, string>();
      const failedRefs: string[] = [];
      for (const entry of article.entries) {
        if (entry.status.kind === "reuse") {
          mapping.set(entry.ref, entry.status.url);
          reused += 1;
        } else if (entry.status.kind === "upload" && entry.sha256) {
          const outcome = outcomes.get(entry.sha256);
          if (outcome?.ok) {
            mapping.set(entry.ref, outcome.url);
          } else {
            failedRefs.push(entry.ref);
            if (outcome) failed.push({ articleKey: article.key, articleTitle: article.title, ref: entry.ref, reason: outcome.reason });
          }
        }
      }
      articles.set(article.key, failedRefs.length > 0 ? { ok: false, failedRefs } : { ok: true, mapping });
    }
    const uploaded = [...outcomes.values()].filter((o) => o.ok).length;
    return { articles, uploaded, reused, failed, workDraftUrl };
  }

  /** 作業用下書きURLを次回のために記録する(9.1)。記録できなくても画像フェーズの結果には影響しない */
  private rememberWorkDraft(url: string | null): void {
    if (!url) return;
    const updated = this.deps.settingsStore.update({ workDraftUrl: url });
    if (!updated.ok) this.deps.logger?.warn("作業用下書きのURLを記録できませんでした", { kind: updated.error.kind });
  }
}

/** 画面操作の失敗で取れない場合も例外にせず null を返す */
const safeDraftUrl = (session: EditorSession): string | null => {
  try {
    return session.currentDraftUrl();
  } catch {
    return null;
  }
};

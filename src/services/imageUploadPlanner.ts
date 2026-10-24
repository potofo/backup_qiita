/**
 * アップロード計画の作成(image-upload-automation 2.3〜2.6, 3.1, 7.6, 7.7)
 * - 送信予定の本文からローカル画像参照を取り出し、記事フォルダ基準で解決・検証する
 * - 内容の SHA-256 で対応表を引き、記録済みなら再利用、未記録(内容変更を含む)なら送信対象とする
 * - 枚数・容量は内容ハッシュ単位で数える(同じ画像を複数の記事・参照が使っても1回分)
 * - ファイルの読み取りのみを行い、何も書き込まない
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type {
  ArticleImagePlan,
  ImagePlanEntry,
  ImageUploadPlan,
  Result,
  StorageError,
} from "../types/index.js";
import { ok } from "../types/index.js";
import type { StorageManager } from "../infra/storageManager.js";
import type { ImageMapStore } from "../infra/imageMapStore.js";
import { MAX_IMAGE_BYTES, detectImageType } from "../infra/qiitaEditorProfile.js";
import { extractLocalImageRefs } from "./imageRefRewriter.js";

/** 計画の対象記事。body は置換前の送信本文(新規=frontmatter除去後、更新=ダウンロード画像の復元後) */
export type PlanTarget = {
  key: string;
  title: string;
  folderName: string;
  body: string;
};

export interface ImageUploadPlanner {
  plan(targets: PlanTarget[]): Result<ImageUploadPlan, StorageError>;
}

type Deps = { storageManager: StorageManager; imageMapStore: ImageMapStore };
type Options = { maxImageBytes?: number };

const isInside = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** 参照からクエリ・フラグメントを除きURLデコードする(デコードできなければそのまま) */
const refToRelPath = (ref: string): string => {
  const withoutSuffix = ref.split(/[?#]/)[0]!;
  try {
    return decodeURIComponent(withoutSuffix);
  } catch {
    return withoutSuffix;
  }
};

export class ImageUploadPlannerImpl implements ImageUploadPlanner {
  private readonly maxImageBytes: number;

  constructor(
    private readonly deps: Deps,
    options: Options = {},
  ) {
    this.maxImageBytes = options.maxImageBytes ?? MAX_IMAGE_BYTES;
  }

  plan(targets: PlanTarget[]): Result<ImageUploadPlan, StorageError> {
    const articles: ArticleImagePlan[] = targets.map((t) => ({
      key: t.key,
      title: t.title,
      folderName: t.folderName,
      entries: extractLocalImageRefs(t.body).map((ref) => this.planEntry(t.folderName, ref)),
    }));

    const uploads = new Map<string, number>(); // sha256 → bytes(内容単位で1回)
    let reuseCount = 0;
    for (const entry of articles.flatMap((a) => a.entries)) {
      if (entry.status.kind === "upload" && entry.sha256) uploads.set(entry.sha256, entry.bytes ?? 0);
      if (entry.status.kind === "reuse") reuseCount += 1;
    }
    return ok({
      articles,
      uploadCount: uploads.size,
      uploadBytes: [...uploads.values()].reduce((sum, b) => sum + b, 0),
      reuseCount,
    });
  }

  private planEntry(folderName: string, ref: string): ImagePlanEntry {
    const base: ImagePlanEntry = { ref, path: null, absPath: null, bytes: null, sha256: null, status: { kind: "missing" } };
    const folderDir = resolve(this.deps.storageManager.root, folderName);
    const absPath = resolve(folderDir, refToRelPath(ref));
    if (!isInside(folderDir, absPath)) return { ...base, status: { kind: "outsideFolder" } }; // 2.4
    const path = relative(folderDir, absPath).split(sep).join("/");
    if (!existsSync(absPath) || !statSync(absPath).isFile()) return { ...base, path }; // 2.3

    // シンボリックリンク等で実体が記事フォルダの外にあるものも対象外(2.4)
    let realPath: string;
    try {
      realPath = realpathSync(absPath);
      if (!isInside(realpathSync(folderDir), realPath)) return { ...base, path, status: { kind: "outsideFolder" } };
    } catch {
      return { ...base, path };
    }

    const bytes = statSync(realPath).size;
    if (bytes > this.maxImageBytes) {
      const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);
      return {
        ...base,
        path,
        bytes,
        status: { kind: "unsupported", reason: `容量が上限(${mb(this.maxImageBytes)}MB)を超えています(${mb(bytes)}MB)` },
      };
    }
    let content: Buffer;
    try {
      content = readFileSync(realPath);
    } catch {
      return { ...base, path };
    }
    const type = detectImageType(absPath, content.subarray(0, 16));
    if (!type.ok) return { ...base, path, bytes, status: { kind: "unsupported", reason: type.error } }; // 2.5

    const sha256 = createHash("sha256").update(content).digest("hex");
    const known = this.deps.imageMapStore.findByHash(sha256); // 2.6, 7.7(内容が変われば未記録 — 7.6)
    return {
      ref,
      path,
      absPath: realPath,
      bytes,
      sha256,
      status: known ? { kind: "reuse", url: known.url } : { kind: "upload" },
    };
  }
}

/**
 * 画像アップロード機能の設定(image-upload-automation 1.1, 1.4, 5.1〜5.3, 9.1)
 * - 保存先は `.image-upload/settings.json`(プロジェクトルート直下・Git管理外・backups/ の外 — 5.2)
 * - 既定は無効。同意(consentedAt)が記録されていなければ有効化できない(1.1, 1.4)
 * - 同意時のみ使うブラウザプロファイル `.image-upload/browser-profile/` の削除を提供する(5.3)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type {
  ImageUploadSettings,
  ImageUploadSettingsError,
  ImageUploadSettingsPatch,
  Result,
} from "../types/index.js";
import { ok, err } from "../types/index.js";
import { removeDirRecursive } from "./removeDir.js";
import type { Logger } from "../config/logger.js";

export interface ImageUploadSettingsStore {
  get(): ImageUploadSettings;
  update(patch: ImageUploadSettingsPatch): Result<ImageUploadSettings, ImageUploadSettingsError>;
  /** browser-profile/ を削除し persistSession を false にする(5.3) */
  clearSession(): Result<void, ImageUploadSettingsError>;
  hasSavedSession(): boolean;
  /** セッションを保存する場合のブラウザプロファイルの場所 */
  profileDir(): string;
}

type Options = { now?: () => Date; logger?: Logger };

const DEFAULTS: ImageUploadSettings = {
  schemaVersion: 1,
  enabled: false,
  consentedAt: null,
  persistSession: false,
  workDraftUrl: null,
};

/** 作業用下書きとして記録してよいURL(Qiitaの下書き編集画面のみ) */
const isWorkDraftUrl = (url: string): boolean => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.host === "qiita.com" && /^\/drafts\/[A-Za-z0-9]+\/edit$/.test(parsed.pathname);
  } catch {
    return false;
  }
};

export class ImageUploadSettingsStoreImpl implements ImageUploadSettingsStore {
  private readonly now: () => Date;

  constructor(
    private readonly dir: string,
    private readonly options: Options = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  private get settingsPath(): string {
    return join(this.dir, "settings.json");
  }

  profileDir(): string {
    return join(this.dir, "browser-profile");
  }

  get(): ImageUploadSettings {
    if (!existsSync(this.settingsPath)) return { ...DEFAULTS };
    try {
      const parsed = JSON.parse(readFileSync(this.settingsPath, "utf8")) as Partial<ImageUploadSettings>;
      const settings = { ...DEFAULTS, ...parsed, schemaVersion: 1 as const };
      // 同意のない有効化は読み込み時にも認めない(手編集への備え — 1.4)
      if (settings.enabled && !settings.consentedAt) settings.enabled = false;
      return settings;
    } catch {
      this.options.logger?.warn("画像アップロードの設定ファイルを読めないため既定値を使います");
      return { ...DEFAULTS };
    }
  }

  update(patch: ImageUploadSettingsPatch): Result<ImageUploadSettings, ImageUploadSettingsError> {
    const current = this.get();
    const next: ImageUploadSettings = { ...current };
    if (patch.consent === true && !next.consentedAt) next.consentedAt = this.now().toISOString();
    if (patch.enabled !== undefined) {
      if (patch.enabled && !next.consentedAt) return err({ kind: "consentRequired" });
      next.enabled = patch.enabled;
    }
    if (patch.persistSession !== undefined) next.persistSession = patch.persistSession;
    if (patch.workDraftUrl !== undefined) {
      if (patch.workDraftUrl !== null && !isWorkDraftUrl(patch.workDraftUrl)) {
        return err({ kind: "invalidWorkDraftUrl" });
      }
      next.workDraftUrl = patch.workDraftUrl;
    }
    const written = this.write(next);
    return written.ok ? ok(next) : written;
  }

  clearSession(): Result<void, ImageUploadSettingsError> {
    const failed = removeDirRecursive(this.profileDir());
    if (failed.length > 0) {
      return err({ kind: "io", message: `保存済みセッションの一部を削除できませんでした(${failed.length}件)` });
    }
    const updated = this.update({ persistSession: false });
    return updated.ok ? ok(undefined) : updated;
  }

  hasSavedSession(): boolean {
    const profile = this.profileDir();
    return existsSync(profile) && readdirSync(profile).length > 0;
  }

  /** 一時ファイル経由で書き込む */
  private write(settings: ImageUploadSettings): Result<void, ImageUploadSettingsError> {
    const tmpPath = `${this.settingsPath}.tmp-${randomBytes(4).toString("hex")}`;
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(tmpPath, JSON.stringify(settings, null, 2), "utf8");
      renameSync(tmpPath, this.settingsPath);
      return ok(undefined);
    } catch (cause) {
      return err({ kind: "io", message: `画像アップロードの設定を保存できませんでした: ${String(cause)}` });
    }
  }
}

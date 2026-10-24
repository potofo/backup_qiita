/**
 * テスト用の偽エディタ操作部品(image-upload-automation タスク1.3)
 * - ログイン待機・画像投入・URL返却・各種失敗を筋書きで切り替える
 * - 呼び出し記録(開いた回数・投入したファイル・閉じた回数)を残す
 */
import { basename } from "node:path";
import type { CancelToken, Result } from "../../src/types/index.js";
import { ok, err } from "../../src/types/index.js";
import type {
  EditorImageUploader,
  EditorSession,
  OpenOptions,
  UploaderAvailability,
  UploaderError,
} from "../../src/infra/browserImageUploader.js";

export type FakeUploaderScenario = {
  availability?: UploaderAvailability;
  openError?: UploaderError;
  readyError?: UploaderError;
  /** n番目(0始まり)の投入に対する結果。未指定なら許可ホストのURLを返す */
  uploadResult?: (absPath: string, index: number) => Result<string, UploaderError>;
  /** 投入の直前に呼ばれる(中断の指示などをテストから差し込む) */
  beforeUpload?: (absPath: string, index: number) => void;
  /** 作業用下書きのURL(既定: 最初の投入後に確定) */
  draftUrl?: string | null;
};

export type FakeUploaderCalls = {
  opened: OpenOptions[];
  readyWaits: number;
  uploaded: string[];
  closed: number;
};

export const fakeImageUrl = (index: number): string =>
  `https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/1/fake-${index}.png`;

export function createFakeUploader(scenario: FakeUploaderScenario = {}): {
  uploader: EditorImageUploader;
  calls: FakeUploaderCalls;
} {
  const calls: FakeUploaderCalls = { opened: [], readyWaits: 0, uploaded: [], closed: 0 };

  const uploader: EditorImageUploader = {
    async availability() {
      return scenario.availability ?? { available: true };
    },
    async open(options) {
      calls.opened.push(options);
      if (scenario.openError) return err(scenario.openError);
      let uploadCount = 0;
      const session: EditorSession = {
        async waitUntilReady(_timeoutMs: number, cancel: CancelToken) {
          calls.readyWaits += 1;
          if (cancel.cancelled) return err({ kind: "cancelled" });
          if (scenario.readyError) return err(scenario.readyError);
          return ok(undefined);
        },
        async uploadImage(absPath: string) {
          const index = calls.uploaded.length;
          scenario.beforeUpload?.(absPath, index);
          calls.uploaded.push(absPath);
          uploadCount += 1;
          const result = scenario.uploadResult?.(absPath, index) ?? ok(fakeImageUrl(index));
          return result;
        },
        currentDraftUrl() {
          if (scenario.draftUrl !== undefined) return scenario.draftUrl;
          return uploadCount > 0 ? "https://qiita.com/drafts/fakedraft01/edit" : null;
        },
        async close() {
          calls.closed += 1;
        },
      };
      return ok(session);
    },
  };
  return { uploader, calls };
}

/** 投入したファイル名の一覧(検証用) */
export const uploadedNames = (calls: FakeUploaderCalls): string[] => calls.uploaded.map((p) => basename(p));

/**
 * Git世代管理マネージャ(2.4)
 * - backups/ をツール本体と独立したGitリポジトリとして管理する(6.1)
 * - リモート関連操作(remote/push/pull)は一切実装しない(6.2, steering security.md)
 * - Git利用不可時は available=false を公開し、以後の操作を無害化する(6.6)
 * - コミットは常に backup ブランチで行う(6.7 / F-GIT-08)
 * - backup ブランチはローカル専用。pre-pushフックで手動pushも拒否する(6.8 / F-GIT-09)
 */
import { simpleGit, CheckRepoActions, type SimpleGit } from "simple-git";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CommitInfo, GitError, Result, RunSummary } from "../types/index.js";
import { ok, err } from "../types/index.js";
import type { Logger } from "../config/logger.js";

export interface GitManager {
  readonly available: boolean;
  ensureRepo(): Promise<Result<void, GitError>>; // 6.1
  /** Run単位コミット。戻り値null=変更なしでコミットせず(6.4) */
  commitRun(summary: RunSummary): Promise<Result<CommitInfo | null, GitError>>;
}

type GitManagerOptions = {
  /** テスト用: gitバイナリの場所を差し替えて「Git不在」を再現する */
  gitBinary?: string;
};

/** バックアップコミットの固定ブランチ名(6.7 / F-GIT-08) */
const BACKUP_BRANCH = "backup";

/** 本ツールが設置したフックであることを示すマーカー(ユーザ独自フックとの識別用) */
const HOOK_MARKER = "qiita-backup-tool";

/**
 * backupブランチのpushを拒否するpre-pushフック(6.8 / F-GIT-09)
 * 限定共有記事の誤公開を、手動push操作に対しても構造的に防ぐ。
 */
const PRE_PUSH_HOOK = `#!/bin/sh
# ${HOOK_MARKER}: the "${BACKUP_BRANCH}" branch is local-only (F-GIT-09).
# This hook was installed automatically by ${HOOK_MARKER}.
# (backup ブランチはローカル運用専用のため push を拒否します — 限定共有記事の誤公開防止)
while read local_ref local_sha remote_ref remote_sha; do
  case "$local_ref" in
    refs/heads/${BACKUP_BRANCH})
      echo "[${HOOK_MARKER}] push rejected: the '${BACKUP_BRANCH}' branch is local-only (F-GIT-09)." >&2
      exit 1
      ;;
  esac
done
exit 0
`;

const buildCommitMessage = (summary: RunSummary): string => {
  const status = summary.cancelled ? "中断" : "完了";
  // Run方向を含める(article-upload-sync 7.5)。省略時はbackup(既存履歴と後方互換)
  const kind = summary.direction === "upload" ? "アップロード" : "バックアップ";
  return [
    `${kind}${status}: ${summary.startedAt} (${summary.mode})`,
    "",
    `対象: ${summary.total}件 / 成功: ${summary.succeeded}件 / 失敗: ${summary.failed}件`,
  ].join("\n");
};

class GitManagerImpl implements GitManager {
  constructor(
    readonly available: boolean,
    private readonly repoDir: string,
    private readonly git: SimpleGit | null,
    private readonly logger?: Logger,
  ) {}

  async ensureRepo(): Promise<Result<void, GitError>> {
    if (!this.available || !this.git) return ok(undefined); // 無害化(6.6)
    try {
      await mkdir(this.repoDir, { recursive: true });
      // 「リポジトリ配下か」ではなく「バックアップ先自身がリポジトリのルートか」で判定する。
      // ツール本体リポジトリ等の配下にBACKUP_DIRがある場合に親リポジトリを誤操作しないため(F-GIT-01)
      const isRepoRoot = await this.git.checkIsRepo(CheckRepoActions.IS_REPO_ROOT);
      if (!isRepoRoot) {
        await this.git.init();
        // コミットに必要なユーザ識別をリポジトリローカルに設定(グローバル設定へ影響させない)
        await this.git.addConfig("user.name", "qiita-backup-tool", false, "local");
        await this.git.addConfig("user.email", "qiita-backup-tool@localhost", false, "local");
        this.logger?.info("バックアップ用Gitリポジトリを初期化しました", { dir: this.repoDir });
      }

      // 安全網: 以降の全Git操作の対象がバックアップ先自身であることを検証する。
      // 万一外側のリポジトリを指している場合は、親リポジトリを壊す前に中断する
      const toplevel = resolve((await this.git.revparse(["--show-toplevel"])).trim());
      if (toplevel.toLowerCase() !== resolve(this.repoDir).toLowerCase()) {
        const message = `Git操作の対象(${toplevel})がバックアップ先(${this.repoDir})と一致しないため中断しました`;
        this.logger?.error(message);
        return err({ kind: "gitFailed", message });
      }

      await this.ensureBackupBranch();
      await this.ensurePrePushHook();
      return ok(undefined);
    } catch (cause) {
      this.logger?.error("Gitリポジトリの初期化に失敗しました", { cause: String(cause) });
      return err({ kind: "gitFailed", message: String(cause) });
    }
  }

  /** backupブランチのpushを拒否するpre-pushフックを設置する(6.8 / F-GIT-09) */
  private async ensurePrePushHook(): Promise<void> {
    const hookPath = join(this.repoDir, ".git", "hooks", "pre-push");
    if (existsSync(hookPath)) {
      const current = await readFile(hookPath, "utf8");
      if (!current.includes(HOOK_MARKER)) {
        // ユーザ独自のフックは尊重して上書きしない
        this.logger?.warn(
          "独自のpre-pushフックが存在するため、backupブランチのpush拒否フックを設置しませんでした",
          { hookPath },
        );
        return;
      }
      if (current === PRE_PUSH_HOOK) return; // 設置済み・最新
    }
    await mkdir(join(this.repoDir, ".git", "hooks"), { recursive: true });
    await writeFile(hookPath, PRE_PUSH_HOOK, { encoding: "utf8", mode: 0o755 });
    this.logger?.info("backupブランチのpushを拒否するpre-pushフックを設置しました");
  }

  /** コミット先を backup ブランチに揃える(6.7 / F-GIT-08) */
  private async ensureBackupBranch(): Promise<void> {
    if (!this.git) return;
    // 未コミット(unborn HEAD)でもブランチ名を返せる symbolic-ref を使う
    const current = (await this.git.raw(["symbolic-ref", "--short", "HEAD"])).trim();
    if (current === BACKUP_BRANCH) return;

    const branches = await this.git.branchLocal();
    if (branches.all.includes(BACKUP_BRANCH)) {
      // backupブランチが既にあるなら切り替えるだけ
      await this.git.checkout(BACKUP_BRANCH);
    } else if (branches.all.length === 0) {
      // コミットが1つもない初期状態: 初期ブランチ名をbackupにする
      await this.git.raw(["symbolic-ref", "HEAD", `refs/heads/${BACKUP_BRANCH}`]);
    } else {
      // 既存の履歴を引き継いで現在のブランチをbackupへリネームする
      await this.git.raw(["branch", "-m", current, BACKUP_BRANCH]);
    }
    this.logger?.info("コミット先をbackupブランチに設定しました", { from: current });
  }

  async commitRun(summary: RunSummary): Promise<Result<CommitInfo | null, GitError>> {
    if (!this.available || !this.git) return ok(null); // 無害化(6.6)
    try {
      const ensured = await this.ensureRepo();
      if (!ensured.ok) return ensured;

      // 全変更(削除・リネーム含む)をステージ。リネーム検出はGitに委ねる(6.5)
      await this.git.raw(["add", "-A"]);
      const status = await this.git.status();
      if (status.staged.length === 0 && status.files.length === 0) {
        return ok(null); // 変更ゼロならコミットしない(6.4)
      }

      const message = buildCommitMessage(summary);
      const commitResult = await this.git.commit(message);
      const info: CommitInfo = {
        hash: commitResult.commit,
        message,
        committedAt: new Date().toISOString(),
      };
      this.logger?.info("バックアップをコミットしました", { hash: info.hash });
      return ok(info);
    } catch (cause) {
      this.logger?.error("Gitコミットに失敗しました", { cause: String(cause) });
      return err({ kind: "gitFailed", message: String(cause) });
    }
  }
}

/** 起動時にGitの可用性を判定して生成する(6.6) */
export async function createGitManager(
  repoDir: string,
  logger?: Logger,
  options: GitManagerOptions = {},
): Promise<GitManager> {
  try {
    await mkdir(repoDir, { recursive: true });
    const git = options.gitBinary
      ? simpleGit({ baseDir: repoDir, binary: options.gitBinary })
      : simpleGit({ baseDir: repoDir });
    const version = await git.version();
    if (!version.installed) throw new Error("git is not installed");
    return new GitManagerImpl(true, repoDir, git, logger);
  } catch {
    logger?.warn("Gitが利用できません。世代管理なしで継続します(6.6)");
    return new GitManagerImpl(false, repoDir, null, logger);
  }
}

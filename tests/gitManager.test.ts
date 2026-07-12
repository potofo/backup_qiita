import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { createGitManager } from "../src/infra/gitManager.js";
import type { RunSummary } from "../src/types/index.js";

const makeSummary = (overrides: Partial<RunSummary> = {}): RunSummary => ({
  runId: "run-1",
  mode: "diff",
  startedAt: "2026-07-12T10:00:00+09:00",
  finishedAt: "2026-07-12T10:05:00+09:00",
  total: 3,
  succeeded: 2,
  failed: 1,
  imageFailures: [],
  cancelled: false,
  commit: null,
  ...overrides,
});

describe("GitManager(2.4)", () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = join(mkdtempSync(join(tmpdir(), "qbt-git-")), "backup");
    mkdirSync(repoDir, { recursive: true });
  });

  it("Git利用可能な環境でavailable=trueとなる(6.6)", async () => {
    const git = await createGitManager(repoDir);
    expect(git.available).toBe(true);
  });

  it("ensureRepoで独立したGitリポジトリを自動初期化する(6.1)", async () => {
    const manager = await createGitManager(repoDir);
    const result = await manager.ensureRepo();
    expect(result.ok).toBe(true);
    expect(existsSync(join(repoDir, ".git"))).toBe(true);
  });

  it("Run単位で全変更をコミットし、実行日時・件数入りメッセージを付ける(6.3)", async () => {
    const manager = await createGitManager(repoDir);
    await manager.ensureRepo();
    mkdirSync(join(repoDir, "記事A_id1"), { recursive: true });
    writeFileSync(join(repoDir, "記事A_id1", "記事A.md"), "# A", "utf8");
    writeFileSync(join(repoDir, "index.json"), "{}", "utf8");

    const result = await manager.commitRun(makeSummary());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toBeNull();
    expect(result.value!.hash).toMatch(/^[0-9a-f]{7,40}$/);
    expect(result.value!.message).toContain("2026-07-12T10:00:00+09:00");
    expect(result.value!.message).toContain("対象: 3件");
    expect(result.value!.message).toContain("成功: 2件");
    expect(result.value!.message).toContain("失敗: 1件");

    const log = await simpleGit(repoDir).log();
    expect(log.total).toBe(1);
  });

  it("変更ゼロならコミットしない(6.4)", async () => {
    const manager = await createGitManager(repoDir);
    await manager.ensureRepo();
    writeFileSync(join(repoDir, "index.json"), "{}", "utf8");
    await manager.commitRun(makeSummary());

    const second = await manager.commitRun(makeSummary());
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value).toBeNull();
    const log = await simpleGit(repoDir).log();
    expect(log.total).toBe(1);
  });

  it("フォルダリネームを履歴追跡可能な形でコミットする(6.5)", async () => {
    const manager = await createGitManager(repoDir);
    await manager.ensureRepo();
    mkdirSync(join(repoDir, "旧タイトル_id1"), { recursive: true });
    writeFileSync(join(repoDir, "旧タイトル_id1", "original.md"), "# 本文(同一内容)", "utf8");
    await manager.commitRun(makeSummary());

    renameSync(join(repoDir, "旧タイトル_id1"), join(repoDir, "新タイトル_id1"));
    const result = await manager.commitRun(makeSummary({ runId: "run-2" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toBeNull();

    // リネーム検出(-M)でRステータスとして追跡できる
    const diff = await simpleGit(repoDir).raw(["diff", "--name-status", "-M", "HEAD~1", "HEAD"]);
    expect(diff).toMatch(/^R\d*\t/m);
  });

  it("コミットは常にbackupブランチで実行される(6.7 / F-GIT-08)", async () => {
    const manager = await createGitManager(repoDir);
    await manager.ensureRepo();
    writeFileSync(join(repoDir, "index.json"), "{}", "utf8");
    const result = await manager.commitRun(makeSummary());
    expect(result.ok).toBe(true);

    const branch = (await simpleGit(repoDir).raw(["symbolic-ref", "--short", "HEAD"])).trim();
    expect(branch).toBe("backup");
  });

  it("別ブランチの既存リポジトリでは履歴を引き継いでbackupブランチへ切り替える(6.7)", async () => {
    // masterブランチで初期化済みの既存リポジトリを用意する
    const git = simpleGit(repoDir);
    await git.init(["--initial-branch=master"]);
    await git.addConfig("user.name", "test", false, "local");
    await git.addConfig("user.email", "test@localhost", false, "local");
    writeFileSync(join(repoDir, "old.txt"), "既存の履歴", "utf8");
    await git.add(["-A"]);
    await git.commit("既存コミット");

    const manager = await createGitManager(repoDir);
    await manager.ensureRepo();
    writeFileSync(join(repoDir, "index.json"), "{}", "utf8");
    const result = await manager.commitRun(makeSummary());
    expect(result.ok).toBe(true);

    const branch = (await git.raw(["symbolic-ref", "--short", "HEAD"])).trim();
    expect(branch).toBe("backup");
    // 既存コミットの履歴がbackupブランチに引き継がれている
    const log = await git.log();
    expect(log.total).toBe(2);
    expect(log.all.some((c) => c.message.includes("既存コミット"))).toBe(true);
  });

  it("pre-pushフックを自動設置し、backupブランチのpushを拒否する(6.8 / F-GIT-09)", async () => {
    const manager = await createGitManager(repoDir);
    await manager.ensureRepo();

    // フックが設置されている
    const hookPath = join(repoDir, ".git", "hooks", "pre-push");
    expect(existsSync(hookPath)).toBe(true);

    // コミットを作り、ローカルのbareリポジトリへpushを試みる → 拒否される
    writeFileSync(join(repoDir, "index.json"), "{}", "utf8");
    await manager.commitRun(makeSummary());
    const bareDir = join(mkdtempSync(join(tmpdir(), "qbt-bare-")), "remote.git");
    mkdirSync(bareDir, { recursive: true });
    await simpleGit(bareDir).init(true);
    const git = simpleGit(repoDir);
    await git.addRemote("origin", bareDir);

    await expect(git.push("origin", "backup")).rejects.toThrow();
    // リモート側にbackupブランチが作られていない
    const remoteRefs = await simpleGit(bareDir).raw(["branch", "-a"]);
    expect(remoteRefs).not.toContain("backup");
  });

  it("ユーザ独自のpre-pushフックが既にある場合は上書きしない(6.8)", async () => {
    const hooksDir = join(repoDir, ".git", "hooks");
    // 先にリポジトリを作ってユーザ独自フックを置く
    await simpleGit(repoDir).init();
    writeFileSync(join(hooksDir, "pre-push"), "#!/bin/sh\n# user custom hook\nexit 0\n", "utf8");

    const manager = await createGitManager(repoDir);
    await manager.ensureRepo();

    const content = readFileSync(join(hooksDir, "pre-push"), "utf8");
    expect(content).toContain("user custom hook");
    expect(content).not.toContain("qiita-backup-tool");
  });

  it("親Gitリポジトリ配下のバックアップ先でも、親を操作せず独立リポジトリを初期化する(6.1 / F-GIT-01)", async () => {
    // ツール本体リポジトリに相当する「親リポジトリ」を用意する
    const parentDir = mkdtempSync(join(tmpdir(), "qbt-parent-"));
    const parent = simpleGit(parentDir);
    await parent.init(["--initial-branch=main"]);
    await parent.addConfig("user.name", "test", false, "local");
    await parent.addConfig("user.email", "test@localhost", false, "local");
    writeFileSync(join(parentDir, "app.ts"), "// tool source", "utf8");
    await parent.add(["-A"]);
    await parent.commit("parent commit");

    // 親リポジトリ配下にバックアップ先を作る(BACKUP_DIR=./backups 相当)
    const nested = join(parentDir, "backups");
    mkdirSync(nested, { recursive: true });
    const manager = await createGitManager(nested);
    const ensured = await manager.ensureRepo();
    expect(ensured.ok).toBe(true);

    writeFileSync(join(nested, "index.json"), "{}", "utf8");
    const result = await manager.commitRun(makeSummary());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).not.toBeNull();

    // バックアップ先自身が独立したリポジトリとして初期化されている
    expect(existsSync(join(nested, ".git", "HEAD"))).toBe(true);
    const childBranch = (await simpleGit(nested).raw(["symbolic-ref", "--short", "HEAD"])).trim();
    expect(childBranch).toBe("backup");
    expect((await simpleGit(nested).log()).total).toBe(1);

    // 親リポジトリは一切変更されない(ブランチ名・コミット数・作業ツリー)
    const parentBranch = (await parent.raw(["symbolic-ref", "--short", "HEAD"])).trim();
    expect(parentBranch).toBe("main");
    expect((await parent.log()).total).toBe(1);
    expect(existsSync(join(parentDir, ".git", "hooks", "pre-push"))).toBe(false);
  });

  it("Git利用不可の環境では警告状態を公開し、以後の操作を無害化する(6.6)", async () => {
    const manager = await createGitManager(repoDir, undefined, {
      gitBinary: "C:\\nonexistent\\git-not-installed.exe",
    });
    expect(manager.available).toBe(false);

    const ensure = await manager.ensureRepo();
    expect(ensure.ok).toBe(true); // no-op成功
    expect(existsSync(join(repoDir, ".git"))).toBe(false);

    const commit = await manager.commitRun(makeSummary());
    expect(commit.ok).toBe(true);
    if (commit.ok) expect(commit.value).toBeNull();
  });
});

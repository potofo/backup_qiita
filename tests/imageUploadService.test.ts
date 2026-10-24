import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { StorageManagerImpl } from "../src/infra/storageManager.js";
import { ImageMapStoreImpl } from "../src/infra/imageMapStore.js";
import { ImageUploadSettingsStoreImpl } from "../src/infra/imageUploadSettingsStore.js";
import { ImageUploadPlannerImpl, type PlanTarget } from "../src/services/imageUploadPlanner.js";
import { ImageUploadServiceImpl } from "../src/services/imageUploadService.js";
import { createProgressBus, type ProgressEvent } from "../src/services/progressBus.js";
import type { ImageUploadPlan } from "../src/types/index.js";
import { createFakeUploader, fakeImageUrl, uploadedNames, type FakeUploaderScenario } from "./helpers/fakeEditorImageUploader.js";

const PNG = (seed: string): Buffer =>
  Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(seed)]);

const setup = (scenario: FakeUploaderScenario = {}) => {
  const base = mkdtempSync(join(tmpdir(), "qbt-ius-"));
  const root = join(base, "backup");
  mkdirSync(root, { recursive: true });
  const storage = new StorageManagerImpl(root);
  const mapStore = new ImageMapStoreImpl(storage);
  const settings = new ImageUploadSettingsStoreImpl(join(base, ".image-upload"));
  const bus = createProgressBus();
  const events: ProgressEvent[] = [];
  bus.subscribe((e) => events.push(e));
  const fake = createFakeUploader(scenario);
  const service = new ImageUploadServiceImpl(
    { uploader: fake.uploader, imageMapStore: mapStore, progressBus: bus, settingsStore: settings },
    { loginTimeoutMs: 5_000, imageTimeoutMs: 1_000 },
  );
  const planner = new ImageUploadPlannerImpl({ storageManager: storage, imageMapStore: mapStore });
  const file = (folder: string, rel: string, content: Buffer): void => {
    const path = join(root, folder, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  };
  const plan = (targets: PlanTarget[]): ImageUploadPlan => {
    const result = planner.plan(targets);
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  return { root, mapStore, settings, events, fake, service, file, plan };
};

const NOT_CANCELLED = { cancelled: false };

describe("ImageUploadService — セッションの開始から終了まで(image-upload-automation 4.x, 8.5, 9.1, 10.4)", () => {
  it("設定のセッション保存・作業用下書きURLを渡してブラウザを開き、ログイン待機を通知する(4.1, 4.3, 9.1)", async () => {
    const s = setup();
    s.settings.update({ persistSession: true, workDraftUrl: "https://qiita.com/drafts/prev01/edit" });
    s.file("d", "a.png", PNG("a"));
    const result = await s.service.run(s.plan([{ key: "local:d", title: "D", folderName: "d", body: "![a](a.png)" }]), NOT_CANCELLED);

    expect(result.ok).toBe(true);
    expect(s.fake.calls.opened).toEqual([{ persistSession: true, workDraftUrl: "https://qiita.com/drafts/prev01/edit" }]);
    const waiting = s.events.find((e) => e.type === "image-login-waiting");
    expect(waiting).toBeDefined();
    expect(s.fake.calls.closed).toBe(1);
  });

  it("送る画像がなければブラウザを開かない", async () => {
    const s = setup();
    const result = await s.service.run(s.plan([{ key: "a1", title: "A", folderName: "x_a1", body: "本文のみ" }]), NOT_CANCELLED);
    expect(result.ok).toBe(true);
    expect(s.fake.calls.opened).toHaveLength(0);
  });

  it.each([
    [{ openError: { kind: "launchFailed", message: "no browser" } }, "browserUnavailable"],
    [{ readyError: { kind: "timeout" } }, "loginTimeout"],
    [{ readyError: { kind: "closedByUser" } }, "browserClosed"],
    [{ readyError: { kind: "editorElementMissing", element: 'input[type="file"]' } }, "editorUnavailable"],
  ] as [FakeUploaderScenario, string][])("ログイン待機までの失敗 %j は %s を返し、ブラウザを閉じる(4.4, 8.1)", async (scenario, kind) => {
    const s = setup(scenario);
    s.file("d", "a.png", PNG("a"));
    const result = await s.service.run(s.plan([{ key: "local:d", title: "D", folderName: "d", body: "![a](a.png)" }]), NOT_CANCELLED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe(kind);
    expect(s.fake.calls.uploaded).toHaveLength(0);
    if (!scenario.openError) expect(s.fake.calls.closed).toBe(1);
  });

  it("ログイン待機中に中断されたら cancelledBeforeUpload を返す(4.5)", async () => {
    const s = setup();
    s.file("d", "a.png", PNG("a"));
    const result = await s.service.run(s.plan([{ key: "local:d", title: "D", folderName: "d", body: "![a](a.png)" }]), { cancelled: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("cancelledBeforeUpload");
    expect(s.fake.calls.closed).toBe(1);
  });

  it("投入中に予期しない例外が起きても unexpected を返してブラウザを閉じる(8.5)", async () => {
    const s = setup({
      beforeUpload: () => {
        throw new Error("boom");
      },
    });
    s.file("d", "a.png", PNG("a"));
    const result = await s.service.run(s.plan([{ key: "local:d", title: "D", folderName: "d", body: "![a](a.png)" }]), NOT_CANCELLED);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unexpected");
    expect(s.fake.calls.closed).toBe(1);
  });

  it("終了時に作業用下書きURLを設定へ記録する(9.1)", async () => {
    const s = setup({ draftUrl: "https://qiita.com/drafts/newdraft9/edit" });
    s.file("d", "a.png", PNG("a"));
    const result = await s.service.run(s.plan([{ key: "local:d", title: "D", folderName: "d", body: "![a](a.png)" }]), NOT_CANCELLED);
    expect(result.ok && result.value.workDraftUrl).toBe("https://qiita.com/drafts/newdraft9/edit");
    expect(s.settings.get().workDraftUrl).toBe("https://qiita.com/drafts/newdraft9/edit");
  });
});

describe("ImageUploadService — 画像の投入・記録・進捗(image-upload-automation 6.x, 8.1〜8.3)", () => {
  it("同じ内容の画像は1回だけ投入し、参照しているすべての記事の対応表に記録する", async () => {
    const s = setup();
    s.file("d1", "a.png", PNG("dup"));
    s.file("d1", "b.png", PNG("b"));
    s.file("d2", "copy.png", PNG("dup"));
    const result = await s.service.run(
      s.plan([
        { key: "local:d1", title: "1", folderName: "d1", body: "![a](a.png)\n![b](b.png)" },
        { key: "local:d2", title: "2", folderName: "d2", body: "![c](copy.png)" },
      ]),
      NOT_CANCELLED,
    );
    if (!result.ok) return expect.fail(JSON.stringify(result.error));
    expect(uploadedNames(s.fake.calls)).toEqual(["a.png", "b.png"]);
    expect(result.value.uploaded).toBe(2);
    const d1 = result.value.articles.get("local:d1");
    const d2 = result.value.articles.get("local:d2");
    expect(d1).toEqual({ ok: true, mapping: new Map([["a.png", fakeImageUrl(0)], ["b.png", fakeImageUrl(1)]]) });
    expect(d2).toEqual({ ok: true, mapping: new Map([["copy.png", fakeImageUrl(0)]]) });
    const d2map = s.mapStore.read("d2");
    expect(d2map.ok && d2map.value.map((e) => [e.paths, e.url])).toEqual([[["copy.png"], fakeImageUrl(0)]]);
  });

  it("記録済みの画像は投入せずに再利用し、置換用の対応に含める", async () => {
    const s = setup();
    s.file("d", "a.png", PNG("a"));
    s.file("d", "b.png", PNG("b"));
    const first = await s.service.run(s.plan([{ key: "local:d", title: "D", folderName: "d", body: "![a](a.png)" }]), NOT_CANCELLED);
    expect(first.ok).toBe(true);

    const second = await s.service.run(
      s.plan([{ key: "local:d", title: "D", folderName: "d", body: "![a](a.png)\n![b](b.png)" }]),
      NOT_CANCELLED,
    );
    if (!second.ok) return expect.fail(JSON.stringify(second.error));
    expect(uploadedNames(s.fake.calls)).toEqual(["a.png", "b.png"]); // 2回目は b.png だけ
    expect(second.value.reused).toBe(1);
    expect(second.value.articles.get("local:d")).toEqual({
      ok: true,
      mapping: new Map([["a.png", fakeImageUrl(0)], ["b.png", fakeImageUrl(1)]]),
    });
  });

  it("許可ホスト以外のURL・時間切れの画像は失敗として記録し、対応表に書かない(6.3, 6.4, 8.2)", async () => {
    const s = setup({
      uploadResult: (path, i) =>
        basename(path) === "evil.png"
          ? { ok: true, value: "https://evil.example.com/x.png" }
          : basename(path) === "slow.png"
            ? { ok: false, error: { kind: "timeout" } }
            : { ok: true, value: fakeImageUrl(i) },
    });
    s.file("d1", "evil.png", PNG("e"));
    s.file("d1", "slow.png", PNG("s"));
    s.file("d2", "ok.png", PNG("o"));
    const result = await s.service.run(
      s.plan([
        { key: "local:d1", title: "1", folderName: "d1", body: "![e](evil.png)\n![s](slow.png)" },
        { key: "local:d2", title: "2", folderName: "d2", body: "![o](ok.png)" },
      ]),
      NOT_CANCELLED,
    );
    if (!result.ok) return expect.fail(JSON.stringify(result.error));
    expect(result.value.articles.get("local:d1")).toEqual({ ok: false, failedRefs: ["evil.png", "slow.png"] });
    expect(result.value.articles.get("local:d2")?.ok).toBe(true);
    expect(result.value.failed.map((f) => [f.ref, f.articleKey])).toEqual([
      ["evil.png", "local:d1"],
      ["slow.png", "local:d1"],
    ]);
    expect(result.value.failed[0]!.reason).toContain("許可");
    const d1map = s.mapStore.read("d1");
    expect(d1map.ok && d1map.value).toEqual([]);
    const done = s.events.filter((e) => e.type === "image-done");
    expect(done.map((e) => e.type === "image-done" && e.ok)).toEqual([false, false, true]);
  });

  it("1枚ごとに進捗を通知する(6.5)", async () => {
    const s = setup();
    s.file("d", "a.png", PNG("a"));
    s.file("d", "b.png", PNG("b"));
    await s.service.run(s.plan([{ key: "local:d", title: "D", folderName: "d", body: "![a](a.png)\n![b](b.png)" }]), NOT_CANCELLED);
    const progress = s.events.filter((e) => e.type === "image-progress");
    expect(progress.map((e) => e.type === "image-progress" && [e.done, e.total, e.currentName])).toEqual([
      [0, 2, "a.png"],
      [1, 2, "a.png"],
      [1, 2, "b.png"],
      [2, 2, "b.png"],
    ]);
  });

  it("中断は1枚の区切りで確かめ、取得済みのURLは対応表に残す(6.6)", async () => {
    const cancel = { cancelled: false };
    const s = setup({
      beforeUpload: (_p, i) => {
        if (i === 0) cancel.cancelled = true; // 1枚目の処理中に中断が指示された
      },
    });
    s.file("d", "a.png", PNG("a"));
    s.file("d", "b.png", PNG("b"));
    const result = await s.service.run(s.plan([{ key: "local:d", title: "D", folderName: "d", body: "![a](a.png)\n![b](b.png)" }]), cancel);
    expect(result.ok).toBe(false);
    if (result.ok || result.error.kind !== "cancelled") return expect.fail(JSON.stringify(result));
    expect(uploadedNames(s.fake.calls)).toEqual(["a.png"]);
    expect(result.error.partial.uploaded).toBe(1);
    const map = s.mapStore.read("d");
    expect(map.ok && map.value.map((e) => e.url)).toEqual([fakeImageUrl(0)]);
    expect(s.fake.calls.closed).toBe(1);
  });

  it("投入中に画面要素がなくなったら処理を止め、それまでの結果を添えて editorUnavailable を返す(8.1)", async () => {
    const s = setup({
      uploadResult: (_p, i) =>
        i === 0 ? { ok: true, value: fakeImageUrl(0) } : { ok: false, error: { kind: "editorElementMissing", element: 'input[type="file"]' } },
    });
    s.file("d1", "a.png", PNG("a"));
    s.file("d2", "b.png", PNG("b"));
    s.file("d2", "c.png", PNG("c"));
    const result = await s.service.run(
      s.plan([
        { key: "local:d1", title: "1", folderName: "d1", body: "![a](a.png)" },
        { key: "local:d2", title: "2", folderName: "d2", body: "![b](b.png)\n![c](c.png)" },
      ]),
      NOT_CANCELLED,
    );
    if (result.ok || result.error.kind !== "editorUnavailable") return expect.fail(JSON.stringify(result));
    expect(result.error.missing).toBe('input[type="file"]');
    expect(uploadedNames(s.fake.calls)).toEqual(["a.png", "b.png"]); // c.png は投入しない
    expect(result.error.partial.articles.get("local:d1")?.ok).toBe(true);
    expect(result.error.partial.articles.get("local:d2")).toEqual({ ok: false, failedRefs: ["b.png", "c.png"] });
  });
});

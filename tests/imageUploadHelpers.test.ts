import { describe, it, expect } from "vitest";
import { createFakeUploader, fakeImageUrl } from "./helpers/fakeEditorImageUploader.js";
import { startMockQiitaEditor } from "./helpers/mockQiitaEditor.js";

describe("テストヘルパ(image-upload-automation 1.3)", () => {
  it("偽の部品は筋書きどおりに結果を返し、呼び出しを記録する", async () => {
    const { uploader, calls } = createFakeUploader({
      uploadResult: (_p, i) => (i === 1 ? { ok: false, error: { kind: "timeout" } } : { ok: true, value: fakeImageUrl(i) }),
    });
    const opened = await uploader.open({ persistSession: false, workDraftUrl: null });
    if (!opened.ok) return expect.fail("open failed");
    expect((await opened.value.waitUntilReady(1000, { cancelled: false })).ok).toBe(true);
    expect(await opened.value.uploadImage("/x/a.png", 1000)).toEqual({ ok: true, value: fakeImageUrl(0) });
    expect((await opened.value.uploadImage("/x/b.png", 1000)).ok).toBe(false);
    await opened.value.close();
    expect(calls).toMatchObject({ readyWaits: 1, uploaded: ["/x/a.png", "/x/b.png"], closed: 1 });
  });

  it("模擬エディタ画面は未ログイン時にログイン画面へリダイレクトする", async () => {
    const editor = await startMockQiitaEditor({ requireLogin: true });
    try {
      const res = await fetch(`${editor.origin}/drafts/new`, { redirect: "manual" });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/login?redirect_to=%2Fdrafts%2Fnew");
      const loggedIn = await fetch(`${editor.origin}/drafts/new`, { headers: { cookie: "mock_session=1" } });
      expect(await loggedIn.text()).toContain('input type="file"');
    } finally {
      await editor.close();
    }
  });
});

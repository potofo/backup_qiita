import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthServiceImpl } from "../src/services/authService.js";
import { QiitaApiClientImpl } from "../src/infra/qiitaApiClient.js";
import { createTokenStore } from "../src/config/tokenStore.js";
import { EnvFileConfig } from "../src/config/env.js";
import { startMockQiita, makeRawItem, type MockQiitaServer } from "./helpers/mockQiitaServer.js";

let mock: MockQiitaServer | undefined;
afterEach(async () => {
  await mock?.close();
  mock = undefined;
});

describe("AuthService(3.1)", () => {
  let envPath: string;

  beforeEach(() => {
    envPath = join(mkdtempSync(join(tmpdir(), "qbt-auth-")), ".env");
  });

  const setup = async (envToken: string | null) => {
    mock = await startMockQiita({
      items: [makeRawItem({ id: "a1" }), makeRawItem({ id: "a2" })],
      userId: "potofo",
      validToken: "valid-token",
    });
    const tokenStore = createTokenStore(envToken);
    const client = new QiitaApiClientImpl(tokenStore, { baseUrl: mock.url });
    const envConfig = new EnvFileConfig(envPath);
    const auth = new AuthServiceImpl(client, tokenStore, envConfig);
    return { auth, tokenStore };
  };

  it("初期状態は未確認(マスク済みトークン付き)(1.8)", async () => {
    const { auth } = await setup("valid-token");
    const status = auth.status();
    expect(status.state).toBe("unchecked");
    if (status.state === "unchecked") {
      expect(status.maskedToken).toBe("****oken");
    }
  });

  it("設定由来トークンで接続成功: ユーザIDと投稿記事数を返す(1.2, 1.3)", async () => {
    const { auth } = await setup("valid-token");
    const result = await auth.verify({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({ userId: "potofo", itemsCount: 2, savedToEnv: false });
    }
    expect(auth.status().state).toBe("connected");
  });

  it("画面入力トークン+保存同意あり: .envへ保存しメモリも更新する(1.5, 1.6)", async () => {
    const { auth, tokenStore } = await setup(null);
    const result = await auth.verify({ token: "valid-token", save: true });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.savedToEnv).toBe(true);
    expect(tokenStore.get()).toBe("valid-token");
    expect(readFileSync(envPath, "utf8")).toContain("QIITA_ACCESS_TOKEN=valid-token");
  });

  it("画面入力トークン+保存同意なし: メモリのみ保持し.envへ書き込まない(1.7)", async () => {
    const { auth, tokenStore } = await setup(null);
    const result = await auth.verify({ token: "valid-token", save: false });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.savedToEnv).toBe(false);
    expect(tokenStore.get()).toBe("valid-token");
    expect(existsSync(envPath)).toBe(false);
  });

  it("トークン未設定: missingエラーを返し状態はinvalid(1.4)", async () => {
    const { auth } = await setup(null);
    const result = await auth.verify({});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("missing");
    const status = auth.status();
    expect(status.state).toBe("invalid");
    if (status.state === "invalid") expect(status.reason).toBe("missing");
  });

  it("無効トークン(401): unauthorizedを返し.envへ保存しない(1.4)", async () => {
    const { auth, tokenStore } = await setup(null);
    const result = await auth.verify({ token: "wrong-token", save: true });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unauthorized");
    // 検証失敗時はメモリのトークンも更新しない
    expect(tokenStore.get()).toBeNull();
    expect(existsSync(envPath)).toBe(false);
    const status = auth.status();
    expect(status.state).toBe("invalid");
    if (status.state === "invalid") expect(status.reason).toBe("unauthorized");
  });

  it("無効な設定由来トークン+保存同意あり: 検証失敗なら保存しない", async () => {
    const { auth } = await setup("wrong-token");
    const result = await auth.verify({ save: true });
    expect(result.ok).toBe(false);
    expect(existsSync(envPath)).toBe(false);
  });
});

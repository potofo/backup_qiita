/**
 * アクセストークンのメモリ保持(単一の真実 — 8.1)
 * - トークン全文はここ以外に保持しない。表示は末尾4桁マスクのみ(8.2)
 */
export interface TokenStore {
  get(): string | null;
  /** メモリのみ更新する(.env への保存は EnvFileConfig.persistToken の1経路に限定) */
  set(token: string): void;
  /** 例: "****8d5a"。未設定時は null */
  maskedTail(): string | null;
}

export function createTokenStore(initialToken?: string | null): TokenStore {
  let token: string | null = initialToken ?? null;
  return {
    get: () => token,
    set: (t: string) => {
      token = t;
    },
    maskedTail: () => {
      if (!token) return null;
      return token.length > 4 ? `****${token.slice(-4)}` : "****";
    },
  };
}

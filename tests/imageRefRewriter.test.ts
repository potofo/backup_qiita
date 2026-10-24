import { describe, it, expect } from "vitest";
import { extractLocalImageRefs, rewriteImageRefs } from "../src/services/imageRefRewriter.js";
import { extractLocalImageRefs as fromUploadService } from "../src/services/uploadService.js";

describe("extractLocalImageRefs(image-upload-automation 2.1, 2.2)", () => {
  it("Markdown画像記法とimgタグのローカル参照を出現順・重複なしで抽出する", () => {
    const md = [
      '<img src="images/hero.png" alt="ヒーロー" width="1024">',
      "![図1](images/a.png)",
      '![図2](./b.png "タイトル")',
      "![図1再掲](images/a.png)",
      "<img alt='x' src='sub/c.jpg'>",
    ].join("\n");
    expect(extractLocalImageRefs(md)).toEqual(["images/hero.png", "images/a.png", "./b.png", "sub/c.jpg"]);
  });

  it("外部URL・プロトコル相対・アンカー・data URIは抽出しない", () => {
    const md = [
      "![a](https://qiita-image-store.s3.amazonaws.com/x.png)",
      '<img src="http://example.com/y.png">',
      "![b](//cdn.example.com/z.png)",
      "![c](#anchor)",
      "![d](data:image/png;base64,AAAA)",
    ].join("\n");
    expect(extractLocalImageRefs(md)).toEqual([]);
  });

  it("フェンスコードブロックとインラインコードの中は対象外にする", () => {
    const md = [
      "```markdown",
      "![例](images/in-code.png)",
      "```",
      "~~~",
      '<img src="images/in-tilde.png">',
      "~~~",
      "本文の `![インライン](images/inline.png)` は例示",
      "![本物](images/real.png)",
    ].join("\n");
    expect(extractLocalImageRefs(md)).toEqual(["images/real.png"]);
  });

  it("既存のアップロード機能からも同じ関数を使える(移設後の互換)", () => {
    expect(fromUploadService("![a](images/a.png)")).toEqual(["images/a.png"]);
  });
});

describe("rewriteImageRefs(image-upload-automation 7.1, 7.2)", () => {
  const url = "https://qiita-image-store.s3.ap-northeast-1.amazonaws.com/0/1/u1.png";

  it("パス部分だけを置換し、代替テキスト・title・imgタグの他の属性を変えない", () => {
    const md = [
      '<img src="images/hero.png" alt="明るいオフィス" width="1024">',
      '![図 1](images/hero.png "キャプション")',
    ].join("\n");
    const out = rewriteImageRefs(md, new Map([["images/hero.png", url]]));
    expect(out).toBe(
      [`<img src="${url}" alt="明るいオフィス" width="1024">`, `![図 1](${url} "キャプション")`].join("\n"),
    );
  });

  it("対応にない参照・外部URL・コードブロック内の参照は変更しない", () => {
    const md = [
      "![a](images/a.png)",
      "![b](images/b.png)",
      "```",
      "![a](images/a.png)",
      "```",
      "![ext](https://example.com/a.png)",
    ].join("\n");
    const out = rewriteImageRefs(md, new Map([["images/a.png", url]]));
    expect(out).toBe(
      [`![a](${url})`, "![b](images/b.png)", "```", "![a](images/a.png)", "```", "![ext](https://example.com/a.png)"].join(
        "\n",
      ),
    );
  });

  it("空の対応表では本文が1文字も変わらない", () => {
    const md = "# 見出し\r\n\r\n![a](images/a.png)\r\n<img src='b.png'>\r\n";
    expect(rewriteImageRefs(md, new Map())).toBe(md);
  });
});

/**
 * ローカル画像参照の抽出と置換(image-upload-automation 2.1, 2.2, 7.1, 7.2 / article-upload-sync 8.3)
 * - 対象はMarkdown画像記法 `![alt](path "title")` とimgタグ `<img ... src="path" ...>`
 * - スキーム付きURL・`//`・`#` 始まりは外部参照として抽出・置換しない
 * - フェンスコードブロックとインラインコードの中は対象外(例示の記法を書き換えない)
 * - 置換はパス部分のみ。代替テキスト・title・imgタグの他の属性は1文字も変えない(純粋関数)
 */

const MD_IMAGE_PATTERN = /(!\[[^\]]*\]\(\s*)([^)\s]+)((?:\s+"[^"]*")?\s*\))/g;
const HTML_IMAGE_PATTERN = /(<img\b[^>]*?\bsrc\s*=\s*)(["'])([^"']+)\2/gi;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const INLINE_CODE_PATTERN = /(`+)[\s\S]*?[^`]\1(?!`)/g;

const isRemoteRef = (ref: string): boolean =>
  /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//") || ref.startsWith("#");

/** 本文をコード以外の区間ごとに変換する(コード区間はそのまま残す) */
const mapOutsideCode = (markdown: string, transform: (text: string) => string): string => {
  const lines = markdown.split(/(?<=\n)/); // 改行を各行の末尾に残して分割する
  let out = "";
  let pending = "";
  let fence: string | null = null;
  const flushText = (): void => {
    out += pending.replace(INLINE_CODE_PATTERN, (code) => `\u0000${code}\u0000`)
      .split("\u0000")
      .map((part, i) => (i % 2 === 1 ? part : transform(part)))
      .join("");
    pending = "";
  };
  for (const line of lines) {
    const match = FENCE_PATTERN.exec(line);
    if (fence === null) {
      if (match) {
        flushText();
        fence = match[1]!;
        out += line;
      } else {
        pending += line;
      }
    } else {
      out += line;
      // 開始と同じ記号で、同じ長さ以上のフェンスで閉じる
      if (match && match[1]![0] === fence[0] && match[1]!.length >= fence.length) fence = null;
    }
  }
  flushText();
  return out;
};

/** 本文中のローカル画像参照(出現順・重複なし)。ref は本文に書かれたままの文字列 */
export const extractLocalImageRefs = (markdown: string): string[] => {
  const refs: string[] = [];
  // 区間は本文の先頭から順に渡されるため、区間内を位置順に並べれば全体も出現順になる
  mapOutsideCode(markdown, (text) => {
    const hits = [
      ...[...text.matchAll(MD_IMAGE_PATTERN)].map((m) => ({ pos: m.index, ref: m[2]! })),
      ...[...text.matchAll(HTML_IMAGE_PATTERN)].map((m) => ({ pos: m.index, ref: m[3]! })),
    ].sort((a, b) => a.pos - b.pos);
    for (const { ref } of hits) refs.push(ref);
    return text;
  });
  return [...new Set(refs.filter((ref) => !isRemoteRef(ref)))];
};

/** ref → URL の対応で置換する。対応にない ref・外部URL・コード内は変更しない */
export const rewriteImageRefs = (markdown: string, mapping: ReadonlyMap<string, string>): string => {
  if (mapping.size === 0) return markdown;
  const resolve = (ref: string): string => (isRemoteRef(ref) ? ref : (mapping.get(ref) ?? ref));
  return mapOutsideCode(markdown, (text) =>
    text
      .replace(MD_IMAGE_PATTERN, (_m, head: string, ref: string, tail: string) => `${head}${resolve(ref)}${tail}`)
      .replace(
        HTML_IMAGE_PATTERN,
        (_m, head: string, quote: string, ref: string) => `${head}${quote}${resolve(ref)}${quote}`,
      ),
  );
};

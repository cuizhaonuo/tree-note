// 文件名：由笔记标题生成 `.md` 文件名，重名时加 `-2`、`-3` 等后缀。

// Windows 和 macOS 上不能出现在文件名里的字符，以及控制字符。
const FORBIDDEN_RE = /[\\/:*?"<>|\x00-\x1f]/g;
const FALLBACK_NAME = "未命名";

/** `existing` 是文件夹里已有的文件名；比较时不区分大小写，因为 Windows 和 macOS 的文件系统不区分。 */
export function noteFileName(title: string, existing: Iterable<string>): string {
  const base =
    title
      .replace(FORBIDDEN_RE, "-")
      .trim()
      .replace(/[.\s]+$/, "") || FALLBACK_NAME;
  const taken = new Set([...existing].map((name) => name.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? `${base}.md` : `${base}-${n}.md`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

/** 服务器只接受符合规则的文件名：以 `.md` 结尾（不区分大小写），不含路径分隔符或 `..`，防止读写目录以外的文件。 */
export function isValidNoteFileName(name: string): boolean {
  return (
    name.length > ".md".length &&
    name.toLowerCase().endsWith(".md") &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes("..")
  );
}

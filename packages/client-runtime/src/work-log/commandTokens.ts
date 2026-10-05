import type { EmbeddedScript } from "./embeddedScripts.js";

export interface CommandSyntaxToken {
  readonly content: string;
  readonly offset: number;
  readonly color?: string | null;
  readonly fontStyle?: number | null;
}

export type CommandTokenLines = ReadonlyArray<ReadonlyArray<CommandSyntaxToken>>;

/** Apply nested-script colors while keeping the original command, including escapes. */
export function withEmbeddedScripts(
  code: string,
  lines: CommandTokenLines,
  embedded: ReadonlyArray<EmbeddedScript>,
  tokenize: (text: string, language: string) => CommandTokenLines,
): CommandTokenLines {
  if (embedded.length === 0) return lines;
  const styles = Array.from<CommandSyntaxToken | undefined>({ length: code.length });
  for (const token of lines.flat()) {
    styles.fill(token, token.offset, token.offset + token.content.length);
  }
  for (const script of embedded) {
    let scriptLines: CommandTokenLines;
    try {
      scriptLines = tokenize(script.text, script.language);
    } catch {
      continue;
    }
    for (const token of scriptLines.flat()) {
      if (token.content === "") continue;
      const last = token.offset + token.content.length - 1;
      styles.fill(token, script.starts[token.offset], script.ends[last]);
    }
  }
  const result: CommandSyntaxToken[][] = [];
  let start = 0;
  for (const lineBreak of [...code.matchAll(/\r?\n/gu), undefined]) {
    const end = lineBreak?.index ?? code.length;
    const tokens: CommandSyntaxToken[] = [];
    for (let index = start; index < end;) {
      const style = styles[index];
      let next = index + 1;
      while (
        next < end &&
        styles[next]?.color === style?.color &&
        styles[next]?.fontStyle === style?.fontStyle
      ) {
        next += 1;
      }
      tokens.push({
        content: code.slice(index, next),
        offset: index,
        ...(style?.color ? { color: style.color } : {}),
        ...(style?.fontStyle ? { fontStyle: style.fontStyle } : {}),
      });
      index = next;
    }
    result.push(tokens);
    if (lineBreak) start = lineBreak.index + lineBreak[0].length;
  }
  return result;
}

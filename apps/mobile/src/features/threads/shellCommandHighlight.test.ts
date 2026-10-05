import { describe, expect, it } from "vite-plus/test";
import { getSharedHighlighter } from "@pierre/diffs";

import { highlightCodeSnippet } from "../review/shikiReviewHighlighter";
import { highlightShellCommand } from "./shellCommandHighlight";

describe("mobile shell command highlighting", () => {
  it.each(["light", "dark"] as const)(
    "uses the desktop Pierre palette in %s mode",
    async (theme) => {
      const code = 'printf "%s\\n" "$HOME" && git status --short';
      const themeName = theme === "dark" ? "pierre-dark" : "pierre-light";
      const desktop = await getSharedHighlighter({
        themes: [themeName],
        langs: ["shellscript"],
        preferredHighlighter: "shiki-wasm",
      });
      const expected = desktop.codeToTokensBase(code, {
        lang: "shellscript",
        theme: themeName,
      });
      const mobile = await highlightShellCommand({ code, theme });
      const colors = (lines: typeof mobile) =>
        lines.flatMap((line) =>
          line.flatMap((token) => Array.from({ length: token.content.length }, () => token.color)),
        );
      expect(colors(mobile)).toEqual(
        colors(
          expected.map((line) =>
            line.map((token) => ({
              content: token.content,
              color: token.color ?? null,
              fontStyle: token.fontStyle ?? null,
            })),
          ),
        ),
      );
    },
  );
  it.each(["light", "dark"] as const)("colors shell syntax in %s mode", async (theme) => {
    const code = 'printf "%s\\n" "$HOME" && git status --short';
    const tokens = await highlightShellCommand({ code, theme });
    expect(
      tokens
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe(code);
    expect(
      new Set(
        tokens
          .flat()
          .map((token) => token.color)
          .filter(Boolean),
      ).size,
    ).toBeGreaterThan(1);
  });

  it("uses PowerShell grammar for Windows commands", async () => {
    const code = "$env:PATH; Get-Process | Where-Object { $_.CPU -gt 1 }";
    expect(await highlightShellCommand({ code, theme: "dark" })).toEqual(
      await highlightCodeSnippet({
        code,
        language: "powershell",
        theme: "dark",
        palette: "pierre",
      }),
    );
  });

  it("colors a JavaScript heredoc as JavaScript and preserves selection text", async () => {
    const script = "const answer = 42;\nconsole.log(answer);";
    const code = `node <<'JS'\n${script}\nJS`;
    const highlighted = await highlightShellCommand({ code, theme: "dark" });
    const javascript = await highlightCodeSnippet({
      code: script,
      language: "javascript",
      theme: "dark",
      palette: "pierre",
    });
    expect(highlighted.map((line) => line.map((token) => token.content).join("")).join("\n")).toBe(
      code,
    );
    const perCharacterColors = (lines: typeof highlighted) =>
      lines.map((line) =>
        line.flatMap((token) => Array.from({ length: token.content.length }, () => token.color)),
      );
    expect(perCharacterColors(highlighted.slice(1, 3))).toEqual(perCharacterColors(javascript));
  });

  it("keeps escaped quotes in a nested script intact", async () => {
    const code = '/bin/bash -lc "node -e \\"console.log(42)\\""';
    const highlighted = await highlightShellCommand({ code, theme: "light" });
    expect(
      highlighted
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe(code);
    expect(
      new Set(
        highlighted
          .flat()
          .map((token) => token.color)
          .filter(Boolean),
      ).size,
    ).toBeGreaterThan(1);
  });

  it("preserves blank lines and CRLF command text", async () => {
    const code = "node <<'JS'\r\nconst answer = 42;\r\n\r\nconsole.log(answer);\r\nJS";
    const highlighted = await highlightShellCommand({ code, theme: "dark" });
    expect(
      highlighted.map((line) => line.map((token) => token.content).join("")).join("\r\n"),
    ).toBe(code);
  });
});

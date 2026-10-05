import { commandHighlightLanguage } from "@t3tools/client-runtime/work-log/command-label";
import {
  withEmbeddedScripts,
  type CommandSyntaxToken,
  type CommandTokenLines,
} from "@t3tools/client-runtime/work-log/command-tokens";
import {
  highlightCodeSnippet,
  type ReviewDiffTheme,
  type ReviewHighlightedToken,
} from "../review/shikiReviewHighlighter";

function withOffsets(
  code: string,
  lines: Awaited<ReturnType<typeof highlightCodeSnippet>>,
): CommandTokenLines {
  const endings = code.match(/\r?\n/gu) ?? [];
  let offset = 0;
  return lines.map((line, index) => {
    const tokens = line.map((token): CommandSyntaxToken => {
      const result = { ...token, offset };
      offset += token.content.length;
      return result;
    });
    offset += endings[index]?.length ?? 0;
    return tokens;
  });
}

/** The mobile and web command views share script detection and escape mapping. */
export async function highlightShellCommand(input: {
  readonly code: string;
  readonly theme: ReviewDiffTheme;
}): Promise<ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>>> {
  const language = commandHighlightLanguage(input.code);
  const outer = withOffsets(
    input.code,
    await highlightCodeSnippet({ ...input, language, palette: "pierre" }),
  );
  if (language !== "shellscript" || input.code.length > 100_000) return normalize(outer);
  const { embeddedScripts } = await import("@t3tools/client-runtime/work-log/embedded-scripts");
  const scripts = embeddedScripts(input.code);
  // Each expanded command loads only the grammars its scripts use.
  const tokens = new Map<string, Map<string, CommandTokenLines>>();
  for (const script of scripts) {
    let byText = tokens.get(script.language);
    if (!byText) {
      byText = new Map();
      tokens.set(script.language, byText);
    }
    if (byText.has(script.text)) continue;
    try {
      byText.set(
        script.text,
        withOffsets(
          script.text,
          await highlightCodeSnippet({
            code: script.text,
            language: script.language,
            theme: input.theme,
            palette: "pierre",
          }),
        ),
      );
    } catch {
      // Retain the shell colors if a nested grammar is unavailable.
    }
  }
  return normalize(
    withEmbeddedScripts(input.code, outer, scripts, (text, lang) => {
      const result = tokens.get(lang)?.get(text);
      if (!result) throw new Error("Embedded command grammar unavailable");
      return result;
    }),
  );
}

function normalize(lines: CommandTokenLines): ReadonlyArray<ReadonlyArray<ReviewHighlightedToken>> {
  return lines.map((line) =>
    line.map((token) => ({
      content: token.content,
      color: token.color ?? null,
      fontStyle: token.fontStyle ?? null,
    })),
  );
}

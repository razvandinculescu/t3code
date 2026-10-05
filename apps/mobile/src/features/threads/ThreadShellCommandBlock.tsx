import { withVisibleControlCharacters } from "@t3tools/client-runtime/work-log/command-label";
import { memo, useMemo } from "react";
import { Text as NativeText } from "react-native";

import { AppText } from "../../components/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  createMarkdownCodeHighlightAtomFamily,
  useMarkdownCodeHighlight,
} from "./markdownCodeHighlightState";
import { highlightShellCommand } from "./shellCommandHighlight";

const shellCommandHighlightAtom = createMarkdownCodeHighlightAtomFamily({
  highlight: (input) => highlightShellCommand(input),
});

/** Mounted only for expanded commands; results reuse the bounded highlight cache. */
export const ThreadShellCommandBlock = memo(function ThreadShellCommandBlock(props: {
  readonly command: string;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const code = useMemo(() => withVisibleControlCharacters(props.command.trim()), [props.command]);
  const highlighted = useMarkdownCodeHighlight(
    {
      code,
      enabled: true,
      language: "shellscript",
      theme: themeAppearance,
    },
    shellCommandHighlightAtom,
  );
  const endings = code.match(/\r?\n/gu) ?? [];
  let offset = 0;
  return (
    <AppText selectable className="font-mono text-2xs leading-normal text-foreground">
      {highlighted
        ? highlighted.map((line, index) => {
            const lineOffset = offset;
            const content = line.map((token) => {
              const tokenOffset = offset;
              offset += token.content.length;
              const fontStyle = token.fontStyle ?? 0;
              return (
                <NativeText
                  key={tokenOffset}
                  style={{
                    ...(token.color ? { color: token.color } : {}),
                    fontStyle: fontStyle & 1 ? "italic" : "normal",
                    fontWeight: fontStyle & 2 ? "700" : "400",
                    textDecorationLine: fontStyle & 4 ? "underline" : "none",
                  }}
                >
                  {token.content}
                </NativeText>
              );
            });
            const ending = endings[index] ?? "";
            offset += ending.length;
            return (
              <NativeText key={lineOffset}>
                {content}
                {ending}
              </NativeText>
            );
          })
        : code}
    </AppText>
  );
});

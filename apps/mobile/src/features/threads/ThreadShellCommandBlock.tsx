import { withVisibleControlCharacters } from "@t3tools/client-runtime/work-log/command-label";
import { memo, useMemo } from "react";
import { Text as NativeText } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useAtomValue } from "@effect/atom-react";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import type { HighlightScheme } from "../../lib/highlights";
import { highlightShellCommand } from "./shellCommandHighlight";

class CommandHighlightRequest extends Data.Class<{
  readonly code: string;
  readonly theme: HighlightScheme;
}> {}
class CommandHighlightError extends Data.TaggedError("CommandHighlightError")<{
  readonly cause: unknown;
}> {}
const shellCommandHighlightAtom = Atom.family((request: CommandHighlightRequest) =>
  Atom.make(
    Effect.tryPromise({
      try: () => highlightShellCommand(request),
      catch: (cause) => new CommandHighlightError({ cause }),
    }),
  ).pipe(Atom.setIdleTTL(5 * 60_000)),
);

/** Mounted only for expanded commands; results reuse the bounded highlight cache. */
export const ThreadShellCommandBlock = memo(function ThreadShellCommandBlock(props: {
  readonly command: string;
}) {
  const { themeAppearance } = useAppearancePreferences();
  const code = useMemo(() => withVisibleControlCharacters(props.command.trim()), [props.command]);
  const atom = useMemo(
    () => shellCommandHighlightAtom(new CommandHighlightRequest({ code, theme: themeAppearance })),
    [code, themeAppearance],
  );
  const result = useAtomValue(atom);
  const highlighted = AsyncResult.isSuccess(result) ? result.value : null;
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

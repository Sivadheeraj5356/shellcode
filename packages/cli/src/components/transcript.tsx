import { TextAttributes } from "@opentui/core";
import { useTheme } from "../providers/theme";
import { useSession, type Entry } from "../providers/session";

const TIER_LABEL: Record<string, string> = { light: "light", standard: "standard", heavy: "heavy" };

function Row({ e }: { e: Entry }) {
  const { colors } = useTheme();
  switch (e.kind) {
    case "user":
      return (
        <box border={["left"]} borderColor={colors.primary} paddingLeft={1} marginTop={1}>
          <text>{e.text}</text>
        </box>
      );
    case "assistant":
      return <box paddingLeft={2} marginTop={1}><text>{e.text}</text></box>;
    case "route":
      return (
        <box paddingLeft={2} flexDirection="row">
          <box marginRight={1} flexShrink={0}><text fg={colors.info}>route</text></box>
          <text attributes={TextAttributes.DIM}>
            {TIER_LABEL[e.tier]} {e.model ? `→ ${e.model}` : "→ no model"} · {e.reasons.slice(0, 2).join("; ")}
          </text>
        </box>
      );
    case "tool":
      return (
        <box paddingLeft={2} flexDirection="row" gap={1}>
          <text fg={e.error ? colors.error : colors.success}>{e.error ? "✗" : "✓"}</text>
          <text attributes={TextAttributes.DIM}>{e.name} {e.summary}</text>
        </box>
      );
    case "note":
      return <box paddingLeft={2}><text fg={e.error ? colors.error : colors.thinking}>{e.text}</text></box>;
  }
}

export function Transcript() {
  const { entries, running, live } = useSession();
  const { colors } = useTheme();
  return (
    <scrollbox flexGrow={1} width="100%" stickyScroll stickyStart="bottom" paddingX={2}>
      {entries.map((e, i) => <Row key={i} e={e} />)}
      {live.trim() && <box paddingLeft={2} marginTop={1}><text>{live.trim()}</text></box>}
      {running && <box paddingLeft={2} marginTop={1}><text fg={colors.thinking}>working…  (esc to stop)</text></box>}
    </scrollbox>
  );
}

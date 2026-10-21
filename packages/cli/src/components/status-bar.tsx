import { TextAttributes } from "@opentui/core";
import { useTheme } from "../providers/theme";
import { useSession } from "../providers/session";

export function StatusBar() {
  const { colors } = useTheme();
  const { cfg, lastModel, lastTier, running } = useSession();
  const model = cfg.model ?? (lastModel ? `auto · ${lastModel}` : "auto");
  return (
    <box flexDirection="row" gap={1}>
      <text fg={colors.primary}>{cfg.harness === "auto" ? "built-in" : cfg.harness}</text>
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>›</text>
      <text>{model}</text>
      <text attributes={TextAttributes.DIM} fg={colors.dimSeparator}>·</text>
      <text attributes={TextAttributes.DIM}>{cfg.policy}{lastTier && !cfg.model ? ` · ${lastTier}` : ""}{cfg.yolo ? " · auto-approve" : ""}{running ? " · working" : ""}</text>
    </box>
  );
}

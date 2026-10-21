import { PROVIDERS } from "@shellcode/core";
import { useSession } from "../../providers/session";
import { useTheme } from "../../providers/theme";

export function ProvidersDialogContent() {
  const { providers } = useSession();
  const { colors } = useTheme();
  return (
    <box flexDirection="column">
      {providers.map((p) => {
        const spec = PROVIDERS.find((s) => s.id === p.id);
        const detail = p.ready ? p.detail : spec?.keyEnv ? `set ${spec.keyEnv}` : p.detail;
        const name = p.name.replace(" (AI Studio)", "").replace(" (local)", "").slice(0, 16);
        return (
          <text key={p.id} fg={p.ready ? colors.success : colors.dimSeparator}>
            {`${p.ready ? "●" : "○"} ${name.padEnd(17)}${p.cost.padEnd(10)}${detail}`}
          </text>
        );
      })}
      <text fg={colors.dimSeparator}> </text>
      <text fg={colors.dimSeparator}>Keys come from environment variables.</text>
    </box>
  );
}

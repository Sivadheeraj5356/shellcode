import { useDialog } from "../../providers/dialog";
import { useSession } from "../../providers/session";
import { useTheme } from "../../providers/theme";
import { DialogSearchList } from "../dialog-search-list";

type Item = { key: string; label: string; detail: string; value: string | undefined };

/** "Auto" lets the router decide per request; a pinned model overrides it. */
export function ModelsDialogContent() {
  const dialog = useDialog();
  const { models, cfg, update } = useSession();
  const { colors } = useTheme();
  const items: Item[] = [
    { key: "auto", label: "Auto (router decides per task)", detail: `policy: ${cfg.policy}`, value: undefined },
    ...models.slice(0, 400).map((m) => ({ key: `${m.provider}/${m.id}`, label: `${m.provider}/${m.id}`, detail: `${m.tier} · ${m.cost}`, value: `${m.provider}/${m.id}` })),
  ];
  return (
    <DialogSearchList
      items={items}
      onSelect={(i) => { update({ model: i.value }); dialog.close(); }}
      filterFn={(i, q) => i.label.toLowerCase().includes(q.toLowerCase())}
      renderItem={(i, sel) => (
        <text selectable={false} fg={sel ? "black" : (i.value === cfg.model ? colors.primary : "white")}>
          {(i.value === cfg.model ? " • " : "   ") + i.label + "  " + i.detail}
        </text>
      )}
      getKey={(i) => i.key}
      placeholder="Search models (set a provider key to see more)"
      emptyText="No models. Run /providers to see what to set up"
    />
  );
}

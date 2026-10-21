import { useDialog } from "../../providers/dialog";
import { useSession } from "../../providers/session";
import { useTheme } from "../../providers/theme";
import { DialogSearchList } from "../dialog-search-list";

export function HarnessDialogContent() {
  const dialog = useDialog();
  const { harnesses, cfg, update } = useSession();
  const { colors } = useTheme();
  const items = [{ id: "auto", name: "Auto", ready: true, detail: "built-in agent when a model is available" }, ...harnesses.map((h) => ({ id: h.id, name: h.name, ready: h.ready, detail: h.ready ? "ready" : h.detail }))];
  return (
    <DialogSearchList
      items={items}
      onSelect={(h) => { if (h.ready) { update({ harness: h.id }); dialog.close(); } }}
      filterFn={(h, q) => h.name.toLowerCase().includes(q.toLowerCase())}
      renderItem={(h, sel) => (
        <text selectable={false} fg={sel ? "black" : h.ready ? (h.id === cfg.harness ? colors.primary : "white") : colors.dimSeparator}>
          {(h.id === cfg.harness ? " • " : "   ") + h.name + "  " + (h.ready ? "ready" : "not installed")}
        </text>
      )}
      getKey={(h) => h.id}
      placeholder="Search harnesses"
      emptyText="None"
    />
  );
}

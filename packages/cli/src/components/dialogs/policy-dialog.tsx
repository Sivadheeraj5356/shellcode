import type { Policy } from "@shellcode/core";
import { useDialog } from "../../providers/dialog";
import { useSession } from "../../providers/session";
import { useTheme } from "../../providers/theme";
import { DialogSearchList } from "../dialog-search-list";

const POLICIES: { id: Policy; detail: string }[] = [
  { id: "free", detail: "only free, free-tier and local models. Never paid" },
  { id: "balanced", detail: "free first. Paid models only for heavy tasks" },
  { id: "quality", detail: "strongest model for the task, paid allowed" },
];

export function PolicyDialogContent() {
  const dialog = useDialog();
  const { cfg, update } = useSession();
  const { colors } = useTheme();
  return (
    <DialogSearchList
      items={POLICIES}
      onSelect={(p) => { update({ policy: p.id }); dialog.close(); }}
      filterFn={(p, q) => p.id.includes(q.toLowerCase())}
      renderItem={(p, sel) => <text selectable={false} fg={sel ? "black" : p.id === cfg.policy ? colors.primary : "white"}>{(p.id === cfg.policy ? " • " : "   ") + p.id.padEnd(9) + p.detail}</text>}
      getKey={(p) => p.id}
      placeholder="Routing policy"
    />
  );
}

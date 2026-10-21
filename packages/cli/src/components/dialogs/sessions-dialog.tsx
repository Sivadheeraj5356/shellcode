import { useEffect, useState } from "react";
import { listSessions } from "@shellcode/core";
import { useDialog } from "../../providers/dialog";
import { useSession } from "../../providers/session";
import { DialogSearchList } from "../dialog-search-list";

type Item = Awaited<ReturnType<typeof listSessions>>[number];

export function SessionsDialogContent() {
  const dialog = useDialog();
  const { resume } = useSession();
  const [items, setItems] = useState<Item[] | null>(null);
  useEffect(() => { void listSessions().then(setItems); }, []);
  if (!items) return <text>Loading…</text>;
  return (
    <DialogSearchList
      items={items}
      onSelect={(s) => { void resume(s.id).then(() => dialog.close()); }}
      filterFn={(s, q) => s.title.toLowerCase().includes(q.toLowerCase())}
      renderItem={(s, sel) => <text selectable={false} fg={sel ? "black" : "white"}>{"   " + s.title.padEnd(40).slice(0, 40) + "  " + s.updatedAt.slice(0, 10)}</text>}
      getKey={(s) => s.id}
      placeholder="Search past sessions"
      emptyText="No saved sessions yet"
    />
  );
}

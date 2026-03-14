import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { getGroups, updateFolder, type Group } from "@/lib/api";
import { formatPermString, type FolderNode } from "@/lib/fileExplorerHelpers";

export function FolderPermissionsDialog({
  folder,
  onClose,
  onSaved,
}: {
  folder: FolderNode;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupId, setGroupId] = useState(folder.group_id ?? "");
  const [groupRead, setGroupRead] = useState(folder.group_read);
  const [groupWrite, setGroupWrite] = useState(folder.group_write);
  const [othersRead, setOthersRead] = useState(folder.others_read);
  const [othersWrite, setOthersWrite] = useState(folder.others_write);
  const [recursive, setRecursive] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getGroups().then(setGroups).catch(() => {});
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      await updateFolder(folder.id, {
        group_id: groupId || undefined,
        group_read: groupRead,
        group_write: groupWrite,
        others_read: othersRead,
        others_write: othersWrite,
        recursive,
      });
      toast.success("フォルダ権限を保存しました");
      onSaved();
    } catch (e: any) {
      const msg = e?.message?.includes("403") ? "権限がありません" : "保存に失敗しました";
      toast.error(msg);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={() => onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>フォルダ権限設定: {folder.name}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="text-sm">
            <span className="font-medium">オーナー:</span>{" "}
            <span>{folder.owner_name ?? "不明"}</span>{" "}
            <Badge variant="outline" className="text-xs ml-1">rw（固定）</Badge>
          </div>

          <Separator />

          <div>
            <label className="text-sm font-medium">グループ</label>
            <select
              value={groupId}
              onChange={(e) => setGroupId(e.target.value)}
              className="w-full h-9 rounded-md border bg-background px-3 text-sm mt-1"
            >
              <option value="">なし</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <div className="flex gap-4 mt-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={groupRead} onChange={(e) => setGroupRead(e.target.checked)} />
                読み取り
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={groupWrite} onChange={(e) => setGroupWrite(e.target.checked)} />
                書き込み
              </label>
            </div>
          </div>

          <Separator />

          <div>
            <label className="text-sm font-medium">全員（others）</label>
            <div className="flex gap-4 mt-2">
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={othersRead} onChange={(e) => setOthersRead(e.target.checked)} />
                読み取り
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={othersWrite} onChange={(e) => setOthersWrite(e.target.checked)} />
                書き込み
              </label>
            </div>
          </div>

          <Separator />

          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">パーミッション:</span>
            <code className="text-sm font-mono bg-muted px-2 py-0.5 rounded">
              {formatPermString(groupRead, groupWrite, othersRead, othersWrite)}
            </code>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={recursive} onChange={(e) => setRecursive(e.target.checked)} />
            サブフォルダとその中のファイルにも適用
          </label>
        </div>
        <DialogFooter showCloseButton>
          <Button onClick={handleSave} disabled={saving}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

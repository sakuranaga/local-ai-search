import { useCallback, useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  getUsers,
  createUser,
  deleteUser,
  getRoles,
  createRole,
  deleteRole,
  triggerWikiSync,
  triggerDirectoryIngest,
  getIngestStatus,
  type User,
  type Role,
  type IngestStatus,
} from "@/lib/api";
import { Plus, Trash2, RefreshCw, FolderInput } from "lucide-react";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// User Management Tab
// ---------------------------------------------------------------------------

function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ username: "", password: "", display_name: "", role: "viewer" });

  const load = useCallback(() => {
    getUsers().then(setUsers).catch(() => toast.error("ユーザー取得に失敗"));
  }, []);

  useEffect(load, [load]);

  async function handleCreate() {
    try {
      await createUser(form);
      toast.success("ユーザーを作成しました");
      setDialogOpen(false);
      setForm({ username: "", password: "", display_name: "", role: "viewer" });
      load();
    } catch {
      toast.error("作成に失敗しました");
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("本当に削除しますか？")) return;
    try {
      await deleteUser(id);
      toast.success("削除しました");
      load();
    } catch {
      toast.error("削除に失敗しました");
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">ユーザー一覧</CardTitle>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> 追加
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ユーザー名</TableHead>
              <TableHead>表示名</TableHead>
              <TableHead>ロール</TableHead>
              <TableHead>状態</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">{u.username}</TableCell>
                <TableCell>{u.display_name}</TableCell>
                <TableCell>
                  <Badge variant="secondary">{u.role}</Badge>
                </TableCell>
                <TableCell>
                  <Badge variant={u.is_active ? "default" : "outline"}>
                    {u.is_active ? "有効" : "無効"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(u.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ユーザー追加</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="ユーザー名"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
            />
            <Input
              placeholder="パスワード"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
            <Input
              placeholder="表示名"
              value={form.display_name}
              onChange={(e) => setForm({ ...form, display_name: e.target.value })}
            />
            <Input
              placeholder="ロール (admin, editor, viewer)"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              キャンセル
            </Button>
            <Button onClick={handleCreate}>作成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Role Management Tab
// ---------------------------------------------------------------------------

function RolesTab() {
  const [roles, setRoles] = useState<Role[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState({ name: "", permissions: "" });

  const load = useCallback(() => {
    getRoles().then(setRoles).catch(() => toast.error("ロール取得に失敗"));
  }, []);

  useEffect(load, [load]);

  async function handleCreate() {
    try {
      await createRole({
        name: form.name,
        permissions: form.permissions.split(",").map((s) => s.trim()).filter(Boolean),
      });
      toast.success("ロールを作成しました");
      setDialogOpen(false);
      setForm({ name: "", permissions: "" });
      load();
    } catch {
      toast.error("作成に失敗しました");
    }
  }

  async function handleDelete(id: number) {
    if (!confirm("本当に削除しますか？")) return;
    try {
      await deleteRole(id);
      toast.success("削除しました");
      load();
    } catch {
      toast.error("削除に失敗しました");
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">ロール一覧</CardTitle>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> 追加
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>ロール名</TableHead>
              <TableHead>権限</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    {r.permissions.map((p) => (
                      <Badge key={p} variant="outline" className="text-xs">
                        {p}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" onClick={() => handleDelete(r.id)}>
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ロール追加</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="ロール名"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Input
              placeholder="権限 (カンマ区切り: search, admin, ingest)"
              value={form.permissions}
              onChange={(e) => setForm({ ...form, permissions: e.target.value })}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              キャンセル
            </Button>
            <Button onClick={handleCreate}>作成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Ingest Tab
// ---------------------------------------------------------------------------

function IngestTab() {
  const [dirPath, setDirPath] = useState("");
  const [status, setStatus] = useState<IngestStatus | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [ingesting, setIngesting] = useState(false);

  async function handleWikiSync() {
    setSyncing(true);
    try {
      const s = await triggerWikiSync();
      setStatus(s);
      toast.success("Wiki同期を開始しました");
    } catch {
      toast.error("Wiki同期に失敗しました");
    } finally {
      setSyncing(false);
    }
  }

  async function handleDirectoryIngest() {
    if (!dirPath.trim()) return;
    setIngesting(true);
    try {
      const s = await triggerDirectoryIngest(dirPath.trim());
      setStatus(s);
      toast.success("ディレクトリ取り込みを開始しました");
    } catch {
      toast.error("取り込みに失敗しました");
    } finally {
      setIngesting(false);
    }
  }

  async function handleRefreshStatus() {
    try {
      const s = await getIngestStatus();
      setStatus(s);
    } catch {
      toast.error("ステータス取得に失敗");
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Wiki同期</CardTitle>
        </CardHeader>
        <CardContent>
          <Button onClick={handleWikiSync} disabled={syncing}>
            <RefreshCw className={`h-4 w-4 mr-2 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? "同期中..." : "Wiki同期を実行"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">ディレクトリ取り込み</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Input
              placeholder="/path/to/documents"
              value={dirPath}
              onChange={(e) => setDirPath(e.target.value)}
              className="flex-1"
            />
            <Button onClick={handleDirectoryIngest} disabled={ingesting}>
              <FolderInput className="h-4 w-4 mr-2" />
              {ingesting ? "取り込み中..." : "取り込み"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">取り込みステータス</CardTitle>
          <Button variant="ghost" size="sm" onClick={handleRefreshStatus}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          {status ? (
            <div className="space-y-2 text-sm">
              <p>
                状態: <Badge variant="secondary">{status.status}</Badge>
              </p>
              <p>処理済み文書: {status.documents_processed}</p>
              {status.errors.length > 0 && (
                <div>
                  <p className="text-destructive">エラー:</p>
                  <ul className="list-disc list-inside text-destructive text-xs">
                    {status.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">ステータスを取得するにはリフレッシュしてください</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Admin Page
// ---------------------------------------------------------------------------

export function AdminPage() {
  return (
    <div className="max-w-4xl mx-auto p-4">
      <h1 className="text-xl font-bold mb-4">管理</h1>
      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">ユーザー管理</TabsTrigger>
          <TabsTrigger value="roles">ロール管理</TabsTrigger>
          <TabsTrigger value="ingest">文書取り込み</TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="mt-4">
          <UsersTab />
        </TabsContent>
        <TabsContent value="roles" className="mt-4">
          <RolesTab />
        </TabsContent>
        <TabsContent value="ingest" className="mt-4">
          <IngestTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

import { useCallback, useEffect, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  getUsers,
  createUser,
  updateUser,
  deleteUser,
  getRoles,
  createRole,
  deleteRole,
  getSettings,
  updateSetting,
  type User,
  type Role,
  type SystemSetting,
} from "@/lib/api";
import { Plus, Trash2, Settings, Save, Pencil } from "lucide-react";
import { toast } from "sonner";

// ---------------------------------------------------------------------------
// User Management Tab
// ---------------------------------------------------------------------------

function UsersTab() {
  const [users, setUsers] = useState<User[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [createForm, setCreateForm] = useState({ username: "", password: "", email: "", display_name: "", role: "viewer" });
  const [editForm, setEditForm] = useState({
    username: "", email: "", display_name: "", avatar_url: "", role: "", password: "", is_active: true,
  });

  const load = useCallback(() => {
    getUsers().then(setUsers).catch(() => toast.error("ユーザー取得に失敗"));
    getRoles().then(setRoles).catch(() => {});
  }, []);

  useEffect(load, [load]);

  function openEdit(u: User) {
    setEditUser(u);
    setEditForm({
      username: u.username,
      email: u.email,
      display_name: u.display_name,
      avatar_url: u.avatar_url ?? "",
      role: u.roles[0] ?? "",
      password: "",
      is_active: u.is_active,
    });
    setEditOpen(true);
  }

  async function handleCreate() {
    try {
      await createUser({
        username: createForm.username,
        password: createForm.password,
        email: createForm.email || undefined,
        display_name: createForm.display_name || undefined,
        role: createForm.role || undefined,
      });
      toast.success("ユーザーを作成しました");
      setCreateOpen(false);
      setCreateForm({ username: "", password: "", email: "", display_name: "", role: "viewer" });
      load();
    } catch {
      toast.error("作成に失敗しました");
    }
  }

  async function handleUpdate() {
    if (!editUser) return;
    try {
      const data: Record<string, unknown> = {};
      if (editForm.username !== editUser.username) data.username = editForm.username;
      if (editForm.email !== editUser.email) data.email = editForm.email;
      if (editForm.display_name !== editUser.display_name) data.display_name = editForm.display_name;
      const newAvatar = editForm.avatar_url || null;
      if (newAvatar !== editUser.avatar_url) data.avatar_url = newAvatar;
      const currentRole = editUser.roles[0] ?? "";
      if (editForm.role !== currentRole) data.role = editForm.role;
      if (editForm.is_active !== editUser.is_active) data.is_active = editForm.is_active;
      if (editForm.password) data.password = editForm.password;

      if (Object.keys(data).length === 0) {
        setEditOpen(false);
        return;
      }
      await updateUser(editUser.id, data);
      toast.success("ユーザーを更新しました");
      setEditOpen(false);
      load();
    } catch {
      toast.error("更新に失敗しました");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("本当に削除しますか？")) return;
    try {
      await deleteUser(id);
      toast.success("削除しました");
      load();
    } catch {
      toast.error("削除に失敗しました");
    }
  }

  const roleNames = roles.map((r) => r.name);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">ユーザー一覧</CardTitle>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> 追加
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>ユーザー名</TableHead>
              <TableHead>表示名</TableHead>
              <TableHead>メール</TableHead>
              <TableHead>ロール</TableHead>
              <TableHead>状態</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.map((u) => (
              <TableRow key={u.id} className="cursor-pointer hover:bg-muted/50" onClick={() => openEdit(u)}>
                <TableCell>
                  {u.avatar_url ? (
                    <img src={u.avatar_url} alt="" className="h-7 w-7 rounded-full object-cover" />
                  ) : (
                    <div className="h-7 w-7 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium text-primary">
                      {(u.display_name || u.username).charAt(0).toUpperCase()}
                    </div>
                  )}
                </TableCell>
                <TableCell className="font-medium">{u.username}</TableCell>
                <TableCell>{u.display_name}</TableCell>
                <TableCell className="text-muted-foreground text-xs">{u.email}</TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {u.roles.map((r) => (
                      <Badge key={r} variant="secondary">{r}</Badge>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant={u.is_active ? "default" : "outline"}>
                    {u.is_active ? "有効" : "無効"}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); openEdit(u); }}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); handleDelete(u.id); }}>
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>

      {/* Create dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>ユーザー追加</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">ユーザー名 *</Label>
              <Input value={createForm.username} onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">パスワード *</Label>
              <Input type="password" value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">メールアドレス</Label>
              <Input value={createForm.email} onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })} placeholder="空欄の場合 username@local" />
            </div>
            <div>
              <Label className="text-xs">表示名</Label>
              <Input value={createForm.display_name} onChange={(e) => setCreateForm({ ...createForm, display_name: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">ロール</Label>
              <Select value={createForm.role || undefined} onValueChange={(v) => setCreateForm({ ...createForm, role: v ?? "" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roleNames.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>キャンセル</Button>
            <Button onClick={handleCreate} disabled={!createForm.username || !createForm.password}>作成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>ユーザー編集</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Avatar preview */}
            <div className="flex items-center gap-4">
              {editForm.avatar_url ? (
                <img src={editForm.avatar_url} alt="" className="h-16 w-16 rounded-full object-cover border" />
              ) : (
                <div className="h-16 w-16 rounded-full bg-primary/10 flex items-center justify-center text-xl font-medium text-primary">
                  {(editForm.display_name || editForm.username).charAt(0).toUpperCase()}
                </div>
              )}
              <div className="flex-1">
                <Label className="text-xs">アバター URL</Label>
                <Input value={editForm.avatar_url} onChange={(e) => setEditForm({ ...editForm, avatar_url: e.target.value })} placeholder="https://..." />
              </div>
            </div>
            <div>
              <Label className="text-xs">ユーザー名</Label>
              <Input value={editForm.username} onChange={(e) => setEditForm({ ...editForm, username: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">メールアドレス</Label>
              <Input value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">表示名</Label>
              <Input value={editForm.display_name} onChange={(e) => setEditForm({ ...editForm, display_name: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">新しいパスワード (変更する場合のみ)</Label>
              <Input type="password" value={editForm.password} onChange={(e) => setEditForm({ ...editForm, password: e.target.value })} placeholder="変更しない場合は空欄" />
            </div>
            <div>
              <Label className="text-xs">ロール</Label>
              <Select value={editForm.role || undefined} onValueChange={(v) => setEditForm({ ...editForm, role: v ?? "" })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {roleNames.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">アカウント有効</Label>
              <Switch checked={editForm.is_active} onCheckedChange={(v) => setEditForm({ ...editForm, is_active: v })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>キャンセル</Button>
            <Button onClick={handleUpdate}>保存</Button>
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
// Settings Tab
// ---------------------------------------------------------------------------

const SETTING_GROUPS: Record<string, { label: string; keys: string[] }> = {
  llm: {
    label: "LLM (チャット/回答生成)",
    keys: ["llm_url", "llm_model", "llm_api_key"],
  },
  embed: {
    label: "Embedding (ベクトル検索)",
    keys: ["embed_url", "embed_model", "embed_api_key", "embed_dimensions"],
  },
  search: {
    label: "検索設定",
    keys: ["search_top_k", "vector_similarity_threshold", "ai_max_search_rounds"],
  },
  ingest: {
    label: "取り込み設定",
    keys: ["chunk_size", "chunk_overlap"],
  },
};

function SettingsTab() {
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(() => {
    getSettings()
      .then((s) => {
        setSettings(s);
        setEdited({});
      })
      .catch(() => toast.error("設定の取得に失敗"));
  }, []);

  useEffect(load, [load]);

  function getValue(key: string): string {
    if (key in edited) return edited[key];
    const s = settings.find((s) => s.key === key);
    return s?.value ?? "";
  }

  function handleChange(key: string, value: string) {
    setEdited((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave(key: string) {
    setSaving(key);
    try {
      await updateSetting(key, getValue(key));
      toast.success("保存しました");
      setEdited((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      load();
    } catch {
      toast.error("保存に失敗しました");
    } finally {
      setSaving(null);
    }
  }

  async function handleSaveAll() {
    const keys = Object.keys(edited);
    if (keys.length === 0) return;
    setSaving("all");
    try {
      for (const key of keys) {
        await updateSetting(key, edited[key]);
      }
      toast.success(`${keys.length}件の設定を保存しました`);
      setEdited({});
      load();
    } catch {
      toast.error("保存に失敗しました");
    } finally {
      setSaving(null);
    }
  }

  return (
    <div className="space-y-4">
      {Object.entries(SETTING_GROUPS).map(([groupKey, group]) => (
        <Card key={groupKey}>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <Settings className="h-4 w-4" />
              {group.label}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {group.keys.map((key) => {
              const setting = settings.find((s) => s.key === key);
              const isEdited = key in edited;
              return (
                <div key={key} className="flex items-center gap-2">
                  <div className="min-w-[180px]">
                    <label className="text-sm font-medium">{key}</label>
                    {setting?.description && (
                      <p className="text-xs text-muted-foreground">{setting.description}</p>
                    )}
                  </div>
                  <Input
                    type={setting?.secret ? "password" : "text"}
                    placeholder={setting?.placeholder ?? ""}
                    value={getValue(key)}
                    onChange={(e) => handleChange(key, e.target.value)}
                    className={`flex-1 ${isEdited ? "border-orange-400" : ""}`}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleSave(key)}
                    disabled={!isEdited || saving === key}
                  >
                    <Save className={`h-4 w-4 ${isEdited ? "text-orange-500" : "text-muted-foreground"}`} />
                  </Button>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}
      {Object.keys(edited).length > 0 && (
        <div className="flex justify-end">
          <Button onClick={handleSaveAll} disabled={saving === "all"}>
            <Save className="h-4 w-4 mr-2" />
            変更を一括保存 ({Object.keys(edited).length}件)
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Welcome Message Tab
// ---------------------------------------------------------------------------

function WelcomeTab() {
  const [value, setValue] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings()
      .then((s) => {
        const wm = s.find((x) => x.key === "welcome_message");
        if (wm) {
          setValue(wm.value);
          setOriginal(wm.value);
        }
      })
      .catch(() => toast.error("設定の取得に失敗"));
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      await updateSetting("welcome_message", value);
      setOriginal(value);
      toast.success("保存しました");
    } catch {
      toast.error("保存に失敗しました");
    } finally {
      setSaving(false);
    }
  }

  const isEdited = value !== original;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">ウェルカムメッセージ</CardTitle>
        <p className="text-xs text-muted-foreground">
          ホーム画面（検索前）に表示されるメッセージです。Markdown記法が使えます。
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <Textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Markdownで記述..."
          className={`min-h-[250px] font-mono text-sm ${isEdited ? "border-orange-400" : ""}`}
          rows={12}
        />
        <div className="flex justify-end">
          <Button onClick={handleSave} disabled={!isEdited || saving}>
            <Save className="h-4 w-4 mr-2" />
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
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
          <TabsTrigger value="settings">設定</TabsTrigger>
          <TabsTrigger value="users">ユーザー管理</TabsTrigger>
          <TabsTrigger value="roles">ロール管理</TabsTrigger>
          <TabsTrigger value="welcome">ウェルカム</TabsTrigger>
        </TabsList>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab />
        </TabsContent>
        <TabsContent value="users" className="mt-4">
          <UsersTab />
        </TabsContent>
        <TabsContent value="roles" className="mt-4">
          <RolesTab />
        </TabsContent>
        <TabsContent value="welcome" className="mt-4">
          <WelcomeTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

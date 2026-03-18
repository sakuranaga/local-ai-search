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
  getGroups,
  createGroup,
  deleteGroup,
  getGroupMembers,
  addGroupMember,
  removeGroupMember,
  getApiKeys,
  createApiKey,
  updateApiKey,
  deleteApiKey,
  getFolders,
  getAuditLogs,
  getAuditLogActions,
  exportAuditLogsCsv,
  type User,
  type Role,
  type SystemSetting,
  type Group,
  type GroupMember,
  type ApiKeyInfo,
  type AuditLogItem,
  type Folder,
} from "@/lib/api";
import { Plus, Trash2, Settings, Save, Pencil, Users, Key, Copy, Check, Download, Search, ChevronLeft, ChevronRight } from "lucide-react";
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
  const [createForm, setCreateForm] = useState({ username: "", password: "", email: "", display_name: "", role: "user" });
  const [editForm, setEditForm] = useState({
    username: "", email: "", display_name: "", avatar_url: "", role: "", password: "", is_active: true, can_share: true, can_download: true,
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
      can_share: u.can_share,
      can_download: u.can_download,
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
      setCreateForm({ username: "", password: "", email: "", display_name: "", role: "user" });
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
      if (editForm.can_share !== editUser.can_share) data.can_share = editForm.can_share;
      if (editForm.can_download !== editUser.can_download) data.can_download = editForm.can_download;
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
            <div className="flex items-center justify-between">
              <Label className="text-sm">共有許可</Label>
              <Switch checked={editForm.can_share} onCheckedChange={(v) => setEditForm({ ...editForm, can_share: v })} />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">ダウンロード許可</Label>
              <Switch checked={editForm.can_download} onCheckedChange={(v) => setEditForm({ ...editForm, can_download: v })} />
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
  share: {
    label: "共有リンク (Share Server)",
    keys: ["share_server_url", "share_server_api_key", "share_enabled"],
  },
  security: {
    label: "セキュリティ（アップロードデフォルト）",
    keys: ["default_share_prohibited", "default_download_prohibited"],
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

  async function checkShareConnection(): Promise<boolean> {
    try {
      const { testShareConnection } = await import("@/lib/api");
      const result = await testShareConnection();
      if (result.ok) {
        await updateSetting("share_enabled", "true");
        toast.success("Share Server 接続OK — 共有機能を有効にしました");
        load();
        return true;
      } else {
        await updateSetting("share_enabled", "false");
        toast.error(`Share Server 接続失敗: ${result.error}`);
        load();
        return false;
      }
    } catch {
      toast.error("Share Server 接続テストに失敗しました");
      return false;
    }
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

              // share_enabled はトグルスイッチ + 接続テスト連動
              if (key === "share_enabled") {
                const isOn = getValue(key) === "true";
                return (
                  <div key={key} className="flex items-center gap-3 pt-2 border-t">
                    <div className="min-w-[180px]">
                      <label className="text-sm font-medium">共有機能</label>
                      <p className="text-xs text-muted-foreground">接続テスト成功で有効化</p>
                    </div>
                    <button
                      onClick={async () => {
                        if (!isOn) {
                          // ON にする → 接続テスト必須
                          const ok = await checkShareConnection();
                          if (!ok) return;
                          await updateSetting("share_enabled", "true");
                          toast.success("共有機能を有効にしました");
                        } else {
                          await updateSetting("share_enabled", "false");
                          toast.success("共有機能を無効にしました");
                        }
                        load();
                      }}
                      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isOn ? "bg-primary" : "bg-muted"}`}
                    >
                      <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${isOn ? "translate-x-6" : "translate-x-1"}`} />
                    </button>
                    <span className={`text-sm ${isOn ? "text-primary font-medium" : "text-muted-foreground"}`}>
                      {isOn ? "有効" : "無効"}
                    </span>
                    <Button variant="outline" size="sm" onClick={checkShareConnection} className="ml-auto">
                      接続テスト
                    </Button>
                  </div>
                );
              }

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
// Groups Tab
// ---------------------------------------------------------------------------

function GroupsTab() {
  const [groups, setGroups] = useState<Group[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createForm, setCreateForm] = useState({ name: "", description: "" });
  const [membersOpen, setMembersOpen] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<GroupMember[]>([]);
  const [addUserId, setAddUserId] = useState("");

  const load = useCallback(() => {
    getGroups().then(setGroups).catch(() => toast.error("グループ取得に失敗"));
    getUsers().then(setUsers).catch(() => {});
  }, []);

  useEffect(load, [load]);

  async function handleCreate() {
    try {
      await createGroup({
        name: createForm.name,
        description: createForm.description || undefined,
      });
      toast.success("グループを作成しました");
      setCreateOpen(false);
      setCreateForm({ name: "", description: "" });
      load();
    } catch {
      toast.error("作成に失敗しました");
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("本当に削除しますか？関連するドキュメント・フォルダのグループ設定が解除されます。")) return;
    try {
      await deleteGroup(id);
      toast.success("削除しました");
      load();
    } catch {
      toast.error("削除に失敗しました");
    }
  }

  async function openMembers(g: Group) {
    setSelectedGroup(g);
    setMembersOpen(true);
    try {
      const m = await getGroupMembers(g.id);
      setMembers(m);
    } catch {
      toast.error("メンバー取得に失敗");
    }
  }

  async function handleAddMember() {
    if (!selectedGroup || !addUserId) return;
    try {
      await addGroupMember(selectedGroup.id, addUserId);
      toast.success("メンバーを追加しました");
      setAddUserId("");
      const m = await getGroupMembers(selectedGroup.id);
      setMembers(m);
      load();
    } catch {
      toast.error("追加に失敗しました");
    }
  }

  async function handleRemoveMember(userId: string) {
    if (!selectedGroup) return;
    try {
      await removeGroupMember(selectedGroup.id, userId);
      toast.success("メンバーを削除しました");
      const m = await getGroupMembers(selectedGroup.id);
      setMembers(m);
      load();
    } catch {
      toast.error("削除に失敗しました");
    }
  }

  const availableUsers = users.filter((u) => !members.find((m) => m.user_id === u.id));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">グループ一覧</CardTitle>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> 追加
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>グループ名</TableHead>
              <TableHead>説明</TableHead>
              <TableHead className="w-24 text-center">メンバー数</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((g) => (
              <TableRow key={g.id} className="cursor-pointer hover:bg-muted/50" onClick={() => openMembers(g)}>
                <TableCell className="font-medium">{g.name}</TableCell>
                <TableCell className="text-muted-foreground text-sm">{g.description}</TableCell>
                <TableCell className="text-center">
                  <Badge variant="secondary">{g.member_count}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); openMembers(g); }}>
                      <Users className="h-4 w-4" />
                    </Button>
                    <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); handleDelete(g.id); }}>
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
            <DialogTitle>グループ追加</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">グループ名 *</Label>
              <Input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">説明</Label>
              <Input value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>キャンセル</Button>
            <Button onClick={handleCreate} disabled={!createForm.name.trim()}>作成</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Members dialog */}
      <Dialog open={membersOpen} onOpenChange={setMembersOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{selectedGroup?.name} - メンバー管理</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {members.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ユーザー名</TableHead>
                    <TableHead>表示名</TableHead>
                    <TableHead className="w-12" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {members.map((m) => (
                    <TableRow key={m.user_id}>
                      <TableCell className="font-medium">{m.username}</TableCell>
                      <TableCell className="text-muted-foreground">{m.display_name}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon" onClick={() => handleRemoveMember(m.user_id)}>
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">メンバーがいません</p>
            )}
            {availableUsers.length > 0 && (
              <div className="flex items-center gap-2">
                <select
                  value={addUserId}
                  onChange={(e) => setAddUserId(e.target.value)}
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">ユーザーを追加...</option>
                  {availableUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.username} ({u.display_name || u.email})</option>
                  ))}
                </select>
                <Button size="sm" onClick={handleAddMember} disabled={!addUserId}>追加</Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// API Keys Tab
// ---------------------------------------------------------------------------

const ALL_PERMISSIONS = ["upload", "delete", "search", "overwrite"] as const;

function ApiKeysTab() {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [form, setForm] = useState({
    name: "",
    owner_id: "",
    folder_id: "" as string,
    permissions: ["upload"] as string[],
    allow_overwrite: false,
    expires_at: "",
  });

  const load = useCallback(() => {
    getApiKeys().then(setKeys).catch(() => toast.error("API キーの取得に失敗"));
  }, []);

  useEffect(() => {
    load();
    getUsers().then(setUsers).catch(() => {});
    getFolders().then(setFolders).catch(() => {});
  }, [load]);

  const handleCreate = async () => {
    try {
      const res = await createApiKey({
        name: form.name,
        owner_id: form.owner_id,
        folder_id: form.folder_id || null,
        permissions: form.permissions,
        allow_overwrite: form.allow_overwrite,
        expires_at: form.expires_at || null,
      });
      setCreatedKey(res.plaintext_key);
      load();
    } catch {
      toast.error("作成に失敗しました");
    }
  };

  const handleToggleActive = async (key: ApiKeyInfo) => {
    try {
      await updateApiKey(key.id, { is_active: !key.is_active });
      load();
    } catch {
      toast.error("更新に失敗しました");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteApiKey(id);
      load();
    } catch {
      toast.error("削除に失敗しました");
    }
  };

  const togglePerm = (perm: string) => {
    setForm((f) => ({
      ...f,
      permissions: f.permissions.includes(perm)
        ? f.permissions.filter((p) => p !== perm)
        : [...f.permissions, perm],
    }));
  };

  const handleCopy = () => {
    if (createdKey) {
      navigator.clipboard.writeText(createdKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const resetForm = () => {
    setForm({ name: "", owner_id: "", folder_id: "", permissions: ["upload"], allow_overwrite: false, expires_at: "" });
    setCreatedKey(null);
    setCopied(false);
  };

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2"><Key className="h-5 w-5" />API キー管理</CardTitle>
        <Button size="sm" onClick={() => { resetForm(); setCreateOpen(true); }}><Plus className="h-4 w-4 mr-1" />新規作成</Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名前</TableHead>
              <TableHead>プレフィックス</TableHead>
              <TableHead>ユーザー</TableHead>
              <TableHead>フォルダ</TableHead>
              <TableHead>権限</TableHead>
              <TableHead>上書き</TableHead>
              <TableHead>有効</TableHead>
              <TableHead>最終使用</TableHead>
              <TableHead></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => (
              <TableRow key={k.id}>
                <TableCell className="font-medium">{k.name}</TableCell>
                <TableCell><code className="text-xs">{k.key_prefix}...</code></TableCell>
                <TableCell>{k.owner_name}</TableCell>
                <TableCell>{k.folder_name || "—"}</TableCell>
                <TableCell className="space-x-1">
                  {k.permissions.map((p) => (
                    <Badge key={p} variant="secondary" className="text-xs">{p}</Badge>
                  ))}
                </TableCell>
                <TableCell>{k.allow_overwrite ? "OK" : "—"}</TableCell>
                <TableCell>
                  <Switch checked={k.is_active} onCheckedChange={() => handleToggleActive(k)} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString("ja-JP") : "未使用"}
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" onClick={() => handleDelete(k.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {keys.length === 0 && (
              <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">API キーがありません</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      {/* Create / Show Key Dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { if (!open) { setCreateOpen(false); setCreatedKey(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{createdKey ? "API キーが作成されました" : "API キーを作成"}</DialogTitle>
          </DialogHeader>

          {createdKey ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">このキーは一度だけ表示されます。安全な場所に保存してください。</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-muted p-3 text-sm">{createdKey}</code>
                <Button variant="outline" size="sm" onClick={handleCopy}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <DialogFooter>
                <Button onClick={() => { setCreateOpen(false); setCreatedKey(null); }}>閉じる</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>名前</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="wiki同期用" />
              </div>
              <div className="space-y-2">
                <Label>操作ユーザー</Label>
                <Select value={form.owner_id || undefined} onValueChange={(v) => setForm({ ...form, owner_id: v ?? "" })}>
                  <SelectTrigger><SelectValue placeholder="ユーザーを選択" /></SelectTrigger>
                  <SelectContent>
                    {users.map((u) => (
                      <SelectItem key={u.id} value={u.id}>{u.display_name || u.username}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>対象フォルダ（空 = 制限なし）</Label>
                <Select value={form.folder_id || undefined} onValueChange={(v) => setForm({ ...form, folder_id: v === "__none__" || !v ? "" : v })}>
                  <SelectTrigger><SelectValue placeholder="フォルダを選択" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">制限なし</SelectItem>
                    {folders.map((f) => (
                      <SelectItem key={f.id} value={f.id}>{f.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>権限</Label>
                <div className="flex gap-2 flex-wrap">
                  {ALL_PERMISSIONS.map((perm) => (
                    <Button
                      key={perm}
                      type="button"
                      size="sm"
                      variant={form.permissions.includes(perm) ? "default" : "outline"}
                      onClick={() => togglePerm(perm)}
                    >
                      {perm}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Switch checked={form.allow_overwrite} onCheckedChange={(v) => setForm({ ...form, allow_overwrite: v })} />
                <Label>同名ファイルの上書きを許可</Label>
              </div>
              <div className="space-y-2">
                <Label>有効期限（空 = 無期限）</Label>
                <Input type="date" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>キャンセル</Button>
                <Button onClick={handleCreate} disabled={!form.name || !form.owner_id}>作成</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Audit Logs Tab
// ---------------------------------------------------------------------------

const ACTION_LABELS: Record<string, string> = {
  login: "ログイン",
  "login.failed": "ログイン失敗",
  logout: "ログアウト",
  "document.upload": "ドキュメントアップロード",
  "document.create": "ドキュメント作成",
  "document.update": "ドキュメント更新",
  "document.delete": "ゴミ箱へ移動",
  "document.purge": "完全削除",
  "document.restore": "ゴミ箱から復元",
  "document.overwrite": "ドキュメント上書き",
};

function AuditLogsTab() {
  const [items, setItems] = useState<AuditLogItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage] = useState(50);
  const [actions, setActions] = useState<string[]>([]);
  const [filterAction, setFilterAction] = useState("");
  const [filterQ, setFilterQ] = useState("");
  const [filterDateFrom, setFilterDateFrom] = useState("");
  const [filterDateTo, setFilterDateTo] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getAuditLogs({
        page,
        per_page: perPage,
        action: filterAction || undefined,
        q: filterQ || undefined,
        date_from: filterDateFrom || undefined,
        date_to: filterDateTo || undefined,
      });
      setItems(res.items);
      setTotal(res.total);
    } catch {
      toast.error("監査ログの取得に失敗");
    } finally {
      setLoading(false);
    }
  }, [page, perPage, filterAction, filterQ, filterDateFrom, filterDateTo]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    getAuditLogActions().then(setActions).catch(() => {});
  }, []);

  const totalPages = Math.ceil(total / perPage);

  async function handleExport() {
    try {
      await exportAuditLogsCsv({
        action: filterAction || undefined,
        q: filterQ || undefined,
        date_from: filterDateFrom || undefined,
        date_to: filterDateTo || undefined,
      });
    } catch {
      toast.error("CSV出力に失敗しました");
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">監査ログ</CardTitle>
        <Button size="sm" variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4 mr-1" /> CSV出力
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Filters */}
        <div className="flex flex-wrap gap-2 items-end">
          <div className="w-40">
            <label className="text-xs text-muted-foreground">アクション</label>
            <select
              value={filterAction}
              onChange={(e) => { setFilterAction(e.target.value); setPage(1); }}
              className="w-full h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">すべて</option>
              {actions.map((a) => (
                <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>
              ))}
            </select>
          </div>
          <div className="w-36">
            <label className="text-xs text-muted-foreground">開始日</label>
            <Input type="date" value={filterDateFrom} onChange={(e) => { setFilterDateFrom(e.target.value); setPage(1); }} className="h-9" />
          </div>
          <div className="w-36">
            <label className="text-xs text-muted-foreground">終了日</label>
            <Input type="date" value={filterDateTo} onChange={(e) => { setFilterDateTo(e.target.value); setPage(1); }} className="h-9" />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="text-xs text-muted-foreground">検索</label>
            <div className="flex gap-1">
              <Input
                placeholder="ユーザー名・対象名..."
                value={filterQ}
                onChange={(e) => setFilterQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { setPage(1); load(); } }}
                className="h-9"
              />
              <Button size="sm" variant="ghost" onClick={() => { setPage(1); load(); }}>
                <Search className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">日時</TableHead>
                <TableHead className="w-28">ユーザー</TableHead>
                <TableHead className="w-36">アクション</TableHead>
                <TableHead>対象</TableHead>
                <TableHead className="w-28">IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">読み込み中...</TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">ログがありません</TableCell>
                </TableRow>
              ) : items.map((item) => (
                <TableRow key={item.id}>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                    {new Date(item.created_at).toLocaleString("ja-JP", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })}
                  </TableCell>
                  <TableCell className="text-sm">{item.username || "—"}</TableCell>
                  <TableCell>
                    <Badge variant={item.action.includes("failed") ? "destructive" : "secondary"} className="text-xs">
                      {ACTION_LABELS[item.action] || item.action}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm truncate max-w-[300px]">
                    {item.target_name || item.detail || "—"}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{item.ip_address || "—"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between text-sm text-muted-foreground">
            <span>{total}件中 {(page - 1) * perPage + 1}〜{Math.min(page * perPage, total)}件</span>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-2">{page} / {totalPages}</span>
              <Button size="sm" variant="ghost" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Admin Page
// ---------------------------------------------------------------------------

export function AdminPage() {
  return (
    <div className="max-w-4xl mx-auto p-4 h-full flex flex-col overflow-hidden">
      <h1 className="text-xl font-bold mb-4 shrink-0">管理</h1>
      <Tabs defaultValue="settings" className="flex-1 min-h-0 flex flex-col">
        <TabsList>
          <TabsTrigger value="settings">設定</TabsTrigger>
          <TabsTrigger value="users">ユーザー管理</TabsTrigger>
          <TabsTrigger value="groups">グループ管理</TabsTrigger>
          <TabsTrigger value="roles">ロール管理</TabsTrigger>
          <TabsTrigger value="apikeys">APIキー</TabsTrigger>
          <TabsTrigger value="audit">監査ログ</TabsTrigger>
        </TabsList>
        <TabsContent value="settings" className="mt-4 flex-1 min-h-0 overflow-y-auto p-px">
          <SettingsTab />
        </TabsContent>
        <TabsContent value="users" className="mt-4 flex-1 min-h-0 overflow-y-auto p-px">
          <UsersTab />
        </TabsContent>
        <TabsContent value="groups" className="mt-4 flex-1 min-h-0 overflow-y-auto p-px">
          <GroupsTab />
        </TabsContent>
        <TabsContent value="roles" className="mt-4 flex-1 min-h-0 overflow-y-auto p-px">
          <RolesTab />
        </TabsContent>
        <TabsContent value="apikeys" className="mt-4 flex-1 min-h-0 overflow-y-auto p-px">
          <ApiKeysTab />
        </TabsContent>
        <TabsContent value="audit" className="mt-4 flex-1 min-h-0 overflow-y-auto p-px">
          <AuditLogsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}

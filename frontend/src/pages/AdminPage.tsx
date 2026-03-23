import { useCallback, useEffect, useState } from "react";
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
  getMailRecipients,
  addMailRecipient,
  updateMailRecipient,
  deleteMailRecipient,
  sendTestMail,
  type MailRecipient,
  getWebhooks,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  sendTestWebhook,
  type WebhookEndpoint,
  adminListNotes,
  adminBulkDeleteNotes,
  adminToggleNoteReadonly,
  type AdminNoteItem,
} from "@/lib/api";
import { Plus, Trash2, Settings, Save, Pencil, Users, Key, Copy, Check, Download, Search, ChevronLeft, ChevronRight, Mail, Send, Webhook, BookOpenText, Shield, ScrollText, UsersRound, Share2, Upload, Bot } from "lucide-react";
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
              <select value={createForm.role} onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                {roleNames.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
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
              <select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                {roleNames.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
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
// Share Tab
// ---------------------------------------------------------------------------

const SHARE_KEYS = ["share_server_url", "share_server_api_key", "share_enabled"];

function ShareTab() {
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(() => {
    getSettings()
      .then((s) => {
        setSettings(s.filter((st) => SHARE_KEYS.includes(st.key)));
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

  async function handleSaveAll() {
    const keys = Object.keys(edited);
    if (keys.length === 0) return;
    setSaving("all");
    try {
      for (const key of keys) {
        await updateSetting(key, edited[key]);
      }
      toast.success("保存しました");
      setEdited({});
      load();
    } catch {
      toast.error("保存に失敗しました");
    } finally {
      setSaving(null);
    }
  }

  const isOn = getValue("share_enabled") === "true";
  const hasEdits = Object.keys(edited).length > 0;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base flex items-center gap-2">
          <Share2 className="h-4 w-4" />
          共有リンク (Share Server)
        </CardTitle>
        <Button variant="outline" size="sm" onClick={checkShareConnection}>
          接続テスト
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {SHARE_KEYS.filter((k) => k !== "share_enabled").map((key) => {
          const setting = settings.find((s) => s.key === key);
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
                className={`flex-1 ${key in edited ? "border-orange-400" : ""}`}
              />
            </div>
          );
        })}
        <div className="flex items-center gap-3 pt-2 border-t">
          <div className="min-w-[180px]">
            <label className="text-sm font-medium">共有機能</label>
            <p className="text-xs text-muted-foreground">接続テスト成功で有効化</p>
          </div>
          <button
            onClick={async () => {
              if (!isOn) {
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
        </div>
        <div className="flex justify-end pt-2 border-t">
          <Button onClick={handleSaveAll} disabled={!hasEdits || saving === "all"}>
            <Save className="h-4 w-4 mr-2" />
            保存
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Upload Tab
// ---------------------------------------------------------------------------

const UPLOAD_KEYS = ["default_share_prohibited", "default_download_prohibited"];

function UploadTab() {
  const [settings, setSettings] = useState<SystemSetting[]>([]);
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [maxFileSize, setMaxFileSize] = useState("50");
  const [maxTotalSize, setMaxTotalSize] = useState("500");

  const load = useCallback(() => {
    getSettings()
      .then((s) => {
        setSettings(s.filter((st) => UPLOAD_KEYS.includes(st.key)));
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

  async function handleSaveAll() {
    const keys = Object.keys(edited);
    if (keys.length === 0) return;
    setSaving("all");
    try {
      for (const key of keys) {
        await updateSetting(key, edited[key]);
      }
      toast.success("保存しました");
      setEdited({});
      load();
    } catch {
      toast.error("保存に失敗しました");
    } finally {
      setSaving(null);
    }
  }

  const hasEdits = Object.keys(edited).length > 0;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Upload className="h-4 w-4" />
            アップロード制限
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="min-w-[200px]">
              <label className="text-sm font-medium">最大ファイルサイズ</label>
              <p className="text-xs text-muted-foreground">1ファイルあたりの上限</p>
            </div>
            <Input
              type="number"
              value={maxFileSize}
              onChange={(e) => setMaxFileSize(e.target.value)}
              className="w-32"
              disabled
            />
            <span className="text-sm text-muted-foreground">MB</span>
            <Badge variant="outline" className="ml-2 text-xs">未実装</Badge>
          </div>
          <div className="flex items-center gap-2">
            <div className="min-w-[200px]">
              <label className="text-sm font-medium">最大アップロードサイズ</label>
              <p className="text-xs text-muted-foreground">1回のアップロード合計上限</p>
            </div>
            <Input
              type="number"
              value={maxTotalSize}
              onChange={(e) => setMaxTotalSize(e.target.value)}
              className="w-32"
              disabled
            />
            <span className="text-sm text-muted-foreground">MB</span>
            <Badge variant="outline" className="ml-2 text-xs">未実装</Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4" />
            アップロードデフォルト
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {UPLOAD_KEYS.map((key) => {
            const setting = settings.find((s) => s.key === key);
            return (
              <div key={key} className="flex items-center gap-2">
                <div className="min-w-[200px]">
                  <label className="text-sm font-medium">{key}</label>
                  {setting?.description && (
                    <p className="text-xs text-muted-foreground">{setting.description}</p>
                  )}
                </div>
                <Input
                  placeholder={setting?.placeholder ?? ""}
                  value={getValue(key)}
                  onChange={(e) => handleChange(key, e.target.value)}
                  className={`flex-1 ${key in edited ? "border-orange-400" : ""}`}
                />
              </div>
            );
          })}
          <div className="flex justify-end pt-2 border-t">
            <Button onClick={handleSaveAll} disabled={!hasEdits || saving === "all"}>
              <Save className="h-4 w-4 mr-2" />
              保存
            </Button>
          </div>
        </CardContent>
      </Card>
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
                <select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                  <option value="">ユーザーを選択</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.display_name || u.username}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>対象フォルダ（空 = 制限なし）</Label>
                <select value={form.folder_id} onChange={(e) => setForm({ ...form, folder_id: e.target.value })} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                  <option value="">制限なし</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
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

// ---------------------------------------------------------------------------
// Mail Notification Tab
// ---------------------------------------------------------------------------

const MAIL_PROVIDER_FIELDS: Record<string, { key: string; label: string; secret?: boolean; placeholder?: string }[]> = {
  smtp: [
    { key: "smtp_host", label: "SMTPホスト", placeholder: "smtp.gmail.com" },
    { key: "smtp_port", label: "SMTPポート", placeholder: "587" },
    { key: "smtp_username", label: "SMTPユーザー名", placeholder: "user@gmail.com" },
    { key: "smtp_password", label: "SMTPパスワード", secret: true },
  ],
  sendgrid: [
    { key: "sendgrid_api_key", label: "SendGrid APIキー", secret: true, placeholder: "SG.xxxx" },
  ],
  resend: [
    { key: "resend_api_key", label: "Resend APIキー", secret: true, placeholder: "re_xxxx" },
  ],
  ses: [
    { key: "ses_region", label: "AWS SES リージョン", placeholder: "ap-northeast-1" },
    { key: "ses_access_key", label: "AWS SES アクセスキー", secret: true },
    { key: "ses_secret_key", label: "AWS SES シークレットキー", secret: true },
  ],
};

function MailTab() {
  const [recipients, setRecipients] = useState<MailRecipient[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [newEmail, setNewEmail] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [testSending, setTestSending] = useState(false);

  // Mail provider settings
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [edited, setEdited] = useState<Record<string, string>>({});
  const [savingConfig, setSavingConfig] = useState(false);

  const provider = edited.mail_provider ?? settings.mail_provider ?? "";

  const loadSettings = useCallback(() => {
    getSettings().then((s) => {
      const map: Record<string, string> = {};
      for (const item of s) map[item.key] = item.value;
      setSettings(map);
      setEdited({});
    }).catch(() => toast.error("設定の取得に失敗"));
  }, []);

  const loadRecipients = useCallback(() => {
    getMailRecipients().then(setRecipients).catch(() => toast.error("通知先の取得に失敗"));
  }, []);

  useEffect(() => { loadSettings(); loadRecipients(); }, [loadSettings, loadRecipients]);

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      for (const [key, value] of Object.entries(edited)) {
        await updateSetting(key, value);
      }
      toast.success("メール設定を保存しました");
      // Apply edited values to local state immediately to avoid race with DB commit
      setSettings((prev) => ({ ...prev, ...edited }));
      setEdited({});
    } catch {
      toast.error("保存に失敗しました");
    } finally {
      setSavingConfig(false);
    }
  };

  const handleAdd = async () => {
    if (!newEmail.trim()) return;
    try {
      await addMailRecipient(newEmail.trim());
      setNewEmail("");
      setAddOpen(false);
      loadRecipients();
    } catch {
      toast.error("追加に失敗しました");
    }
  };

  const handleToggle = async (id: string, field: keyof Pick<MailRecipient, "on_login" | "on_create" | "on_update" | "on_delete">, value: boolean) => {
    try {
      const updated = await updateMailRecipient(id, { [field]: value });
      setRecipients((prev) => prev.map((r) => (r.id === id ? updated : r)));
    } catch {
      toast.error("更新に失敗しました");
    }
  };

  const handleDelete = async (id: string) => {
    const r = recipients.find((r) => r.id === id);
    if (!confirm(`${r?.email ?? "この通知先"} を削除しますか？`)) return;
    try {
      await deleteMailRecipient(id);
      setRecipients((prev) => prev.filter((r) => r.id !== id));
    } catch {
      toast.error("削除に失敗しました");
    }
  };

  const handleTest = async () => {
    if (!testEmail.trim()) return;
    setTestSending(true);
    try {
      const res = await sendTestMail(testEmail.trim());
      toast.success(res.message);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "送信に失敗しました");
    } finally {
      setTestSending(false);
    }
  };

  const getVal = (key: string) => edited[key] ?? settings[key] ?? "";
  const setVal = (key: string, value: string) => setEdited((prev) => ({ ...prev, [key]: value }));
  const hasChanges = Object.keys(edited).length > 0;

  const providerFields = MAIL_PROVIDER_FIELDS[provider] ?? [];

  return (
    <div className="space-y-6">
      {/* Provider config */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Settings className="h-4 w-4" />メール送信設定</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-1.5">
            <Label>プロバイダ</Label>
            <select
              value={provider || ""}
              onChange={(e) => setVal("mail_provider", e.target.value)}
              className="h-8 w-60 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="">無効</option>
              <option value="smtp">SMTP</option>
              <option value="sendgrid">SendGrid</option>
              <option value="resend">Resend</option>
              <option value="ses">AWS SES</option>
            </select>
          </div>

          {provider && (
            <>
              <div className="grid gap-1.5">
                <Label>送信元メールアドレス</Label>
                <Input
                  value={getVal("mail_from")}
                  onChange={(e) => setVal("mail_from", e.target.value)}
                  placeholder="noreply@example.com"
                  className="max-w-sm"
                />
              </div>

              {providerFields.map((f) => (
                <div key={f.key} className="grid gap-1.5">
                  <Label>{f.label}</Label>
                  <Input
                    type={f.secret ? "password" : "text"}
                    value={getVal(f.key)}
                    onChange={(e) => setVal(f.key, e.target.value)}
                    placeholder={f.placeholder ?? ""}
                    className="max-w-sm"
                  />
                </div>
              ))}
            </>
          )}

          <div className="flex gap-2 pt-2">
            <Button onClick={handleSaveConfig} disabled={!hasChanges || savingConfig}>
              <Save className="h-4 w-4 mr-1" />{savingConfig ? "保存中..." : "保存"}
            </Button>
            {provider && (
              <>
                <Input
                  placeholder="テスト送信先メールアドレス"
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  className="max-w-60"
                />
                <Button variant="outline" onClick={handleTest} disabled={testSending || !testEmail.trim()}>
                  <Send className="h-4 w-4 mr-1" />{testSending ? "送信中..." : "テスト送信"}
                </Button>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Recipients */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><Mail className="h-4 w-4" />通知先</CardTitle>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />追加
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>メールアドレス</TableHead>
                <TableHead className="text-center w-20">ログイン</TableHead>
                <TableHead className="text-center w-20">新規</TableHead>
                <TableHead className="text-center w-20">更新</TableHead>
                <TableHead className="text-center w-20">削除</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recipients.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">通知先が登録されていません</TableCell></TableRow>
              )}
              {recipients.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-sm">{r.email}</TableCell>
                  <TableCell className="text-center">
                    <input type="checkbox" checked={r.on_login} onChange={(e) => handleToggle(r.id, "on_login", e.target.checked)} className="h-4 w-4 cursor-pointer" />
                  </TableCell>
                  <TableCell className="text-center">
                    <input type="checkbox" checked={r.on_create} onChange={(e) => handleToggle(r.id, "on_create", e.target.checked)} className="h-4 w-4 cursor-pointer" />
                  </TableCell>
                  <TableCell className="text-center">
                    <input type="checkbox" checked={r.on_update} onChange={(e) => handleToggle(r.id, "on_update", e.target.checked)} className="h-4 w-4 cursor-pointer" />
                  </TableCell>
                  <TableCell className="text-center">
                    <input type="checkbox" checked={r.on_delete} onChange={(e) => handleToggle(r.id, "on_delete", e.target.checked)} className="h-4 w-4 cursor-pointer" />
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(r.id)} className="h-8 w-8 text-destructive hover:text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Add dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>通知先を追加</DialogTitle></DialogHeader>
          <div className="py-4">
            <Label>メールアドレス</Label>
            <Input
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="user@example.com"
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>キャンセル</Button>
            <Button onClick={handleAdd} disabled={!newEmail.trim()}>追加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function WebhooksTab() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newFormat, setNewFormat] = useState("json");
  const [newSecret, setNewSecret] = useState("");
  const [testUrl, setTestUrl] = useState("");
  const [testFormat, setTestFormat] = useState("json");
  const [testSecret, setTestSecret] = useState("");
  const [testSending, setTestSending] = useState(false);

  const load = useCallback(() => {
    getWebhooks().then(setEndpoints).catch(() => toast.error("Webhook一覧の取得に失敗"));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newName.trim() || !newUrl.trim()) return;
    try {
      await createWebhook({ name: newName.trim(), url: newUrl.trim(), format: newFormat, secret: newSecret.trim() || null });
      setNewName(""); setNewUrl(""); setNewFormat("json"); setNewSecret("");
      setAddOpen(false);
      load();
    } catch { toast.error("追加に失敗しました"); }
  };

  const handleToggle = async (id: string, field: keyof Pick<WebhookEndpoint, "on_login" | "on_create" | "on_update" | "on_delete" | "enabled">, value: boolean) => {
    try {
      const updated = await updateWebhook(id, { [field]: value });
      setEndpoints((prev) => prev.map((ep) => (ep.id === id ? updated : ep)));
    } catch { toast.error("更新に失敗しました"); }
  };

  const handleDelete = async (id: string) => {
    const ep = endpoints.find((e) => e.id === id);
    if (!confirm(`${ep?.name ?? "このWebhook"} を削除しますか？`)) return;
    try {
      await deleteWebhook(id);
      setEndpoints((prev) => prev.filter((e) => e.id !== id));
    } catch { toast.error("削除に失敗しました"); }
  };

  const handleTest = async () => {
    if (!testUrl.trim()) return;
    setTestSending(true);
    try {
      const res = await sendTestWebhook(testUrl.trim(), testSecret.trim() || null, testFormat);
      toast.success(res.message);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "送信に失敗しました");
    } finally { setTestSending(false); }
  };

  return (
    <div className="space-y-6">
      {/* Test */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Webhook className="h-4 w-4" />テスト送信</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 items-end flex-wrap">
            <div className="flex-1 min-w-[200px] grid gap-1.5">
              <Label>URL</Label>
              <Input value={testUrl} onChange={(e) => setTestUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/..." className="max-w-md" autoComplete="one-time-code" />
            </div>
            <div className="grid gap-1.5">
              <Label>形式</Label>
              <select value={testFormat} onChange={(e) => setTestFormat(e.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm w-32">
                <option value="json">JSON</option>
                <option value="discord">Discord</option>
                <option value="slack">Slack</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label>Secret（任意）</Label>
              <Input type="password" value={testSecret} onChange={(e) => setTestSecret(e.target.value)} placeholder="HMAC署名キー" className="w-48" />
            </div>
            <Button variant="outline" onClick={handleTest} disabled={testSending || !testUrl.trim()}>
              <Send className="h-4 w-4 mr-1" />{testSending ? "送信中..." : "テスト"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Endpoints */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><Webhook className="h-4 w-4" />エンドポイント</CardTitle>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />追加
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>名前</TableHead>
                <TableHead>URL</TableHead>
                <TableHead className="w-20">形式</TableHead>
                <TableHead className="text-center w-16">有効</TableHead>
                <TableHead className="text-center w-20">ログイン</TableHead>
                <TableHead className="text-center w-16">新規</TableHead>
                <TableHead className="text-center w-16">更新</TableHead>
                <TableHead className="text-center w-16">削除</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoints.length === 0 && (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">Webhook が登録されていません</TableCell></TableRow>
              )}
              {endpoints.map((ep) => (
                <TableRow key={ep.id}>
                  <TableCell className="font-medium">{ep.name}</TableCell>
                  <TableCell className="font-mono text-xs max-w-[300px] truncate">{ep.url}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-xs">{{ json: "JSON", discord: "Discord", slack: "Slack" }[ep.format] ?? ep.format}</Badge>
                  </TableCell>
                  <TableCell className="text-center">
                    <input type="checkbox" checked={ep.enabled} onChange={(e) => handleToggle(ep.id, "enabled", e.target.checked)} className="h-4 w-4 cursor-pointer" />
                  </TableCell>
                  <TableCell className="text-center">
                    <input type="checkbox" checked={ep.on_login} onChange={(e) => handleToggle(ep.id, "on_login", e.target.checked)} className="h-4 w-4 cursor-pointer" />
                  </TableCell>
                  <TableCell className="text-center">
                    <input type="checkbox" checked={ep.on_create} onChange={(e) => handleToggle(ep.id, "on_create", e.target.checked)} className="h-4 w-4 cursor-pointer" />
                  </TableCell>
                  <TableCell className="text-center">
                    <input type="checkbox" checked={ep.on_update} onChange={(e) => handleToggle(ep.id, "on_update", e.target.checked)} className="h-4 w-4 cursor-pointer" />
                  </TableCell>
                  <TableCell className="text-center">
                    <input type="checkbox" checked={ep.on_delete} onChange={(e) => handleToggle(ep.id, "on_delete", e.target.checked)} className="h-4 w-4 cursor-pointer" />
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => handleDelete(ep.id)} className="h-8 w-8 text-destructive hover:text-destructive">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Add dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Webhook を追加</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid gap-1.5">
              <Label>名前</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Slack通知" autoComplete="one-time-code" />
            </div>
            <div className="grid gap-1.5">
              <Label>URL</Label>
              <Input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/..." autoComplete="one-time-code" />
            </div>
            <div className="grid gap-1.5">
              <Label>形式</Label>
              <select value={newFormat} onChange={(e) => setNewFormat(e.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm">
                <option value="json">JSON（汎用）</option>
                <option value="discord">Discord</option>
                <option value="slack">Slack</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label>Secret（任意、HMAC-SHA256署名用）</Label>
              <Input type="password" value={newSecret} onChange={(e) => setNewSecret(e.target.value)} placeholder="署名キー" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>キャンセル</Button>
            <Button onClick={handleAdd} disabled={!newName.trim() || !newUrl.trim()}>追加</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

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
// Notes Management Tab
// ---------------------------------------------------------------------------

function NotesTab() {
  const [notes, setNotes] = useState<AdminNoteItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    try {
      setNotes(await adminListNotes());
    } catch {
      toast.error("ノート一覧の取得に失敗しました");
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === notes.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(notes.map((n) => n.id)));
    }
  };

  const handleBulkDelete = async () => {
    if (selected.size === 0) return;
    if (!window.confirm(`${selected.size}件のノートをゴミ箱に移動しますか？`)) return;
    setDeleting(true);
    try {
      const result = await adminBulkDeleteNotes(Array.from(selected));
      toast.success(`${result.deleted}件のノートを削除しました`);
      setSelected(new Set());
      await load();
    } catch {
      toast.error("削除に失敗しました");
    } finally {
      setDeleting(false);
    }
  };

  const fmt = (iso: string) => {
    if (!iso) return "-";
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="flex items-center gap-2">
          <BookOpenText className="h-5 w-5" />ノート管理
        </CardTitle>
        {selected.size > 0 && (
          <Button variant="destructive" size="sm" onClick={handleBulkDelete} disabled={deleting}>
            <Trash2 className="h-4 w-4 mr-1" />{selected.size}件削除
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">ノートはありません</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input type="checkbox" checked={selected.size === notes.length && notes.length > 0} onChange={toggleAll} />
                </TableHead>
                <TableHead>タイトル</TableHead>
                <TableHead>種別</TableHead>
                <TableHead>読み取り専用</TableHead>
                <TableHead>作成日時</TableHead>
                <TableHead>更新日時</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {notes.map((note) => (
                <TableRow key={note.id}>
                  <TableCell>
                    <input type="checkbox" checked={selected.has(note.id)} onChange={() => toggleSelect(note.id)} />
                  </TableCell>
                  <TableCell className="font-medium">{note.title}</TableCell>
                  <TableCell><Badge variant="secondary">{note.file_type}</Badge></TableCell>
                  <TableCell>
                    <Switch
                      checked={note.note_readonly}
                      onCheckedChange={async (checked) => {
                        try {
                          await adminToggleNoteReadonly(note.id, checked);
                          setNotes((prev) => prev.map((n) => n.id === note.id ? { ...n, note_readonly: checked } : n));
                        } catch {
                          toast.error("読み取り専用の切り替えに失敗しました");
                        }
                      }}
                    />
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">{fmt(note.created_at)}</TableCell>
                  <TableCell className="text-muted-foreground text-xs">{fmt(note.updated_at)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Admin Page
// ---------------------------------------------------------------------------

const ADMIN_SECTIONS = [
  { key: "settings", label: "LLM設定", icon: Bot },
  { key: "users", label: "ユーザー", icon: Users },
  { key: "groups", label: "グループ", icon: UsersRound },
  { key: "roles", label: "ロール", icon: Shield },
  { key: "upload", label: "アップロード", icon: Upload },
  { key: "share", label: "共有リンク", icon: Share2 },
  { key: "apikeys", label: "APIキー", icon: Key },
  { key: "audit", label: "監査ログ", icon: ScrollText },
  { key: "mail", label: "メール通知", icon: Mail },
  { key: "notes", label: "ノート", icon: BookOpenText },
  { key: "webhooks", label: "Webhook", icon: Webhook },
] as const;

type SectionKey = (typeof ADMIN_SECTIONS)[number]["key"];

const SECTION_COMPONENTS: Record<SectionKey, React.FC> = {
  settings: SettingsTab,
  users: UsersTab,
  groups: GroupsTab,
  roles: RolesTab,
  upload: UploadTab,
  share: ShareTab,
  apikeys: ApiKeysTab,
  audit: AuditLogsTab,
  mail: MailTab,
  notes: NotesTab,
  webhooks: WebhooksTab,
};

export function AdminPage() {
  const [active, setActive] = useState<SectionKey>(() => {
    const saved = localStorage.getItem("admin_section");
    return ADMIN_SECTIONS.some((s) => s.key === saved) ? (saved as SectionKey) : "settings";
  });
  const ActiveComponent = SECTION_COMPONENTS[active];

  return (
    <div className="h-full flex overflow-hidden">
      {/* Sidebar */}
      <nav className="w-48 shrink-0 border-r bg-muted/30 flex flex-col">
        <h1 className="text-lg font-bold px-4 py-3 border-b">管理</h1>
        <div className="flex-1 overflow-y-auto py-1">
          {ADMIN_SECTIONS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => { setActive(key); localStorage.setItem("admin_section", key); }}
              className={`w-full flex items-center gap-2 px-4 py-2 text-sm text-left transition-colors ${
                active === key
                  ? "bg-accent text-accent-foreground font-medium"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Icon className="w-4 h-4 shrink-0" />
              {label}
            </button>
          ))}
        </div>
      </nav>

      {/* Content */}
      <main className="flex-1 min-w-0 overflow-y-auto p-6">
        <ActiveComponent />
      </main>
    </div>
  );
}

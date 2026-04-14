import { useCallback, useEffect, useRef, useState } from "react";
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
  adminUploadAvatar,
  adminDeleteAvatar,
} from "@/lib/api";
import { AvatarCropper } from "@/components/AvatarCropper";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Plus, Trash2, Settings, Save, Pencil, Users, Key, Copy, Check, Download, Search, ChevronLeft, ChevronRight, Mail, Send, Webhook, BookOpenText, Shield, ScrollText, UsersRound, Share2, Upload, Bot, X, Image } from "lucide-react";
import { toast } from "sonner";
import { t } from "@/i18n";

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

  // Avatar upload state
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [avatarCleared, setAvatarCleared] = useState(false);
  const [cropperFile, setCropperFile] = useState<File | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(() => {
    getUsers().then(setUsers).catch(() => toast.error(t("admin:users.fetchFailed")));
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
    setPendingAvatarFile(null);
    if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
    setAvatarPreviewUrl(null);
    setAvatarCleared(false);
    setCropperFile(null);
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
      toast.success(t("admin:users.created"));
      setCreateOpen(false);
      setCreateForm({ username: "", password: "", email: "", display_name: "", role: "user" });
      load();
    } catch {
      toast.error(t("common:createFailed"));
    }
  }

  async function handleUpdate() {
    if (!editUser) return;
    try {
      // Handle avatar upload/delete
      if (pendingAvatarFile) {
        await adminUploadAvatar(editUser.id, pendingAvatarFile);
        setPendingAvatarFile(null);
        if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
        setAvatarPreviewUrl(null);
        setAvatarCleared(false);
      } else if (avatarCleared) {
        await adminDeleteAvatar(editUser.id);
        setAvatarCleared(false);
      }

      const data: Record<string, unknown> = {};
      if (editForm.username !== editUser.username) data.username = editForm.username;
      if (editForm.email !== editUser.email) data.email = editForm.email;
      if (editForm.display_name !== editUser.display_name) data.display_name = editForm.display_name;
      const currentRole = editUser.roles[0] ?? "";
      if (editForm.role !== currentRole) data.role = editForm.role;
      if (editForm.is_active !== editUser.is_active) data.is_active = editForm.is_active;
      if (editForm.can_share !== editUser.can_share) data.can_share = editForm.can_share;
      if (editForm.can_download !== editUser.can_download) data.can_download = editForm.can_download;
      if (editForm.password) data.password = editForm.password;

      if (Object.keys(data).length > 0) {
        await updateUser(editUser.id, data);
      }
      toast.success(t("admin:users.updated"));
      setEditOpen(false);
      load();
    } catch {
      toast.error(t("common:updateFailed"));
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t("common:confirmDelete"))) return;
    try {
      await deleteUser(id);
      toast.success(t("admin:users.deleted"));
      load();
    } catch {
      toast.error(t("common:deleteFailed"));
    }
  }

  const roleNames = roles.map((r) => r.name);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t("admin:users.title")}</CardTitle>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> {t("common:add")}
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>{t("admin:users.username")}</TableHead>
              <TableHead>{t("admin:users.displayName")}</TableHead>
              <TableHead>{t("admin:users.email")}</TableHead>
              <TableHead>{t("admin:users.role")}</TableHead>
              <TableHead>{t("admin:users.status")}</TableHead>
              <TableHead>{t("admin:users.lastLogin")}</TableHead>
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
                    {u.is_active ? t("admin:users.active") : t("admin:users.inactive")}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground text-xs">
                  {u.last_login_at ? new Date(u.last_login_at).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—"}
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
            <DialogTitle>{t("admin:users.createTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">{t("admin:users.usernameRequired")}</Label>
              <Input value={createForm.username} onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">{t("admin:users.passwordRequired")}</Label>
              <Input type="password" value={createForm.password} onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">{t("admin:users.emailLabel")}</Label>
              <Input value={createForm.email} onChange={(e) => setCreateForm({ ...createForm, email: e.target.value })} placeholder={t("admin:users.emailPlaceholder")} />
            </div>
            <div>
              <Label className="text-xs">{t("admin:users.displayName")}</Label>
              <Input value={createForm.display_name} onChange={(e) => setCreateForm({ ...createForm, display_name: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">{t("admin:users.role")}</Label>
              <select value={createForm.role} onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                {roleNames.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t("common:cancel")}</Button>
            <Button onClick={handleCreate} disabled={!createForm.username || !createForm.password}>{t("common:create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("admin:users.editTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Avatar */}
            <div className="flex items-center gap-4">
              <Avatar className="h-16 w-16">
                {(() => {
                  const src = avatarCleared ? null : (avatarPreviewUrl || editForm.avatar_url || null);
                  return src ? <AvatarImage src={src} alt="" /> : null;
                })()}
                <AvatarFallback className="text-lg bg-primary text-primary-foreground">
                  {(editForm.display_name || editForm.username || "U").charAt(0).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 space-y-1">
                <Label className="text-xs flex items-center gap-1">
                  <Image className="h-3.5 w-3.5" />
                  {t("admin:users.avatar")}
                </Label>
                <div className="flex items-center gap-2">
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/gif,image/webp"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      if (file.size > 2 * 1024 * 1024) {
                        toast.error(t("common:fileSizeLimit"));
                        if (avatarInputRef.current) avatarInputRef.current.value = "";
                        return;
                      }
                      if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type)) {
                        toast.error(t("common:imageTypesOnly"));
                        if (avatarInputRef.current) avatarInputRef.current.value = "";
                        return;
                      }
                      setCropperFile(file);
                      if (avatarInputRef.current) avatarInputRef.current.value = "";
                    }}
                    className="hidden"
                  />
                  <Button type="button" variant="outline" size="sm" onClick={() => avatarInputRef.current?.click()}>
                    {t("common:selectFile")}
                  </Button>
                  {!avatarCleared && (avatarPreviewUrl || editForm.avatar_url) && (
                    <Button type="button" variant="ghost" size="sm" onClick={() => {
                      if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
                      setPendingAvatarFile(null);
                      setAvatarPreviewUrl(null);
                      setAvatarCleared(true);
                    }}>
                      <X className="h-4 w-4 mr-1" />
                      {t("common:clear")}
                    </Button>
                  )}
                  {pendingAvatarFile && <span className="text-xs text-muted-foreground">{t("common:cropped")}</span>}
                </div>
              </div>
            </div>
            {cropperFile && (
              <AvatarCropper
                file={cropperFile}
                onCropped={(blob) => {
                  const file = new File([blob], "avatar.png", { type: "image/png" });
                  if (avatarPreviewUrl) URL.revokeObjectURL(avatarPreviewUrl);
                  setPendingAvatarFile(file);
                  setAvatarPreviewUrl(URL.createObjectURL(blob));
                  setAvatarCleared(false);
                  setCropperFile(null);
                }}
                onCancel={() => setCropperFile(null)}
              />
            )}
            <div>
              <Label className="text-xs">{t("admin:users.username")}</Label>
              <Input value={editForm.username} onChange={(e) => setEditForm({ ...editForm, username: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">{t("admin:users.emailLabel")}</Label>
              <Input value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">{t("admin:users.displayName")}</Label>
              <Input value={editForm.display_name} onChange={(e) => setEditForm({ ...editForm, display_name: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">{t("admin:users.newPassword")}</Label>
              <Input type="password" value={editForm.password} onChange={(e) => setEditForm({ ...editForm, password: e.target.value })} placeholder={t("admin:users.newPasswordPlaceholder")} />
            </div>
            <div>
              <Label className="text-xs">{t("admin:users.role")}</Label>
              <select value={editForm.role} onChange={(e) => setEditForm({ ...editForm, role: e.target.value })} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                {roleNames.map((r) => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">{t("admin:users.accountActive")}</Label>
              <Switch checked={editForm.is_active} onCheckedChange={(v) => setEditForm({ ...editForm, is_active: v })} />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">{t("admin:users.shareAllowed")}</Label>
              <Switch checked={editForm.can_share} onCheckedChange={(v) => setEditForm({ ...editForm, can_share: v })} />
            </div>
            <div className="flex items-center justify-between">
              <Label className="text-sm">{t("admin:users.downloadAllowed")}</Label>
              <Switch checked={editForm.can_download} onCheckedChange={(v) => setEditForm({ ...editForm, can_download: v })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>{t("common:cancel")}</Button>
            <Button onClick={handleUpdate}>{t("common:save")}</Button>
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
    getRoles().then(setRoles).catch(() => toast.error(t("admin:roles.fetchFailed")));
  }, []);

  useEffect(load, [load]);

  async function handleCreate() {
    try {
      await createRole({
        name: form.name,
        permissions: form.permissions.split(",").map((s) => s.trim()).filter(Boolean),
      });
      toast.success(t("admin:roles.created"));
      setDialogOpen(false);
      setForm({ name: "", permissions: "" });
      load();
    } catch {
      toast.error(t("common:createFailed"));
    }
  }

  async function handleDelete(id: number) {
    if (!confirm(t("common:confirmDelete"))) return;
    try {
      await deleteRole(id);
      toast.success(t("common:deleted"));
      load();
    } catch {
      toast.error(t("common:deleteFailed"));
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t("admin:roles.title")}</CardTitle>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> {t("common:add")}
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("admin:roles.roleName")}</TableHead>
              <TableHead>{t("admin:roles.permissions")}</TableHead>
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
            <DialogTitle>{t("admin:roles.createTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder={t("admin:roles.roleName")}
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
            <Input
              placeholder={t("admin:roles.permissionsPlaceholder")}
              value={form.permissions}
              onChange={(e) => setForm({ ...form, permissions: e.target.value })}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              {t("common:cancel")}
            </Button>
            <Button onClick={handleCreate}>{t("common:create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// General Tab
// ---------------------------------------------------------------------------

function GeneralTab() {
  const [lang, setLang] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    getSettings()
      .then((s) => {
        const v = s.find((x) => x.key === "system_language")?.value ?? "ja";
        setLang(v);
        setOriginal(v);
      })
      .catch(() => toast.error(t("admin:settings.fetchFailed")));
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      await updateSetting("system_language", lang);
      setOriginal(lang);
      toast.success(t("admin:settings.saved"));
    } catch {
      toast.error(t("common:saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Settings className="h-4 w-4" />
            {t("admin:settings.systemLanguage")}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">{t("admin:settings.systemLanguageDescription")}</p>
          <div className="flex items-center gap-2">
            <select
              value={lang}
              onChange={(e) => setLang(e.target.value)}
              className="h-9 rounded-md border bg-background px-3 text-sm"
            >
              <option value="ja">{t("common:japanese")}</option>
              <option value="en">{t("common:english")}</option>
            </select>
            <Button
              size="sm"
              onClick={handleSave}
              disabled={lang === original || saving}
            >
              <Save className="h-4 w-4 mr-1" />
              {t("common:save")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings Tab
// ---------------------------------------------------------------------------

const SETTING_GROUPS: Record<string, { labelKey: string; keys: string[] }> = {
  llm: {
    labelKey: "admin:settings.groups.llm",
    keys: ["llm_url", "llm_model", "llm_api_key"],
  },
  embed: {
    labelKey: "admin:settings.groups.embed",
    keys: ["embed_url", "embed_model", "embed_api_key", "embed_dimensions"],
  },
  search: {
    labelKey: "admin:settings.groups.search",
    keys: ["search_top_k", "vector_similarity_threshold", "ai_max_search_rounds"],
  },
  ingest: {
    labelKey: "admin:settings.groups.ingest",
    keys: ["chunk_size", "chunk_overlap"],
  },
  smb: {
    labelKey: "admin:settings.groups.smb",
    keys: ["smb_enabled", "smb_sync_deletes"],
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
      .catch(() => toast.error(t("admin:settings.fetchFailed")));
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
      toast.success(t("admin:settings.saved"));
      setEdited((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      load();
    } catch {
      toast.error(t("common:saveFailed"));
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
      toast.success(t("admin:settings.savedCount", { count: keys.length }));
      setEdited({});
      load();
    } catch {
      toast.error(t("common:saveFailed"));
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
              {t(group.labelKey)}
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
            {t("admin:settings.saveAll", { count: Object.keys(edited).length })}
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
      .catch(() => toast.error(t("admin:settings.fetchFailed")));
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
        toast.success(t("admin:share.connectionOk"));
        load();
        return true;
      } else {
        await updateSetting("share_enabled", "false");
        toast.error(t("admin:share.connectionFailed", { error: result.error }));
        load();
        return false;
      }
    } catch {
      toast.error(t("admin:share.connectionTestFailed"));
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
      toast.success(t("admin:settings.saved"));
      setEdited({});
      load();
    } catch {
      toast.error(t("common:saveFailed"));
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
          {t("admin:share.title")}
        </CardTitle>
        <Button variant="outline" size="sm" onClick={checkShareConnection}>
          {t("admin:share.connectionTest")}
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
            <label className="text-sm font-medium">{t("admin:share.shareFeature")}</label>
            <p className="text-xs text-muted-foreground">{t("admin:share.shareFeatureHint")}</p>
          </div>
          <button
            onClick={async () => {
              if (!isOn) {
                const ok = await checkShareConnection();
                if (!ok) return;
                await updateSetting("share_enabled", "true");
                toast.success(t("admin:share.shareEnabled"));
              } else {
                await updateSetting("share_enabled", "false");
                toast.success(t("admin:share.shareDisabled"));
              }
              load();
            }}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${isOn ? "bg-primary" : "bg-muted"}`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition-transform ${isOn ? "translate-x-6" : "translate-x-1"}`} />
          </button>
          <span className={`text-sm ${isOn ? "text-primary font-medium" : "text-muted-foreground"}`}>
            {isOn ? t("common:enabled") : t("common:disabled")}
          </span>
        </div>
        <div className="flex justify-end pt-2 border-t">
          <Button onClick={handleSaveAll} disabled={!hasEdits || saving === "all"}>
            <Save className="h-4 w-4 mr-2" />
            {t("common:save")}
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
      .catch(() => toast.error(t("admin:settings.fetchFailed")));
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
      toast.success(t("admin:settings.saved"));
      setEdited({});
      load();
    } catch {
      toast.error(t("common:saveFailed"));
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
            {t("admin:uploadSettings.limits")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-2">
            <div className="min-w-[200px]">
              <label className="text-sm font-medium">{t("admin:uploadSettings.maxFileSize")}</label>
              <p className="text-xs text-muted-foreground">{t("admin:uploadSettings.maxFileSizeHint")}</p>
            </div>
            <Input
              type="number"
              value={maxFileSize}
              onChange={(e) => setMaxFileSize(e.target.value)}
              className="w-32"
              disabled
            />
            <span className="text-sm text-muted-foreground">MB</span>
            <Badge variant="outline" className="ml-2 text-xs">{t("admin:uploadSettings.notImplemented")}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <div className="min-w-[200px]">
              <label className="text-sm font-medium">{t("admin:uploadSettings.maxTotalSize")}</label>
              <p className="text-xs text-muted-foreground">{t("admin:uploadSettings.maxTotalSizeHint")}</p>
            </div>
            <Input
              type="number"
              value={maxTotalSize}
              onChange={(e) => setMaxTotalSize(e.target.value)}
              className="w-32"
              disabled
            />
            <span className="text-sm text-muted-foreground">MB</span>
            <Badge variant="outline" className="ml-2 text-xs">{t("admin:uploadSettings.notImplemented")}</Badge>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <Shield className="h-4 w-4" />
            {t("admin:uploadSettings.defaults")}
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
              {t("common:save")}
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
    getGroups().then(setGroups).catch(() => toast.error(t("admin:groups.fetchFailed")));
    getUsers().then(setUsers).catch(() => {});
  }, []);

  useEffect(load, [load]);

  async function handleCreate() {
    try {
      await createGroup({
        name: createForm.name,
        description: createForm.description || undefined,
      });
      toast.success(t("admin:groups.created"));
      setCreateOpen(false);
      setCreateForm({ name: "", description: "" });
      load();
    } catch {
      toast.error(t("common:createFailed"));
    }
  }

  async function handleDelete(id: string) {
    if (!confirm(t("admin:groups.deleteConfirm"))) return;
    try {
      await deleteGroup(id);
      toast.success(t("common:deleted"));
      load();
    } catch {
      toast.error(t("common:deleteFailed"));
    }
  }

  async function openMembers(g: Group) {
    setSelectedGroup(g);
    setMembersOpen(true);
    try {
      const m = await getGroupMembers(g.id);
      setMembers(m);
    } catch {
      toast.error(t("admin:groups.membersFetchFailed"));
    }
  }

  async function handleAddMember() {
    if (!selectedGroup || !addUserId) return;
    try {
      await addGroupMember(selectedGroup.id, addUserId);
      toast.success(t("admin:groups.memberAdded"));
      setAddUserId("");
      const m = await getGroupMembers(selectedGroup.id);
      setMembers(m);
      load();
    } catch {
      toast.error(t("common:createFailed"));
    }
  }

  async function handleRemoveMember(userId: string) {
    if (!selectedGroup) return;
    try {
      await removeGroupMember(selectedGroup.id, userId);
      toast.success(t("admin:groups.memberRemoved"));
      const m = await getGroupMembers(selectedGroup.id);
      setMembers(m);
      load();
    } catch {
      toast.error(t("common:deleteFailed"));
    }
  }

  const availableUsers = users.filter((u) => !members.find((m) => m.user_id === u.id));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t("admin:groups.title")}</CardTitle>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> {t("common:add")}
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("admin:groups.groupName")}</TableHead>
              <TableHead>{t("admin:groups.description")}</TableHead>
              <TableHead className="w-24 text-center">{t("admin:groups.memberCount")}</TableHead>
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
            <DialogTitle>{t("admin:groups.createTitle")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs">{t("admin:groups.groupNameRequired")}</Label>
              <Input value={createForm.name} onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })} />
            </div>
            <div>
              <Label className="text-xs">{t("admin:groups.description")}</Label>
              <Input value={createForm.description} onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>{t("common:cancel")}</Button>
            <Button onClick={handleCreate} disabled={!createForm.name.trim()}>{t("common:create")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Members dialog */}
      <Dialog open={membersOpen} onOpenChange={setMembersOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("admin:groups.memberManagement", { name: selectedGroup?.name ?? "" })}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {members.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("admin:users.username")}</TableHead>
                    <TableHead>{t("admin:users.displayName")}</TableHead>
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
              <p className="text-sm text-muted-foreground">{t("admin:groups.noMembers")}</p>
            )}
            {availableUsers.length > 0 && (
              <div className="flex items-center gap-2">
                <select
                  value={addUserId}
                  onChange={(e) => setAddUserId(e.target.value)}
                  className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
                >
                  <option value="">{t("admin:groups.addUser")}</option>
                  {availableUsers.map((u) => (
                    <option key={u.id} value={u.id}>{u.username} ({u.display_name || u.email})</option>
                  ))}
                </select>
                <Button size="sm" onClick={handleAddMember} disabled={!addUserId}>{t("common:add")}</Button>
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
    getApiKeys().then(setKeys).catch(() => toast.error(t("common:fetchFailed")));
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
      toast.error(t("common:createFailed"));
    }
  };

  const handleToggleActive = async (key: ApiKeyInfo) => {
    try {
      await updateApiKey(key.id, { is_active: !key.is_active });
      load();
    } catch {
      toast.error(t("common:updateFailed"));
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteApiKey(id);
      load();
    } catch {
      toast.error(t("common:deleteFailed"));
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
        <CardTitle className="flex items-center gap-2"><Key className="h-5 w-5" />{t("admin:apiKeys.title")}</CardTitle>
        <Button size="sm" onClick={() => { resetForm(); setCreateOpen(true); }}><Plus className="h-4 w-4 mr-1" />{t("admin:apiKeys.newKey")}</Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("admin:apiKeys.name")}</TableHead>
              <TableHead>{t("admin:apiKeys.prefix")}</TableHead>
              <TableHead>{t("admin:apiKeys.user")}</TableHead>
              <TableHead>{t("admin:apiKeys.folder")}</TableHead>
              <TableHead>{t("admin:apiKeys.permissions")}</TableHead>
              <TableHead>{t("admin:apiKeys.overwrite")}</TableHead>
              <TableHead>{t("admin:apiKeys.active")}</TableHead>
              <TableHead>{t("admin:apiKeys.lastUsed")}</TableHead>
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
                  {k.last_used_at ? new Date(k.last_used_at).toLocaleDateString("ja-JP") : t("admin:apiKeys.unused")}
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" onClick={() => handleDelete(k.id)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {keys.length === 0 && (
              <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground">{t("admin:apiKeys.noKeys")}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      {/* API Manual */}
      <CardContent className="border-t pt-4">
        <details>
          <summary className="cursor-pointer text-sm font-medium text-muted-foreground hover:text-foreground">{t("admin:apiKeys.apiReference")}</summary>
          <div className="mt-3 space-y-4 text-sm">
            <div>
              <h4 className="font-medium mb-1">{t("admin:apiKeys.fileUpload")}</h4>
              <pre className="bg-muted rounded p-3 text-xs overflow-x-auto whitespace-pre">{`curl -X POST /api/ingest/upload \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -F "file=@document.pdf" \\
  -F "folder_id=FOLDER_UUID"  # ${t("admin:apiKeys.apiManual.optional")}`}</pre>
            </div>
            <div>
              <h4 className="font-medium mb-1">{t("admin:apiKeys.textIngest")}</h4>
              <pre className="bg-muted rounded p-3 text-xs overflow-x-auto whitespace-pre">{`curl -X POST /api/ingest/content \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "title": "${t("admin:apiKeys.apiManual.exTitle")}",
    "content": "${t("admin:apiKeys.apiManual.exContent")}",
    "source": "jira",
    "external_id": "PROJ-1234",
    "external_url": "https://...",
    "folder": "${t("admin:apiKeys.apiManual.exFolder")}",
    "tags": ["tag1", "tag2"],
    "memo": "${t("admin:apiKeys.apiManual.exMemo")}",
    "mode": "append",
    "version": true
  }'`}</pre>
              <p className="mt-1 text-xs text-muted-foreground">
                {t("admin:apiKeys.apiManual.upsertNote")}
              </p>
              <table className="mt-2 w-full text-xs text-muted-foreground border-collapse">
                <thead>
                  <tr className="border-b">
                    <th className="text-left py-1 pr-2 font-medium">{t("admin:apiKeys.apiManual.parameter")}</th>
                    <th className="text-left py-1 pr-2 font-medium">{t("admin:apiKeys.apiManual.required")}</th>
                    <th className="text-left py-1 font-medium">{t("admin:apiKeys.apiManual.descriptionHeader")}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b"><td className="py-1 pr-2"><code>title</code></td><td className="py-1 pr-2">○</td><td className="py-1">{t("admin:apiKeys.apiManual.titleDesc")}</td></tr>
                  <tr className="border-b"><td className="py-1 pr-2"><code>content</code></td><td className="py-1 pr-2">○</td><td className="py-1">{t("admin:apiKeys.apiManual.contentDesc")}</td></tr>
                  <tr className="border-b"><td className="py-1 pr-2"><code>source</code></td><td className="py-1 pr-2">○</td><td className="py-1">{t("admin:apiKeys.apiManual.sourceDesc")}</td></tr>
                  <tr className="border-b"><td className="py-1 pr-2"><code>external_id</code></td><td className="py-1 pr-2"></td><td className="py-1">{t("admin:apiKeys.apiManual.externalIdDesc")}</td></tr>
                  <tr className="border-b"><td className="py-1 pr-2"><code>external_url</code></td><td className="py-1 pr-2"></td><td className="py-1">{t("admin:apiKeys.apiManual.externalUrlDesc")}</td></tr>
                  <tr className="border-b"><td className="py-1 pr-2"><code>folder</code></td><td className="py-1 pr-2"></td><td className="py-1">{t("admin:apiKeys.apiManual.folderDesc")}</td></tr>
                  <tr className="border-b"><td className="py-1 pr-2"><code>tags</code></td><td className="py-1 pr-2"></td><td className="py-1">{t("admin:apiKeys.apiManual.tagsDesc")}</td></tr>
                  <tr className="border-b"><td className="py-1 pr-2"><code>memo</code></td><td className="py-1 pr-2"></td><td className="py-1">{t("admin:apiKeys.apiManual.memoDesc")}</td></tr>
                  <tr className="border-b"><td className="py-1 pr-2"><code>mode</code></td><td className="py-1 pr-2"></td><td className="py-1">{t("admin:apiKeys.apiManual.modeDesc")}</td></tr>
                  <tr><td className="py-1 pr-2"><code>version</code></td><td className="py-1 pr-2"></td><td className="py-1">{t("admin:apiKeys.apiManual.versionDesc")}</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <h4 className="font-medium mb-1">{t("admin:apiKeys.others")}</h4>
              <ul className="list-disc list-inside text-xs text-muted-foreground space-y-1">
                <li><code>GET /api/ingest/status/&#123;id&#125;</code> — {t("admin:apiKeys.apiManual.statusCheck")}</li>
                <li><code>DELETE /api/ingest/&#123;id&#125;</code> — {t("admin:apiKeys.apiManual.deleteDoc")}</li>
                <li><code>GET /api/ingest/list</code> — {t("admin:apiKeys.apiManual.listDocs")}</li>
              </ul>
            </div>
          </div>
        </details>
      </CardContent>

      {/* Create / Show Key Dialog */}
      <Dialog open={createOpen} onOpenChange={(open) => { if (!open) { setCreateOpen(false); setCreatedKey(null); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{createdKey ? t("admin:apiKeys.keyCreated") : t("admin:apiKeys.createKey")}</DialogTitle>
          </DialogHeader>

          {createdKey ? (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">{t("admin:apiKeys.keyWarning")}</p>
              <div className="flex items-center gap-2">
                <code className="flex-1 break-all rounded bg-muted p-3 text-sm">{createdKey}</code>
                <Button variant="outline" size="sm" onClick={handleCopy}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
              <DialogFooter>
                <Button onClick={() => { setCreateOpen(false); setCreatedKey(null); }}>{t("common:close")}</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{t("admin:apiKeys.name")}</Label>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("admin:apiKeys.namePlaceholder")} />
              </div>
              <div className="space-y-2">
                <Label>{t("admin:apiKeys.operationUser")}</Label>
                <select value={form.owner_id} onChange={(e) => setForm({ ...form, owner_id: e.target.value })} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                  <option value="">{t("admin:apiKeys.selectUser")}</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>{u.display_name || u.username}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>{t("admin:apiKeys.targetFolder")}</Label>
                <select value={form.folder_id} onChange={(e) => setForm({ ...form, folder_id: e.target.value })} className="h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
                  <option value="">{t("admin:apiKeys.noRestriction")}</option>
                  {folders.map((f) => (
                    <option key={f.id} value={f.id}>{f.name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label>{t("admin:apiKeys.permissions")}</Label>
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
                <Label>{t("admin:apiKeys.allowOverwrite")}</Label>
              </div>
              <div className="space-y-2">
                <Label>{t("admin:apiKeys.expiryLabel")}</Label>
                <Input type="date" value={form.expires_at} onChange={(e) => setForm({ ...form, expires_at: e.target.value })} />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>{t("common:cancel")}</Button>
                <Button onClick={handleCreate} disabled={!form.name || !form.owner_id}>{t("common:create")}</Button>
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
  login: t("admin:auditLogs.actions.login"),
  "login.failed": t("admin:auditLogs.actions.login.failed"),
  logout: t("admin:auditLogs.actions.logout"),
  "document.upload": t("admin:auditLogs.actions.document.upload"),
  "document.create": t("admin:auditLogs.actions.document.create"),
  "document.update": t("admin:auditLogs.actions.document.update"),
  "document.delete": t("admin:auditLogs.actions.document.delete"),
  "document.purge": t("admin:auditLogs.actions.document.purge"),
  "document.restore": t("admin:auditLogs.actions.document.restore"),
  "document.overwrite": t("admin:auditLogs.actions.document.overwrite"),
  "document.ingest_content": t("admin:auditLogs.actions.document.ingest_content"),
  "document.ingest_content_update": t("admin:auditLogs.actions.document.ingest_content_update"),
};

// ---------------------------------------------------------------------------
// Mail Notification Tab
// ---------------------------------------------------------------------------

const MAIL_PROVIDER_FIELDS: Record<string, { key: string; label: string; secret?: boolean; placeholder?: string }[]> = {
  smtp: [
    { key: "smtp_host", label: t("admin:mail.smtp.host"), placeholder: "smtp.gmail.com" },
    { key: "smtp_port", label: t("admin:mail.smtp.port"), placeholder: "587" },
    { key: "smtp_username", label: t("admin:mail.smtp.username"), placeholder: "user@gmail.com" },
    { key: "smtp_password", label: t("admin:mail.smtp.password"), secret: true },
  ],
  sendgrid: [
    { key: "sendgrid_api_key", label: t("admin:mail.sendgrid.apiKey"), secret: true, placeholder: "SG.xxxx" },
  ],
  resend: [
    { key: "resend_api_key", label: t("admin:mail.resend.apiKey"), secret: true, placeholder: "re_xxxx" },
  ],
  ses: [
    { key: "ses_region", label: t("admin:mail.ses.region"), placeholder: "ap-northeast-1" },
    { key: "ses_access_key", label: t("admin:mail.ses.accessKey"), secret: true },
    { key: "ses_secret_key", label: t("admin:mail.ses.secretKey"), secret: true },
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
    }).catch(() => toast.error(t("admin:settings.fetchFailed")));
  }, []);

  const loadRecipients = useCallback(() => {
    getMailRecipients().then(setRecipients).catch(() => toast.error(t("admin:mail.recipientsFetchFailed")));
  }, []);

  useEffect(() => { loadSettings(); loadRecipients(); }, [loadSettings, loadRecipients]);

  const handleSaveConfig = async () => {
    setSavingConfig(true);
    try {
      for (const [key, value] of Object.entries(edited)) {
        await updateSetting(key, value);
      }
      toast.success(t("admin:mail.configSaved"));
      // Apply edited values to local state immediately to avoid race with DB commit
      setSettings((prev) => ({ ...prev, ...edited }));
      setEdited({});
    } catch {
      toast.error(t("common:saveFailed"));
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
      toast.error(t("common:createFailed"));
    }
  };

  const handleToggle = async (id: string, field: keyof Pick<MailRecipient, "on_login" | "on_create" | "on_update" | "on_delete">, value: boolean) => {
    try {
      const updated = await updateMailRecipient(id, { [field]: value });
      setRecipients((prev) => prev.map((r) => (r.id === id ? updated : r)));
    } catch {
      toast.error(t("common:updateFailed"));
    }
  };

  const handleDelete = async (id: string) => {
    const r = recipients.find((r) => r.id === id);
    if (!confirm(t("admin:mail.deleteRecipientConfirm", { email: r?.email ?? "" }))) return;
    try {
      await deleteMailRecipient(id);
      setRecipients((prev) => prev.filter((r) => r.id !== id));
    } catch {
      toast.error(t("common:deleteFailed"));
    }
  };

  const handleTest = async () => {
    if (!testEmail.trim()) return;
    setTestSending(true);
    try {
      const res = await sendTestMail(testEmail.trim());
      toast.success(res.message);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t("admin:mail.sendFailed"));
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
          <CardTitle className="text-base flex items-center gap-2"><Settings className="h-4 w-4" />{t("admin:mail.configTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-1.5">
            <Label>{t("admin:mail.provider")}</Label>
            <select
              value={provider || ""}
              onChange={(e) => setVal("mail_provider", e.target.value)}
              className="h-8 w-60 rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <option value="">{t("admin:mail.providerDisabled")}</option>
              <option value="smtp">SMTP</option>
              <option value="sendgrid">SendGrid</option>
              <option value="resend">Resend</option>
              <option value="ses">AWS SES</option>
            </select>
          </div>

          {provider && (
            <>
              <div className="grid gap-1.5">
                <Label>{t("admin:mail.fromAddress")}</Label>
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
              <Save className="h-4 w-4 mr-1" />{savingConfig ? t("common:saving") : t("common:save")}
            </Button>
            {provider && (
              <>
                <Input
                  placeholder={t("admin:mail.testEmailPlaceholder")}
                  value={testEmail}
                  onChange={(e) => setTestEmail(e.target.value)}
                  className="max-w-60"
                />
                <Button variant="outline" onClick={handleTest} disabled={testSending || !testEmail.trim()}>
                  <Send className="h-4 w-4 mr-1" />{testSending ? t("admin:mail.sending") : t("admin:mail.testSend")}
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
            <CardTitle className="text-base flex items-center gap-2"><Mail className="h-4 w-4" />{t("admin:mail.recipientsTitle")}</CardTitle>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />{t("common:add")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin:mail.emailAddress")}</TableHead>
                <TableHead className="text-center w-20">{t("admin:mail.onLogin")}</TableHead>
                <TableHead className="text-center w-20">{t("admin:mail.onCreate")}</TableHead>
                <TableHead className="text-center w-20">{t("admin:mail.onUpdate")}</TableHead>
                <TableHead className="text-center w-20">{t("admin:mail.onDelete")}</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {recipients.length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-8">{t("admin:mail.noRecipients")}</TableCell></TableRow>
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
          <DialogHeader><DialogTitle>{t("admin:mail.addRecipient")}</DialogTitle></DialogHeader>
          <div className="py-4">
            <Label>{t("admin:mail.emailInput")}</Label>
            <Input
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="user@example.com"
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>{t("common:cancel")}</Button>
            <Button onClick={handleAdd} disabled={!newEmail.trim()}>{t("common:add")}</Button>
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
    getWebhooks().then(setEndpoints).catch(() => toast.error(t("admin:webhooks.fetchFailed")));
  }, []);

  useEffect(() => { load(); }, [load]);

  const handleAdd = async () => {
    if (!newName.trim() || !newUrl.trim()) return;
    try {
      await createWebhook({ name: newName.trim(), url: newUrl.trim(), format: newFormat, secret: newSecret.trim() || null });
      setNewName(""); setNewUrl(""); setNewFormat("json"); setNewSecret("");
      setAddOpen(false);
      load();
    } catch { toast.error(t("common:createFailed")); }
  };

  const handleToggle = async (id: string, field: keyof Pick<WebhookEndpoint, "on_login" | "on_create" | "on_update" | "on_delete" | "enabled">, value: boolean) => {
    try {
      const updated = await updateWebhook(id, { [field]: value });
      setEndpoints((prev) => prev.map((ep) => (ep.id === id ? updated : ep)));
    } catch { toast.error(t("common:updateFailed")); }
  };

  const handleDelete = async (id: string) => {
    const ep = endpoints.find((e) => e.id === id);
    if (!confirm(t("admin:webhooks.deleteConfirm", { name: ep?.name ?? "" }))) return;
    try {
      await deleteWebhook(id);
      setEndpoints((prev) => prev.filter((e) => e.id !== id));
    } catch { toast.error(t("common:deleteFailed")); }
  };

  const handleTest = async () => {
    if (!testUrl.trim()) return;
    setTestSending(true);
    try {
      const res = await sendTestWebhook(testUrl.trim(), testSecret.trim() || null, testFormat);
      toast.success(res.message);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : t("admin:mail.sendFailed"));
    } finally { setTestSending(false); }
  };

  return (
    <div className="space-y-6">
      {/* Test */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2"><Webhook className="h-4 w-4" />{t("admin:webhooks.testTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex gap-2 items-end flex-wrap">
            <div className="flex-1 min-w-[200px] grid gap-1.5">
              <Label>URL</Label>
              <Input value={testUrl} onChange={(e) => setTestUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/..." className="max-w-md" autoComplete="one-time-code" />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("admin:webhooks.format")}</Label>
              <select value={testFormat} onChange={(e) => setTestFormat(e.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm w-32">
                <option value="json">JSON</option>
                <option value="discord">Discord</option>
                <option value="slack">Slack</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label>{t("admin:webhooks.secret")}</Label>
              <Input type="password" value={testSecret} onChange={(e) => setTestSecret(e.target.value)} placeholder={t("admin:webhooks.hmacPlaceholder")} className="w-48" />
            </div>
            <Button variant="outline" onClick={handleTest} disabled={testSending || !testUrl.trim()}>
              <Send className="h-4 w-4 mr-1" />{testSending ? t("admin:webhooks.testing") : t("admin:webhooks.test")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Endpoints */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2"><Webhook className="h-4 w-4" />{t("admin:webhooks.endpointsTitle")}</CardTitle>
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="h-4 w-4 mr-1" />{t("common:add")}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin:apiKeys.name")}</TableHead>
                <TableHead>URL</TableHead>
                <TableHead className="w-20">{t("admin:webhooks.format")}</TableHead>
                <TableHead className="text-center w-16">{t("admin:apiKeys.active")}</TableHead>
                <TableHead className="text-center w-20">{t("admin:mail.onLogin")}</TableHead>
                <TableHead className="text-center w-16">{t("admin:mail.onCreate")}</TableHead>
                <TableHead className="text-center w-16">{t("admin:mail.onUpdate")}</TableHead>
                <TableHead className="text-center w-16">{t("admin:mail.onDelete")}</TableHead>
                <TableHead className="w-12"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoints.length === 0 && (
                <TableRow><TableCell colSpan={9} className="text-center text-muted-foreground py-8">{t("admin:webhooks.noWebhooks")}</TableCell></TableRow>
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
          <DialogHeader><DialogTitle>{t("admin:webhooks.createTitle")}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid gap-1.5">
              <Label>{t("admin:apiKeys.name")}</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Slack通知" autoComplete="one-time-code" />
            </div>
            <div className="grid gap-1.5">
              <Label>URL</Label>
              <Input value={newUrl} onChange={(e) => setNewUrl(e.target.value)} placeholder="https://discord.com/api/webhooks/..." autoComplete="one-time-code" />
            </div>
            <div className="grid gap-1.5">
              <Label>{t("admin:webhooks.format")}</Label>
              <select value={newFormat} onChange={(e) => setNewFormat(e.target.value)} className="h-9 rounded-md border bg-background px-3 text-sm">
                <option value="json">{t("admin:webhooks.formatJson")}</option>
                <option value="discord">Discord</option>
                <option value="slack">Slack</option>
              </select>
            </div>
            <div className="grid gap-1.5">
              <Label>{t("admin:webhooks.signSecretLabel")}</Label>
              <Input type="password" value={newSecret} onChange={(e) => setNewSecret(e.target.value)} placeholder={t("admin:webhooks.signKeyPlaceholder")} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)}>{t("common:cancel")}</Button>
            <Button onClick={handleAdd} disabled={!newName.trim() || !newUrl.trim()}>{t("common:add")}</Button>
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
      toast.error(t("common:fetchFailed"));
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
      toast.error(t("common:failed"));
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">{t("admin:auditLogs.title")}</CardTitle>
        <Button size="sm" variant="outline" onClick={handleExport}>
          <Download className="h-4 w-4 mr-1" /> {t("admin:auditLogs.exportCsv")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Filters */}
        <div className="flex flex-wrap gap-2 items-end">
          <div className="w-40">
            <label className="text-xs text-muted-foreground">{t("admin:auditLogs.actionFilter")}</label>
            <select
              value={filterAction}
              onChange={(e) => { setFilterAction(e.target.value); setPage(1); }}
              className="w-full h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">{t("admin:auditLogs.allFilter")}</option>
              {actions.map((a) => (
                <option key={a} value={a}>{ACTION_LABELS[a] || a}</option>
              ))}
            </select>
          </div>
          <div className="w-36">
            <label className="text-xs text-muted-foreground">{t("admin:auditLogs.startDate")}</label>
            <Input type="date" value={filterDateFrom} onChange={(e) => { setFilterDateFrom(e.target.value); setPage(1); }} className="h-9" />
          </div>
          <div className="w-36">
            <label className="text-xs text-muted-foreground">{t("admin:auditLogs.endDate")}</label>
            <Input type="date" value={filterDateTo} onChange={(e) => { setFilterDateTo(e.target.value); setPage(1); }} className="h-9" />
          </div>
          <div className="flex-1 min-w-[160px]">
            <label className="text-xs text-muted-foreground">{t("admin:auditLogs.searchLabel")}</label>
            <div className="flex gap-1">
              <Input
                placeholder={t("admin:auditLogs.searchPlaceholder")}
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
                <TableHead className="w-40">{t("admin:auditLogs.dateTime")}</TableHead>
                <TableHead className="w-28">{t("admin:auditLogs.user")}</TableHead>
                <TableHead className="w-36">{t("admin:auditLogs.action")}</TableHead>
                <TableHead>{t("admin:auditLogs.target")}</TableHead>
                <TableHead className="w-28">IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">{t("common:loading")}</TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">{t("admin:auditLogs.noLogs")}</TableCell>
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
            <span>{t("admin:auditLogs.pagination", { total, from: (page - 1) * perPage + 1, to: Math.min(page * perPage, total) })}</span>
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
      toast.error(t("admin:notes.fetchFailed"));
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
    if (!window.confirm(t("admin:notes.deleteCountConfirm", { count: selected.size }))) return;
    setDeleting(true);
    try {
      const result = await adminBulkDeleteNotes(Array.from(selected));
      toast.success(t("admin:notes.deleted", { count: result.deleted }));
      setSelected(new Set());
      await load();
    } catch {
      toast.error(t("common:deleteFailed"));
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
          <BookOpenText className="h-5 w-5" />{t("admin:notes.title")}
        </CardTitle>
        {selected.size > 0 && (
          <Button variant="destructive" size="sm" onClick={handleBulkDelete} disabled={deleting}>
            <Trash2 className="h-4 w-4 mr-1" />{t("admin:notes.deleteCount", { count: selected.size })}
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {notes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("admin:notes.noNotes")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input type="checkbox" checked={selected.size === notes.length && notes.length > 0} onChange={toggleAll} />
                </TableHead>
                <TableHead>{t("admin:notes.noteTitle")}</TableHead>
                <TableHead>{t("admin:notes.type")}</TableHead>
                <TableHead>{t("admin:notes.readonlyLabel")}</TableHead>
                <TableHead>{t("admin:notes.createdAt")}</TableHead>
                <TableHead>{t("admin:notes.updatedAt")}</TableHead>
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
                          toast.error(t("admin:notes.readonlyToggleFailed"));
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
  { key: "general", label: t("admin:tabs.general"), icon: Settings },
  { key: "settings", label: t("admin:tabs.settings"), icon: Bot },
  { key: "users", label: t("admin:tabs.users"), icon: Users },
  { key: "groups", label: t("admin:tabs.groups"), icon: UsersRound },
  { key: "roles", label: t("admin:tabs.roles"), icon: Shield },
  { key: "upload", label: t("admin:tabs.upload"), icon: Upload },
  { key: "share", label: t("admin:tabs.share"), icon: Share2 },
  { key: "apikeys", label: t("admin:tabs.apiKeys"), icon: Key },
  { key: "audit", label: t("admin:tabs.auditLogs"), icon: ScrollText },
  { key: "mail", label: t("admin:tabs.mail"), icon: Mail },
  { key: "notes", label: t("admin:tabs.notes"), icon: BookOpenText },
  { key: "webhooks", label: t("admin:tabs.webhooks"), icon: Webhook },
];

type SectionKey = "general" | "settings" | "users" | "groups" | "roles" | "upload" | "share" | "apikeys" | "audit" | "mail" | "notes" | "webhooks";

const SECTION_COMPONENTS: Record<SectionKey, React.FC> = {
  general: GeneralTab,
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
    return ADMIN_SECTIONS.some((s) => s.key === saved) ? (saved as SectionKey) : "general";
  });
  const ActiveComponent = SECTION_COMPONENTS[active];

  return (
    <div className="h-full flex overflow-hidden">
      {/* Sidebar */}
      <nav className="w-48 shrink-0 border-r bg-muted/30 flex flex-col">
        <h1 className="text-lg font-bold px-4 py-3 border-b">{t("admin:title")}</h1>
        <div className="flex-1 overflow-y-auto py-1">
          {ADMIN_SECTIONS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => { setActive(key as SectionKey); localStorage.setItem("admin_section", key); }}
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

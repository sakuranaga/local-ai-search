import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { getMe, updateProfile, uploadAvatar, deleteAvatar, changePassword, type User } from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { AvatarCropper } from "@/components/AvatarCropper";
import { User as UserIcon, Mail, Lock, Image, X } from "lucide-react";

export function UserSettingsPage() {
  const [user, setUser] = useState<User | null>(null);

  // Profile form
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);

  // Avatar state
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [avatarCleared, setAvatarCleared] = useState(false);
  const [cropperFile, setCropperFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Password form
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);

  useEffect(() => {
    getMe().then((u) => {
      setUser(u);
      setDisplayName(u.display_name || "");
      setEmail(u.email || "");
    });
  }, []);

  // Clean up object URL on unmount or change
  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      toast.error("ファイルサイズは2MB以下にしてください");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    if (!["image/jpeg", "image/png", "image/gif", "image/webp"].includes(file.type)) {
      toast.error("JPEG, PNG, GIF, WebPのみ対応しています");
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }

    // Open cropper
    setCropperFile(file);
    if (fileInputRef.current) fileInputRef.current.value = "";
  }

  function handleCropped(blob: Blob) {
    const file = new File([blob], "avatar.png", { type: "image/png" });
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingFile(file);
    setPreviewUrl(URL.createObjectURL(blob));
    setAvatarCleared(false);
    setCropperFile(null);
  }

  function handleAvatarClear() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPendingFile(null);
    setPreviewUrl(null);
    setAvatarCleared(true);
  }

  // The avatar src to show in preview
  const displayAvatarSrc = avatarCleared ? null : (previewUrl || user?.avatar_url || null);

  async function handleProfileSave() {
    setProfileSaving(true);
    try {
      let updated: User | null = null;

      // Handle avatar upload/delete first
      if (pendingFile) {
        updated = await uploadAvatar(pendingFile);
        setPendingFile(null);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        setPreviewUrl(null);
        setAvatarCleared(false);
      } else if (avatarCleared) {
        updated = await deleteAvatar();
        setAvatarCleared(false);
      }

      // Update other profile fields
      updated = await updateProfile({
        display_name: displayName,
        email,
      });
      setUser(updated);
      window.dispatchEvent(new Event("profile-updated"));
      toast.success("プロフィールを更新しました");
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("409")) {
        toast.error("このメールアドレスは既に使用されています");
      } else {
        toast.error("更新に失敗しました");
      }
    } finally {
      setProfileSaving(false);
    }
  }

  async function handlePasswordChange() {
    if (newPassword !== confirmPassword) {
      toast.error("新しいパスワードが一致しません");
      return;
    }
    if (newPassword.length < 4) {
      toast.error("パスワードは4文字以上で入力してください");
      return;
    }
    setPasswordSaving(true);
    try {
      await changePassword({
        current_password: currentPassword,
        new_password: newPassword,
      });
      toast.success("パスワードを変更しました");
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (e: any) {
      const msg = e?.message || "";
      if (msg.includes("400")) {
        toast.error("現在のパスワードが正しくありません");
      } else {
        toast.error("パスワード変更に失敗しました");
      }
    } finally {
      setPasswordSaving(false);
    }
  }

  if (!user) return null;

  return (
    <div className="max-w-2xl mx-auto p-4 md:p-8 space-y-6">
      <h1 className="text-2xl font-bold">ユーザー設定</h1>

      {/* Profile Section */}
      <Card className="p-6 space-y-5">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <UserIcon className="h-5 w-5" />
          プロフィール
        </h2>

        <div className="flex items-center gap-4">
          <Avatar className="h-16 w-16">
            {displayAvatarSrc && <AvatarImage src={displayAvatarSrc} alt="" />}
            <AvatarFallback className="text-lg bg-primary text-primary-foreground">
              {(displayName || user.username || "U").charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="text-sm text-muted-foreground">
            <div className="font-medium text-foreground">{user.username}</div>
            <div>{user.roles.join(", ")}</div>
          </div>
        </div>

        <Separator />

        {/* Avatar cropper overlay */}
        {cropperFile ? (
          <AvatarCropper
            file={cropperFile}
            onCropped={handleCropped}
            onCancel={() => setCropperFile(null)}
          />
        ) : (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="displayName" className="flex items-center gap-1.5">
              <UserIcon className="h-3.5 w-3.5" />
              表示名
            </Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => {
                if ([...e.target.value].length <= 8) setDisplayName(e.target.value);
              }}
              placeholder="表示名を入力（8文字以内）"
              maxLength={24}
            />
            <p className="text-xs text-muted-foreground">{[...displayName].length}/8文字</p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="email" className="flex items-center gap-1.5">
              <Mail className="h-3.5 w-3.5" />
              メールアドレス
            </Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="メールアドレスを入力"
            />
          </div>

          <div className="space-y-2">
            <Label className="flex items-center gap-1.5">
              <Image className="h-3.5 w-3.5" />
              アイコン
            </Label>
            <div className="flex items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                onChange={handleFileSelect}
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
              >
                ファイルを選択
              </Button>
              {displayAvatarSrc && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={handleAvatarClear}
                >
                  <X className="h-4 w-4 mr-1" />
                  クリア
                </Button>
              )}
              {pendingFile && (
                <span className="text-xs text-muted-foreground">切り抜き済み</span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">JPEG, PNG, GIF, WebP（2MB以下）</p>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleProfileSave} disabled={profileSaving}>
              {profileSaving ? "保存中..." : "プロフィールを保存"}
            </Button>
          </div>
        </div>
        )}
      </Card>

      {/* Password Section */}
      <Card className="p-6 space-y-5">
        <h2 className="text-lg font-semibold flex items-center gap-2">
          <Lock className="h-5 w-5" />
          パスワード変更
        </h2>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="currentPassword">現在のパスワード</Label>
            <Input
              id="currentPassword"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="newPassword">新しいパスワード</Label>
            <Input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirmPassword">新しいパスワード（確認）</Label>
            <Input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>

          <div className="flex justify-end">
            <Button
              onClick={handlePasswordChange}
              disabled={passwordSaving || !currentPassword || !newPassword}
            >
              {passwordSaving ? "変更中..." : "パスワードを変更"}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

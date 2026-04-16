import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate, useSearchParams } from "react-router-dom";
import { getToken, getMe, logout, type User } from "@/lib/api";
import { LoginPage } from "@/pages/LoginPage";
import { AdminPage } from "@/pages/AdminPage";
import { FileExplorerPage } from "@/pages/FileExplorerPage";
import { Toaster } from "@/components/ui/sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { UserSettingsPage } from "@/pages/UserSettingsPage";
import { EditorPage } from "@/pages/EditorPage";
import { Search, Settings, LogOut, Moon, Sun, UserCog } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { type FormEvent, type ReactNode, useState, useEffect } from "react";
import { useTheme } from "next-themes";
import { getStats, getPublicSetting, type StatsResponse } from "@/lib/api";
import i18n, { t } from "@/i18n";

function AuthGuard({ children }: { children: ReactNode }) {
  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function NavBar() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [searchValue, setSearchValue] = useState(searchParams.get("q") ?? "");
  const [currentUser, setCurrentUser] = useState<User | null>(null);

  useEffect(() => {
    getMe().then(setCurrentUser).catch(() => {});
  }, []);

  // Refresh user when profile is updated
  useEffect(() => {
    const handler = () => getMe().then(setCurrentUser).catch(() => {});
    window.addEventListener("profile-updated", handler);
    return () => window.removeEventListener("profile-updated", handler);
  }, []);

  // Sync input with URL query param changes (e.g. browser back)
  useEffect(() => {
    setSearchValue(searchParams.get("q") ?? "");
  }, [searchParams]);

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    (document.activeElement as HTMLElement)?.blur();
    const q = searchValue.trim();
    if (q) {
      navigate(`/?q=${encodeURIComponent(q)}&_t=${Date.now()}`);
    } else {
      navigate("/");
    }
  }

  return (
    <header className="h-14 border-b flex items-center gap-4 px-4 mx-[3px] bg-background/80 backdrop-blur-sm sticky top-0 z-50">
      <Link
        to="/"
        className="flex items-center gap-2 hover:opacity-80 transition-opacity shrink-0"
        onClick={() => {
          setSearchValue("");
        }}
      >
        <span className="font-bold text-lg tracking-tight">LAS</span>
        <span className="text-xs text-muted-foreground hidden sm:inline">Local AI Search</span>
      </Link>

      <form onSubmit={handleSearch} className="max-w-xl ml-4 w-full">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t("common:searchDocuments")}
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            className="h-9 pl-9 pr-3 text-sm rounded-lg"
          />
        </div>
      </form>

      <div className="flex items-center gap-3 shrink-0 ml-auto">
        <ThemeToggle />
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<button className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" />}
          >
            <Avatar className="h-8 w-8 cursor-pointer">
              {currentUser?.avatar_url && <AvatarImage src={currentUser.avatar_url} alt="" />}
              <AvatarFallback className="text-xs bg-primary text-primary-foreground">
                {(currentUser?.display_name || currentUser?.username || "U").charAt(0).toUpperCase()}
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            {currentUser && (
              <div className="px-2 py-1.5 text-sm font-medium border-b mb-1">
                {currentUser.display_name || currentUser.username}
              </div>
            )}
            <DropdownMenuItem onClick={() => navigate("/user")}>
              <UserCog className="h-4 w-4 mr-2" />
              {t("common:userSettings")}
            </DropdownMenuItem>
            {currentUser?.roles.includes("admin") && (
              <DropdownMenuItem onClick={() => navigate("/admin")}>
                <Settings className="h-4 w-4 mr-2" />
                {t("common:admin")}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => logout()}>
              <LogOut className="h-4 w-4 mr-2" />
              {t("common:logout")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}

function ThemeToggle() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return <div className="h-8 w-8" />;
  const isDark = theme === "dark";
  return (
    <button
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
      title={isDark ? t("common:lightMode") : t("common:darkMode")}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = bytes;
  for (const u of units) {
    v /= 1024;
    if (v < 1024 || u === "TB") return `${Math.round(v * 10) / 10}${u}`;
  }
  return `${bytes}B`;
}

function StatsFooter() {
  const [stats, setStats] = useState<StatsResponse | null>(null);

  useEffect(() => {
    getStats().then(setStats).catch(() => {});
  }, []);

  if (!stats) return null;

  return (
    <div className="border-t px-2 md:px-4 py-2 flex items-center gap-2 md:gap-3 text-xs text-muted-foreground shrink-0 overflow-hidden">
      <Badge variant="outline" className="text-xs font-normal">
        {t("common:documentsRegistered", { count: stats.total_documents.toLocaleString() })}
      </Badge>
      <Badge variant="outline" className="text-xs font-normal">
        {t("common:chunks", { count: stats.total_chunks.toLocaleString() })}
      </Badge>
      {stats.disk_total_bytes > 0 && (
        <Badge variant="outline" className="text-xs font-normal hidden md:inline-flex">
          {t("common:disk", { used: formatBytes(stats.disk_used_bytes), total: formatBytes(stats.disk_total_bytes), percent: Math.round(stats.disk_used_bytes / stats.disk_total_bytes * 100) })}
        </Badge>
      )}
      <span className="ml-auto">LAS Version {__APP_VERSION__}</span>
    </div>
  );
}

function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      <NavBar />
      <div className="flex-1 min-h-0">{children}</div>
      <StatsFooter />
    </div>
  );
}

export default function App() {
  const [langKey, setLangKey] = useState(0);

  // Re-render entire app when language changes
  useEffect(() => {
    const handler = () => setLangKey((k) => k + 1);
    i18n.on("languageChanged", handler);
    return () => { i18n.off("languageChanged", handler); };
  }, []);

  // Resolve locale: localStorage → user.locale → system_language → ja
  useEffect(() => {
    const stored = localStorage.getItem("las_locale");
    if (stored) return; // user already chose

    (async () => {
      // Only call getMe() when a token exists, otherwise the 401 redirect logic fires
      if (getToken()) {
        try {
          const user = await getMe();
          if (user.locale) {
            localStorage.setItem("las_locale", user.locale);
            i18n.changeLanguage(user.locale);
            return;
          }
        } catch { /* not logged in */ }
      }

      try {
        const res = await getPublicSetting("system_language");
        if (res.value && res.value !== i18n.language) {
          localStorage.setItem("las_locale", res.value);
          i18n.changeLanguage(res.value);
        }
      } catch { /* ignore */ }
    })();
  }, []);

  return (
    <BrowserRouter key={langKey}>
      <Toaster position="bottom-right" />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <AuthGuard>
              <AppLayout>
                <FileExplorerPage />
              </AppLayout>
            </AuthGuard>
          }
        />
        <Route
          path="/admin"
          element={
            <AuthGuard>
              <AppLayout>
                <AdminPage />
              </AppLayout>
            </AuthGuard>
          }
        />
        <Route
          path="/user"
          element={
            <AuthGuard>
              <AppLayout>
                <UserSettingsPage />
              </AppLayout>
            </AuthGuard>
          }
        />
        <Route
          path="/editor"
          element={
            <AuthGuard>
              <EditorPage />
            </AuthGuard>
          }
        />
        <Route path="/files" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

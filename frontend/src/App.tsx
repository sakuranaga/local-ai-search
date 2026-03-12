import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate, useSearchParams } from "react-router-dom";
import { getToken, getMe, logout, type User } from "@/lib/api";
import { LoginPage } from "@/pages/LoginPage";
import { SearchPage } from "@/pages/SearchPage";
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
import { Search, Settings, LogOut, FolderOpen, Moon, Sun } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { type FormEvent, type ReactNode, useState, useEffect } from "react";
import { useTheme } from "next-themes";
import { getStats, type StatsResponse } from "@/lib/api";

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

  // Sync input with URL query param changes (e.g. browser back)
  useEffect(() => {
    setSearchValue(searchParams.get("q") ?? "");
  }, [searchParams]);

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    const q = searchValue.trim();
    if (q) {
      navigate(`/?q=${encodeURIComponent(q)}&_t=${Date.now()}`);
    }
  }

  return (
    <header className="h-14 border-b flex items-center gap-4 px-4 mx-[3px] bg-background/80 backdrop-blur-sm sticky top-0 z-50">
      <Link
        to="/"
        className="flex items-center gap-2 hover:opacity-80 transition-opacity shrink-0"
        onClick={() => {
          setSearchValue("");
          sessionStorage.removeItem("las_search_cache");
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
            placeholder="文書を検索..."
            value={searchValue}
            onChange={(e) => setSearchValue(e.target.value)}
            className="h-9 pl-9 pr-3 text-sm rounded-lg"
          />
        </div>
      </form>

      <div className="flex items-center gap-3 shrink-0 ml-auto">
        <ThemeToggle />
        {currentUser && (
          <Link to="/files" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
            <FolderOpen className="h-4 w-4" />
            <span className="hidden sm:inline">文書管理</span>
          </Link>
        )}
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
            {currentUser?.roles.includes("admin") && (
              <DropdownMenuItem onClick={() => navigate("/admin")}>
                <Settings className="h-4 w-4 mr-2" />
                管理
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => logout()}>
              <LogOut className="h-4 w-4 mr-2" />
              ログアウト
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
      title={isDark ? "ライトモード" : "ダークモード"}
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
    <div className="border-t px-4 py-2 flex items-center gap-3 text-xs text-muted-foreground shrink-0">
      <Badge variant="outline" className="text-xs font-normal">
        {stats.total_documents.toLocaleString()}文書登録済み
      </Badge>
      <Badge variant="outline" className="text-xs font-normal">
        {stats.total_chunks.toLocaleString()}チャンク
      </Badge>
      {stats.disk_total_bytes > 0 && (
        <Badge variant="outline" className="text-xs font-normal">
          ディスク {formatBytes(stats.disk_used_bytes)}/{formatBytes(stats.disk_total_bytes)} ({Math.round(stats.disk_used_bytes / stats.disk_total_bytes * 100)}%)
        </Badge>
      )}
      <span className="ml-auto">&copy; DDR8</span>
    </div>
  );
}

function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h-screen flex flex-col bg-background">
      <NavBar />
      <div className="flex-1 min-h-0">{children}</div>
      <StatsFooter />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="bottom-right" />
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          path="/"
          element={
            <AuthGuard>
              <AppLayout>
                <SearchPage />
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
          path="/files"
          element={
            <AuthGuard>
              <AppLayout>
                <FileExplorerPage />
              </AppLayout>
            </AuthGuard>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

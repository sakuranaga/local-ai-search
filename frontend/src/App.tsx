import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate, useSearchParams } from "react-router-dom";
import { getToken, logout } from "@/lib/api";
import { LoginPage } from "@/pages/LoginPage";
import { SearchPage } from "@/pages/SearchPage";
import { AdminPage } from "@/pages/AdminPage";
import { DocumentPage } from "@/pages/DocumentPage";
import { FileExplorerPage } from "@/pages/FileExplorerPage";
import { Toaster } from "@/components/ui/sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Input } from "@/components/ui/input";
import { Search, Settings, LogOut, FolderOpen } from "lucide-react";
import { type FormEvent, type ReactNode, useState, useEffect } from "react";

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

  // Sync input with URL query param changes (e.g. browser back)
  useEffect(() => {
    setSearchValue(searchParams.get("q") ?? "");
  }, [searchParams]);

  function handleSearch(e: FormEvent) {
    e.preventDefault();
    const q = searchValue.trim();
    if (q) {
      navigate(`/?q=${encodeURIComponent(q)}`);
    }
  }

  return (
    <header className="h-14 border-b flex items-center gap-4 px-4 bg-background/80 backdrop-blur-sm sticky top-0 z-50">
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

      <div className="flex items-center gap-2 shrink-0 ml-auto">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<button className="rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" />}
          >
            <Avatar className="h-8 w-8 cursor-pointer">
              <AvatarFallback className="text-xs bg-primary text-primary-foreground">
                U
              </AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem onClick={() => navigate("/files")}>
              <FolderOpen className="h-4 w-4 mr-2" />
              文書管理
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => navigate("/admin")}>
              <Settings className="h-4 w-4 mr-2" />
              管理
            </DropdownMenuItem>
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

function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background">
      <NavBar />
      {children}
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Toaster position="top-right" />
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
        <Route
          path="/documents/:id"
          element={
            <AuthGuard>
              <AppLayout>
                <DocumentPage />
              </AppLayout>
            </AuthGuard>
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

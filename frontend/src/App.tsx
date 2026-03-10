import { BrowserRouter, Routes, Route, Navigate, Link, useNavigate } from "react-router-dom";
import { getToken, logout } from "@/lib/api";
import { LoginPage } from "@/pages/LoginPage";
import { SearchPage } from "@/pages/SearchPage";
import { AdminPage } from "@/pages/AdminPage";
import { DocumentPage } from "@/pages/DocumentPage";
import { Toaster } from "@/components/ui/sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Search, Settings, LogOut } from "lucide-react";
import type { ReactNode } from "react";

function AuthGuard({ children }: { children: ReactNode }) {
  if (!getToken()) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function NavBar() {
  const navigate = useNavigate();

  return (
    <header className="h-16 border-b flex items-center justify-between px-4 bg-background/80 backdrop-blur-sm sticky top-0 z-50">
      <Link to="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
        <Search className="h-5 w-5 text-primary" />
        <span className="font-bold text-lg tracking-tight">LAS</span>
        <span className="text-xs text-muted-foreground hidden sm:inline">Local AI Search</span>
      </Link>

      <div className="flex items-center gap-2">
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

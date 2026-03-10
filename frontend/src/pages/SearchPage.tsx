import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { ResultList } from "@/components/ResultList";
import { ChatPanel } from "@/components/ChatPanel";
import { DocumentModal } from "@/components/DocumentModal";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  searchDocuments,
  getStats,
  getPublicSetting,
  type SearchResult,
  type StatsResponse,
} from "@/lib/api";

const CACHE_KEY = "las_search_cache";
const PER_PAGE = 20;

interface SearchCache {
  query: string;
  page: number;
  results: SearchResult[];
  total: number;
}

function loadCache(): SearchCache | null {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveCache(cache: SearchCache) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

export function SearchPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [modalOpen, setModalOpen] = useState(false);
  const [modalIndex, setModalIndex] = useState(0);

  const urlQ = searchParams.get("q") ?? "";
  const urlPage = Number(searchParams.get("page")) || 1;

  const cached = useRef(loadCache());

  const [query, setQuery] = useState(urlQ || cached.current?.query || "");
  const [page, setPage] = useState(urlQ ? urlPage : cached.current?.page || 1);
  const [results, setResults] = useState<SearchResult[]>(
    urlQ ? [] : cached.current?.results ?? [],
  );
  const [total, setTotal] = useState(urlQ ? 0 : cached.current?.total ?? 0);

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const [welcomeMessage, setWelcomeMessage] = useState("");
  const lastSearchRef = useRef("");

  useEffect(() => {
    getStats().then(setStats).catch(() => {});
    getPublicSetting("welcome_message").then((s) => setWelcomeMessage(s.value)).catch(() => {});
  }, []);

  // Persist search results to sessionStorage
  useEffect(() => {
    if (query) {
      saveCache({ query, page, results, total });
    }
  }, [query, page, results, total]);

  const fetchPage = useCallback(
    async (q: string, p: number) => {
      setQuery(q);
      setPage(p);
      setResults([]);

      try {
        const data = await searchDocuments(q, p, PER_PAGE);
        setResults(data.results);
        setTotal(data.total);
      } catch {
        setResults([]);
        setTotal(0);
      }
    },
    [],
  );

  // Clear state when query is removed (e.g. logo click)
  useEffect(() => {
    if (!urlQ) {
      setQuery("");
      setPage(1);
      setResults([]);
      setTotal(0);
      lastSearchRef.current = "";
    }
  }, [urlQ]);

  // React to URL query param changes (from NavBar search)
  useEffect(() => {
    if (!urlQ) return;
    const key = `${urlQ}:${urlPage}`;
    if (key === lastSearchRef.current) return;
    lastSearchRef.current = key;
    fetchPage(urlQ, urlPage);
  }, [urlQ, urlPage, fetchPage]);

  const goToPage = useCallback(
    (p: number) => {
      const params: Record<string, string> = { q: query };
      if (p > 1) params.page = String(p);
      setSearchParams(params, { replace: true });
    },
    [query, setSearchParams],
  );

  const totalPages = Math.ceil(total / PER_PAGE);

  const showWelcome = !urlQ && results.length === 0;

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      {/* Two-column layout */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-5 gap-4 px-4 pt-4 pb-4 min-h-0">
        {/* Left: welcome or results + pagination */}
        <div className="lg:col-span-3 flex flex-col min-h-0">
          {showWelcome ? (
            <div className="flex-1 min-h-0 overflow-y-auto p-px">
              <Card className="h-full">
                <CardContent className="prose dark:prose-invert max-w-none p-6">
                  {welcomeMessage ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{welcomeMessage}</ReactMarkdown>
                  ) : (
                    <p className="text-muted-foreground">検索バーにキーワードを入力して検索を開始してください。</p>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : (
          <>
          {total > 0 && (
            <p className="text-xs text-muted-foreground pb-2">
              {total}件中 {(page - 1) * PER_PAGE + 1}〜{Math.min(page * PER_PAGE, total)}件目
            </p>
          )}
          <div className="flex-1 min-h-0">
            <ResultList
              results={results}
              onSelect={(r) => {
                const idx = results.findIndex((x) => x.chunk_id === r.chunk_id);
                setModalIndex(idx >= 0 ? idx : 0);
                setModalOpen(true);
              }}
            />
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 py-3 border-t">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => goToPage(page - 1)}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter((p) => p === 1 || p === totalPages || Math.abs(p - page) <= 2)
                .reduce<(number | "...")[]>((acc, p, idx, arr) => {
                  if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push("...");
                  acc.push(p);
                  return acc;
                }, [])
                .map((item, idx) =>
                  item === "..." ? (
                    <span key={`ellipsis-${idx}`} className="px-1 text-muted-foreground">…</span>
                  ) : (
                    <Button
                      key={item}
                      variant={item === page ? "default" : "outline"}
                      size="sm"
                      className="min-w-[36px]"
                      onClick={() => goToPage(item as number)}
                    >
                      {item}
                    </Button>
                  ),
                )}
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => goToPage(page + 1)}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
            </div>
          )}
          </>
          )}
        </div>
        {/* Right: AI chat */}
        <div className="lg:col-span-2 min-h-0">
          <ChatPanel
            initialQuery={urlQ || undefined}
            onSourceClick={(docId) => {
              const idx = results.findIndex((r) => r.document_id === docId);
              setModalIndex(idx >= 0 ? idx : 0);
              setModalOpen(true);
            }}
          />
        </div>
      </div>

      {/* Stats bar */}
      {stats && (
        <div className="border-t px-4 py-2 flex items-center gap-3 text-xs text-muted-foreground">
          <Badge variant="outline" className="text-xs font-normal">
            {stats.total_documents.toLocaleString()}文書登録済み
          </Badge>
          <Badge variant="outline" className="text-xs font-normal">
            {stats.total_chunks.toLocaleString()}チャンク
          </Badge>
        </div>
      )}

      <DocumentModal
        results={results}
        currentIndex={modalIndex}
        open={modalOpen}
        onOpenChange={setModalOpen}
        onNavigate={setModalIndex}
      />
    </div>
  );
}

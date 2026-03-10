import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { SearchBar } from "@/components/SearchBar";
import { ResultList } from "@/components/ResultList";
import { AIAnswer } from "@/components/AIAnswer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  searchDocuments,
  streamAIAnswer,
  getStats,
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
  aiText: string;
  aiSources: Array<{ document_id: number; title: string }>;
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
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();

  const cached = useRef(loadCache());
  const initialQ = searchParams.get("q") ?? cached.current?.query ?? "";
  const initialPage = Number(searchParams.get("page")) || cached.current?.page || 1;

  const [query, setQuery] = useState(initialQ);
  const [page, setPage] = useState(initialPage);
  const [results, setResults] = useState<SearchResult[]>(cached.current?.results ?? []);
  const [total, setTotal] = useState(cached.current?.total ?? 0);
  const [isSearching, setIsSearching] = useState(false);

  const [aiText, setAiText] = useState(cached.current?.aiText ?? "");
  const [aiSources, setAiSources] = useState<Array<{ document_id: number; title: string }>>(
    cached.current?.aiSources ?? [],
  );
  const [aiLoading, setAiLoading] = useState(false);

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    getStats().then(setStats).catch(() => {});
  }, []);

  // Persist state to sessionStorage
  useEffect(() => {
    if (query) {
      saveCache({ query, page, results, total, aiText, aiSources });
    }
  }, [query, page, results, total, aiText, aiSources]);

  const fetchPage = useCallback(
    async (q: string, p: number, withAI: boolean) => {
      setQuery(q);
      setPage(p);
      setResults([]);
      setIsSearching(true);

      const params: Record<string, string> = { q };
      if (p > 1) params.page = String(p);
      setSearchParams(params, { replace: true });

      try {
        const data = await searchDocuments(q, p, PER_PAGE);
        setResults(data.results);
        setTotal(data.total);
      } catch {
        setResults([]);
        setTotal(0);
      } finally {
        setIsSearching(false);
      }

      if (withAI) {
        setAiText("");
        setAiSources([]);
        setAiLoading(true);
        abortRef.current?.abort();
        abortRef.current = streamAIAnswer(
          q,
          (chunk) => setAiText((prev) => prev + chunk),
          (sources) => setAiSources(sources),
          () => setAiLoading(false),
          () => setAiLoading(false),
        );
      }
    },
    [setSearchParams],
  );

  const doSearch = useCallback(
    (q: string) => fetchPage(q, 1, true),
    [fetchPage],
  );

  const goToPage = useCallback(
    (p: number) => fetchPage(query, p, false),
    [fetchPage, query],
  );

  const totalPages = Math.ceil(total / PER_PAGE);

  // Cleanup on unmount
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Search bar area */}
      <div className="pt-8 pb-6 px-4">
        <SearchBar initialQuery={query} onSearch={doSearch} isLoading={isSearching} />
        {total > 0 && (
          <p className="text-xs text-muted-foreground text-center mt-2">
            {total}件中 {(page - 1) * PER_PAGE + 1}〜{Math.min(page * PER_PAGE, total)}件目
          </p>
        )}
      </div>

      {/* Two-column results */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-5 gap-4 px-4 pb-4 min-h-0">
        <div className="lg:col-span-3 flex flex-col min-h-0">
          <div className="flex-1 min-h-0">
            <ResultList
              results={results}
              onSelect={(r) => navigate(`/documents/${r.document_id}`)}
            />
          </div>
          {/* Pagination */}
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
        </div>
        <div className="lg:col-span-2">
          <AIAnswer
            text={aiText}
            sources={aiSources}
            isLoading={aiLoading}
            hasQuery={query.length > 0}
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
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
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

  const urlQ = searchParams.get("q") ?? "";
  const urlPage = Number(searchParams.get("page")) || 1;

  const cached = useRef(loadCache());

  const [query, setQuery] = useState(urlQ || cached.current?.query || "");
  const [page, setPage] = useState(urlQ ? urlPage : cached.current?.page || 1);
  const [results, setResults] = useState<SearchResult[]>(
    urlQ ? [] : cached.current?.results ?? [],
  );
  const [total, setTotal] = useState(urlQ ? 0 : cached.current?.total ?? 0);
  const [, setIsSearching] = useState(false);

  const [aiText, setAiText] = useState(urlQ ? "" : cached.current?.aiText ?? "");
  const [aiSources, setAiSources] = useState<Array<{ document_id: number; title: string }>>(
    urlQ ? [] : cached.current?.aiSources ?? [],
  );
  const [aiLoading, setAiLoading] = useState(false);

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const lastSearchRef = useRef("");

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
    [],
  );

  // Clear state when query is removed (e.g. logo click)
  useEffect(() => {
    if (!urlQ) {
      setQuery("");
      setPage(1);
      setResults([]);
      setTotal(0);
      setAiText("");
      setAiSources([]);
      setAiLoading(false);
      abortRef.current?.abort();
      lastSearchRef.current = "";
    }
  }, [urlQ]);

  // React to URL query param changes (from NavBar search)
  useEffect(() => {
    if (!urlQ) return;
    const key = `${urlQ}:${urlPage}`;
    if (key === lastSearchRef.current) return;
    lastSearchRef.current = key;

    const isNewQuery = urlQ !== query;
    fetchPage(urlQ, urlPage, isNewQuery);
  }, [urlQ, urlPage, fetchPage, query]);

  const goToPage = useCallback(
    (p: number) => {
      const params: Record<string, string> = { q: query };
      if (p > 1) params.page = String(p);
      setSearchParams(params, { replace: true });
    },
    [query, setSearchParams],
  );

  const totalPages = Math.ceil(total / PER_PAGE);

  // Cleanup on unmount
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  return (
    <div className="flex flex-col h-[calc(100vh-56px)]">
      {/* Result count */}
      {total > 0 && (
        <div className="px-4 pt-3 pb-1">
          <p className="text-xs text-muted-foreground">
            {total}件中 {(page - 1) * PER_PAGE + 1}〜{Math.min(page * PER_PAGE, total)}件目
          </p>
        </div>
      )}

      {/* Two-column results */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-5 gap-4 px-4 pb-4 pt-2 min-h-0">
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

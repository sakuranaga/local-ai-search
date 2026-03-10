import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { SearchBar } from "@/components/SearchBar";
import { ResultList } from "@/components/ResultList";
import { AIAnswer } from "@/components/AIAnswer";
import { Badge } from "@/components/ui/badge";
import {
  searchDocuments,
  streamAIAnswer,
  getStats,
  type SearchResult,
  type SearchResponse,
  type StatsResponse,
} from "@/lib/api";

export function SearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [searchMeta, setSearchMeta] = useState<{ total: number; elapsed_ms: number } | null>(null);
  const [isSearching, setIsSearching] = useState(false);

  const [aiText, setAiText] = useState("");
  const [aiSources, setAiSources] = useState<Array<{ document_id: number; title: string }>>([]);
  const [aiLoading, setAiLoading] = useState(false);

  const [stats, setStats] = useState<StatsResponse | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    getStats().then(setStats).catch(() => {});
  }, []);

  const doSearch = useCallback(
    async (q: string) => {
      setQuery(q);
      setResults([]);
      setSearchMeta(null);
      setAiText("");
      setAiSources([]);
      setIsSearching(true);
      setAiLoading(true);

      // abort any ongoing AI stream
      abortRef.current?.abort();

      // fulltext + vector search
      try {
        const data: SearchResponse = await searchDocuments(q);
        setResults(data.results);
        setSearchMeta({ total: data.total, elapsed_ms: data.elapsed_ms });
      } catch {
        setResults([]);
      } finally {
        setIsSearching(false);
      }

      // AI stream
      abortRef.current = streamAIAnswer(
        q,
        (chunk) => setAiText((prev) => prev + chunk),
        (sources) => setAiSources(sources),
        () => setAiLoading(false),
        () => setAiLoading(false),
      );
    },
    [],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  return (
    <div className="flex flex-col h-[calc(100vh-64px)]">
      {/* Search bar area */}
      <div className="pt-8 pb-6 px-4">
        <SearchBar initialQuery={query} onSearch={doSearch} isLoading={isSearching} />
        {searchMeta && (
          <p className="text-xs text-muted-foreground text-center mt-2">
            {searchMeta.total}件の結果 ({searchMeta.elapsed_ms}ms)
          </p>
        )}
      </div>

      {/* Two-column results */}
      <div className="flex-1 grid grid-cols-1 lg:grid-cols-5 gap-4 px-4 pb-4 min-h-0">
        <div className="lg:col-span-3">
          <ResultList
            results={results}
            onSelect={(r) => navigate(`/documents/${r.document_id}`)}
          />
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

import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { type FormEvent, useState } from "react";

interface SearchBarProps {
  initialQuery?: string;
  onSearch: (query: string) => void;
  isLoading?: boolean;
}

export function SearchBar({ initialQuery = "", onSearch, isLoading }: SearchBarProps) {
  const [value, setValue] = useState(initialQuery);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const q = value.trim();
    if (q) onSearch(q);
  }

  return (
    <form onSubmit={handleSubmit} className="relative w-full max-w-2xl mx-auto">
      <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-5 w-5 text-muted-foreground" />
      <Input
        type="text"
        placeholder="文書を検索..."
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={isLoading}
        className="h-14 pl-12 pr-4 text-lg rounded-xl border-2 focus-visible:ring-2 focus-visible:ring-primary/30 shadow-sm"
      />
    </form>
  );
}

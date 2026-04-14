import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { getToken } from "@/lib/api";

const API_BASE = import.meta.env.VITE_API_BASE ?? "/api";

export function EditorPage() {
  const [searchParams] = useSearchParams();
  const docId = searchParams.get("id");
  const [discoveryUrl, setDiscoveryUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    if (!docId) return;

    fetch("/hosting/discovery")
      .then((res) => res.text())
      .then((xml) => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xml, "text/xml");
        // Find the action for the file type - try xlsx first, fallback to any edit action
        const actions = doc.querySelectorAll("action");
        let editUrl: string | null = null;
        for (const action of actions) {
          if (action.getAttribute("name") === "edit") {
            editUrl = action.getAttribute("urlsrc") || null;
            break;
          }
        }
        if (!editUrl) {
          setError("Collabora Online が利用できません");
          return;
        }
        // Build the full URL — WOPISrc must use Docker-internal URL
        // so Collabora can reach the backend without going through Cloudflare Access
        const token = getToken() || "";
        const wopiSrc = `http://backend:8000/api/wopi/files/${docId}`;
        // Replace discovery host (e.g. https://localhost:3002) with actual browser origin
        const baseUrl = new URL(editUrl.split("?")[0]);
        baseUrl.protocol = window.location.protocol;
        baseUrl.host = window.location.host;
        const url = baseUrl.toString() + `?WOPISrc=${encodeURIComponent(wopiSrc)}&access_token=${encodeURIComponent(token)}&lang=ja&ui_defaults=${encodeURIComponent("UIMode=compact")}`;
        setDiscoveryUrl(url);
      })
      .catch(() => setError("Collabora Online に接続できません"));
  }, [docId]);

  if (!docId) return <div className="p-8">ドキュメントIDが指定されていません</div>;
  if (error) return <div className="p-8 text-red-500">{error}</div>;
  if (!discoveryUrl) return <div className="p-8">読み込み中...</div>;

  return (
    <iframe
      ref={iframeRef}
      src={discoveryUrl}
      style={{ width: "100vw", height: "100vh", border: "none" }}
      allow="clipboard-read; clipboard-write"
    />
  );
}

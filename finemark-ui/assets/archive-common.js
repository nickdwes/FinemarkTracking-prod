// Shared helpers for the Archive module's report pages.
window.ArchiveCommon = (function () {
  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  };
  const fmtDateTime = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  const fmtMoney = (n) => "KES " + Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 0, maximumFractionDigits: 0 });

  function downloadCsv(path) {
    const session = window.FINEMARK_APP.getSession();
    const url = `${window.FINEMARK_APP.API_BASE}${path}`;
    fetch(url, { headers: { Authorization: `Bearer ${session?.accessToken || ""}` } })
      .then((r) => { if (!r.ok) throw new Error("Export failed"); return r.blob(); })
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `archive_export_${new Date().toISOString().slice(0, 10)}.csv`;
        document.body.appendChild(a); a.click(); a.remove();
      })
      .catch((e) => window.FINEMARK_APP?.showToast?.(e.message, "error"));
  }

  // A plain <a href="/api/..."> can't carry the app's Bearer token — only the app's
  // own fetch() calls attach it — so a direct browser navigation to a protected
  // /api/ file endpoint always 401s. These fetch the file as a blob (with the auth
  // header) and hand it to the browser from there instead.
  function fetchFileBlob(path) {
    const session = window.FINEMARK_APP.getSession();
    const url = `${window.FINEMARK_APP.API_BASE}${path}`;
    return fetch(url, { headers: { Authorization: `Bearer ${session?.accessToken || ""}` } })
      .then((r) => { if (!r.ok) throw new Error(r.status === 401 ? "Session expired — please refresh and sign in again." : "Failed to load file"); return r.blob(); });
  }

  function viewFile(path) {
    // window.open must run synchronously in the click handler or popup blockers
    // stop it — open a blank tab now, point it at the blob once the fetch resolves.
    const newTab = window.open("", "_blank");
    fetchFileBlob(path)
      .then((blob) => {
        const blobUrl = URL.createObjectURL(blob);
        if (newTab) newTab.location = blobUrl; else window.open(blobUrl, "_blank");
      })
      .catch((e) => {
        if (newTab) newTab.close();
        window.FINEMARK_APP?.showToast?.(e.message, "error");
      });
  }

  function downloadFile(path, filename) {
    fetchFileBlob(path)
      .then((blob) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
      })
      .catch((e) => window.FINEMARK_APP?.showToast?.(e.message, "error"));
  }

  const readOnlyBadge = `
    <span class="inline-flex items-center gap-1.5 rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800">
      <svg viewBox="0 0 24 24" class="h-3.5 w-3.5" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M4 8v11a1 1 0 001 1h14a1 1 0 001-1V8"/></svg>
      Archive — read only
    </span>`;

  async function gate() {
    return await window.FINEMARK_APP?.requirePageAccess?.();
  }

  return { escapeHtml, fmtDate, fmtDateTime, fmtMoney, downloadCsv, viewFile, downloadFile, readOnlyBadge, gate };
})();

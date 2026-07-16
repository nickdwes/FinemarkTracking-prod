(() => {
  const header = document.getElementById("header");
  const sidebar = document.getElementById("sidebar");
  const footer = document.getElementById("footer");

  if (!header || !sidebar || !footer) {
    return;
  }

  const currentPath = window.location.pathname.split("/").pop() || "finance-dashboard.html";
  const iconSvg = (name) => {
    const icons = {
      dashboard: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h7v7H4z"/><path d="M13 4h7v4h-7z"/><path d="M13 10h7v10h-7z"/><path d="M4 13h7v7H4z"/></svg>`,
      list: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>`,
      report: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 4h16v16H4z"/><path d="M7 14l3-3 3 2 4-5"/></svg>`,
      finance: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 7h16"/><path d="M4 11h16"/><path d="M4 15h10"/><path d="M16 15h4v4h-4z"/></svg>`,
      home: `<svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>`,
    };
    return icons[name] || icons.list;
  };

  const navItem = (href, label, iconName) => {
    const isActive = currentPath === href;
    const baseClasses = "block px-4 py-2 rounded-lg text-sm transition";
    const activeClasses = "bg-blue-50 text-blue-700 font-semibold border border-blue-100";
    const inactiveClasses = "text-slate-700 hover:bg-slate-50";
    return `
      <a href="${href}" class="${baseClasses} ${isActive ? activeClasses : inactiveClasses}">
        <span class="inline-flex items-center gap-2">
          ${iconSvg(iconName)}
          <span>${label}</span>
        </span>
      </a>
    `;
  };

  const menuContent = `
    <div class="space-y-1">
      <p class="px-3 text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Finance</p>
      ${navItem("finance-dashboard.html", "Finance Dashboard", "dashboard")}
      ${navItem("invoice-followup.html", "Invoice Follow-up", "list")}
      ${navItem("financial-reports.html", "Financial Reports", "report")}
      ${navItem("payment-processing.html", "Payment Processing", "finance")}
      <div class="pt-2 mt-2 border-t border-slate-200">
        <a href="../../index.html" class="block px-3 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-50">
          <span class="inline-flex items-center gap-2">
            ${iconSvg("home")}
            <span>Main App Dashboard</span>
          </span>
        </a>
      </div>
    </div>
  `;

  header.innerHTML = `
    <header class="fixed top-0 left-0 right-0 h-16 bg-white border-b border-slate-200 z-20">
      <div class="px-6 h-full flex items-center justify-between">
        <div class="flex items-center gap-3">
          <img src="../../assets/finemark-logo.svg" alt="Finemark logo" class="h-9 w-9" />
          <span class="font-semibold text-lg">Finemark</span>
        </div>
        <div class="flex items-center gap-3 text-sm relative">
          <span id="user-info" class="text-slate-600">User: Finance</span>
          <button id="top-menu-toggle" type="button" class="rounded-lg border border-slate-200 px-3 py-2 text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40">
            Menu ▾
          </button>
          <a id="logout" href="../../login.html" class="rounded-lg bg-slate-900 px-3 py-2 text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400">
            Logout
          </a>
          <div id="top-menu-panel" class="hidden absolute right-0 top-14 w-72 rounded-xl border border-slate-200 bg-white shadow-lg shadow-slate-200/60 p-3 z-30">
            <div class="max-h-96 overflow-y-auto space-y-2">
              ${menuContent}
            </div>
          </div>
        </div>
      </div>
    </header>
  `;

  sidebar.innerHTML = `
    <aside class="hidden lg:flex w-64 flex-col border-r border-slate-200 bg-white">
      <div class="px-6 py-5 border-b border-slate-200">
        <span class="text-lg font-semibold">Finance</span>
      </div>
      <nav class="flex-1 p-4 space-y-2">
        <p class="px-4 text-xs font-semibold text-slate-500 uppercase tracking-wide">Finance</p>
        ${navItem("finance-dashboard.html", "Finance Dashboard", "dashboard")}
        ${navItem("invoice-followup.html", "Invoice Follow-up", "list")}
        ${navItem("financial-reports.html", "Financial Reports", "report")}
        ${navItem("payment-processing.html", "Payment Processing", "finance")}
        <div class="pt-3 mt-3 border-t border-slate-200">
          <a href="../../index.html" class="block px-4 py-2 rounded-lg text-sm text-slate-700 hover:bg-slate-50">
            <span class="inline-flex items-center gap-2">
              ${iconSvg("home")}
              <span>Main App Dashboard</span>
            </span>
          </a>
        </div>
      </nav>
    </aside>
  `;

  footer.innerHTML = `
    <footer class="bg-white border-t border-slate-200 text-center text-xs text-slate-500 py-4">
      © 2026 FineMark Tracking. All rights reserved.
    </footer>
  `;

  const userInfo = document.getElementById("user-info");
  try {
    const storedUser = JSON.parse(localStorage.getItem("finemarkUser"));
    if (storedUser && storedUser.email && storedUser.role) {
      userInfo.textContent = `User: ${storedUser.email} (${storedUser.role})`;
    }
  } catch (error) {
    // ignore
  }

  const logoutLink = document.getElementById("logout");
  if (logoutLink) {
    logoutLink.addEventListener("click", () => {
      localStorage.removeItem("finemarkUser");
    });
  }

  const menuToggle = document.getElementById("top-menu-toggle");
  const menuPanel = document.getElementById("top-menu-panel");
  const closeMenu = (event) => {
    if (!menuPanel || !menuToggle) return;
    const target = event.target;
    if (menuPanel.contains(target) || menuToggle.contains(target)) return;
    menuPanel.classList.add("hidden");
  };
  if (menuToggle && menuPanel) {
    menuToggle.addEventListener("click", () => {
      menuPanel.classList.toggle("hidden");
    });
    document.addEventListener("click", closeMenu);
  }
})();

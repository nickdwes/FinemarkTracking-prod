// Configurable vehicle-attribute categories/entries (Fabricated Body, Trailers,
// Special Cargo, and any future flat "type" list) — backed by
// GET/POST /api/vehicle-attributes/*. Distinct from vehicleCatalog.js's
// make/model catalog: these categories have no make/model/engine spec, just a
// single searchable, user-creatable name per category.
(function () {
  async function fetchCategories() {
    const r = await window.FINEMARK_APP.apiFetch("/vehicle-attributes/categories");
    return r?.data || [];
  }

  async function fetchEntries(categoryCode, search) {
    const qs = search ? `?search=${encodeURIComponent(search)}` : "";
    const r = await window.FINEMARK_APP.apiFetch(`/vehicle-attributes/categories/${encodeURIComponent(categoryCode)}/entries${qs}`);
    return r?.data || [];
  }

  async function createEntry(categoryCode, name) {
    return window.FINEMARK_APP.apiFetch(`/vehicle-attributes/categories/${encodeURIComponent(categoryCode)}/entries`, {
      method: "POST",
      body: { name },
    });
  }

  window.VehicleAttributes = { fetchCategories, fetchEntries, createEntry };

  const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /**
   * Mounts a searchable + inline-creatable dropdown into `container`.
   * opts: { container, categoryCode, categoryLabel, value, onChange(v) }
   * Returns { getValue, getId, setValue }.
   */
  window.mountAttributeDropdown = function mountAttributeDropdown(opts) {
    const { container, categoryCode } = opts;
    const categoryLabel = opts.categoryLabel || "";
    let value = opts.value || "";
    let selectedId = null;
    let entries = [];

    container.innerHTML = `
      <div class="relative">
        <input type="text" class="va-input w-full rounded-lg border border-slate-200 px-3 py-2.5 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40"
               placeholder="Search or select ${escapeHtml(categoryLabel)} type…" autocomplete="off" />
        <div class="va-panel hidden absolute z-30 mt-1 w-full max-h-64 overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg text-sm"></div>
      </div>
      <div class="va-inline-create hidden mt-2 rounded-lg border border-blue-200 bg-blue-50/60 p-2 space-y-1.5">
        <label class="block text-[0.7rem] font-semibold text-slate-600">New ${escapeHtml(categoryLabel)} type</label>
        <div class="flex gap-2">
          <input type="text" class="va-new-name flex-1 rounded-lg border border-slate-200 px-2 py-1.5 text-sm" placeholder="e.g. Flatbed Trailer" />
          <button type="button" class="va-save rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700">Save</button>
          <button type="button" class="va-cancel rounded-lg border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50">Cancel</button>
        </div>
        <p class="va-msg text-xs"></p>
      </div>`;

    const input = container.querySelector(".va-input");
    const panel = container.querySelector(".va-panel");
    const createBox = container.querySelector(".va-inline-create");
    const newNameInput = container.querySelector(".va-new-name");
    const saveBtn = container.querySelector(".va-save");
    const msg = container.querySelector(".va-msg");
    input.value = value;

    function fireChange() {
      if (typeof opts.onChange === "function") opts.onChange({ name: value, id: selectedId });
    }

    function renderPanel() {
      const q = input.value.trim().toLowerCase();
      const filtered = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries;
      const rows = filtered
        .map((e) => `<div class="va-opt px-3 py-2 hover:bg-slate-50 cursor-pointer" data-id="${escapeHtml(e.id)}" data-name="${escapeHtml(e.name)}">${escapeHtml(e.name)}</div>`)
        .join("");
      const addLabel = q ? `+ Add "${escapeHtml(q)}" as new ${escapeHtml(categoryLabel)} type` : `+ Add New ${escapeHtml(categoryLabel)} Type`;
      panel.innerHTML = (rows || `<div class="px-3 py-2 text-slate-400">No matches yet.</div>`)
        + `<div class="va-add px-3 py-2 font-semibold text-blue-600 hover:bg-blue-50 cursor-pointer border-t border-slate-100">${addLabel}</div>`;
      panel.classList.remove("hidden");
    }

    async function loadEntries(search) {
      try { entries = await fetchEntries(categoryCode, search); } catch { entries = []; }
    }

    input.addEventListener("focus", async () => { await loadEntries(input.value.trim()); renderPanel(); });
    let debounce;
    input.addEventListener("input", () => {
      selectedId = null;
      value = input.value;
      clearTimeout(debounce);
      debounce = setTimeout(async () => { await loadEntries(input.value.trim()); renderPanel(); fireChange(); }, 200);
    });

    panel.addEventListener("click", (e) => {
      const opt = e.target.closest(".va-opt");
      if (opt) {
        selectedId = opt.dataset.id;
        value = opt.dataset.name;
        input.value = value;
        panel.classList.add("hidden");
        fireChange();
        return;
      }
      if (e.target.closest(".va-add")) {
        newNameInput.value = input.value.trim();
        msg.textContent = "";
        createBox.classList.remove("hidden");
        panel.classList.add("hidden");
        newNameInput.focus();
      }
    });

    document.addEventListener("click", (e) => {
      if (!container.contains(e.target)) panel.classList.add("hidden");
    });

    container.querySelector(".va-cancel").addEventListener("click", () => createBox.classList.add("hidden"));

    saveBtn.addEventListener("click", async () => {
      const name = newNameInput.value.trim();
      if (!name) { msg.className = "va-msg text-xs text-red-500"; msg.textContent = "Enter a name."; return; }
      saveBtn.disabled = true;
      msg.className = "va-msg text-xs text-slate-400";
      msg.textContent = "Saving…";
      try {
        const res = await createEntry(categoryCode, name);
        const entry = res?.data || res;
        selectedId = entry.id;
        value = entry.name;
        input.value = value;
        createBox.classList.add("hidden");
        fireChange();
      } catch (err) {
        if (err?.code === "DUPLICATE_ENTRY" && err?.details?.existingEntry) {
          const existing = err.details.existingEntry;
          msg.className = "va-msg text-xs text-amber-700 font-medium";
          msg.innerHTML = `${escapeHtml(err.message || `"${name}" already exists.`)} <button type="button" class="va-select-existing underline text-blue-600 font-semibold">Select existing entry</button>`;
          container.querySelector(".va-select-existing")?.addEventListener("click", () => {
            selectedId = existing.id;
            value = existing.name;
            input.value = value;
            createBox.classList.add("hidden");
            fireChange();
          });
        } else {
          msg.className = "va-msg text-xs text-red-500";
          msg.textContent = err?.message || "Failed to save.";
        }
      } finally {
        saveBtn.disabled = false;
      }
    });

    return {
      getValue: () => value,
      getId: () => selectedId,
      setValue: (v) => { value = v || ""; input.value = value; },
    };
  };
})();

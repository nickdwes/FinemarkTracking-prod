(() => {
  const CSVUtils = {};

  CSVUtils.downloadCsv = (filename, csvString) => {
    const blob = new Blob([csvString], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const sanitizeCell = (value) => {
    if (value === null || value === undefined) return "";
    return String(value).replace(/^['"]|['"]$/g, "").trim();
  };

  const toLines = (text) =>
    text
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

  CSVUtils.parseImeiCsv = (file) =>
    new Promise((resolve, reject) => {
      if (!file) {
        reject(new Error("No file selected."));
        return;
      }
      if (file.size > 2 * 1024 * 1024) {
        reject(new Error("File is too large. Max 2MB allowed."));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const content = String(reader.result || "");
          const lines = toLines(content);
          if (!lines.length) {
            reject(new Error("CSV appears to be empty."));
            return;
          }

          const header = sanitizeCell(lines[0]).toLowerCase();
          const hasHeader = header === "imei";
          const rows = hasHeader ? lines.slice(1) : lines;

          const all = [];
          rows.forEach((line) => {
            const cell = sanitizeCell(line.split(",")[0]);
            if (cell) {
              all.push(cell);
            }
          });

          const valid = [];
          const invalid = [];
          const duplicates = [];
          const seen = new Set();

          all.forEach((imei) => {
            if (!/^\d{10,20}$/.test(imei)) {
              invalid.push(imei);
              return;
            }
            if (seen.has(imei)) {
              duplicates.push(imei);
              return;
            }
            seen.add(imei);
            valid.push(imei);
          });

          resolve({ all, valid, invalid, duplicates });
        } catch (error) {
          reject(new Error("Unable to parse CSV."));
        }
      };
      reader.onerror = () => reject(new Error("Failed to read CSV file."));
      reader.readAsText(file);
    });

  window.FINEMARK_CSV_UTILS = CSVUtils;
})();

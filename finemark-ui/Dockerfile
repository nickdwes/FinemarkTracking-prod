# ── Stage 1: Build Tailwind CSS ──────────────────────────────────────────────
FROM node:20-alpine AS tailwind-build
WORKDIR /app
RUN npm install -D tailwindcss@3
COPY tailwind.config.js ./
COPY assets/tailwind.src.css ./assets/tailwind.src.css
COPY assets/*.js ./assets/
COPY pages ./pages
COPY *.html ./
RUN npx tailwindcss -i ./assets/tailwind.src.css -o ./assets/tailwind.css --minify

# ── Stage 2: Serve with nginx ────────────────────────────────────────────────
FROM nginx:1.27-alpine

# Remove the default nginx static content
RUN rm -rf /usr/share/nginx/html/*

# Copy all frontend HTML/assets into nginx's web root
COPY . /usr/share/nginx/html/

# Overwrite the CDN-dependent placeholder with the compiled Tailwind bundle
COPY --from=tailwind-build /app/assets/tailwind.css /usr/share/nginx/html/assets/tailwind.css

# ── Download vendor libraries (eliminates all remaining external CDN deps) ──
RUN apk add --no-cache curl && \
    # Chart.js 4.4.2
    curl -sL "https://cdn.jsdelivr.net/npm/chart.js@4.4.2/dist/chart.umd.min.js" \
         -o /usr/share/nginx/html/assets/chart.umd.min.js && \
    # qrcode-generator 1.4.4
    curl -sL "https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.js" \
         -o /usr/share/nginx/html/assets/qrcode.js && \
    # jsPDF 2.5.1
    curl -sL "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js" \
         -o /usr/share/nginx/html/assets/jspdf.umd.min.js && \
    # pdf.js 3.11.174 (main + worker)
    curl -sL "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js" \
         -o /usr/share/nginx/html/assets/pdf.min.js && \
    curl -sL "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js" \
         -o /usr/share/nginx/html/assets/pdf.worker.min.js && \
    # Font Awesome 6.5.1 CSS (paths in CSS use ../webfonts/ → resolves to /webfonts/ at root)
    curl -sL "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css" \
         -o /usr/share/nginx/html/assets/font-awesome.min.css && \
    mkdir -p /usr/share/nginx/html/webfonts && \
    curl -sL "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-solid-900.woff2" \
         -o /usr/share/nginx/html/webfonts/fa-solid-900.woff2 && \
    curl -sL "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-regular-400.woff2" \
         -o /usr/share/nginx/html/webfonts/fa-regular-400.woff2 && \
    curl -sL "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-brands-400.woff2" \
         -o /usr/share/nginx/html/webfonts/fa-brands-400.woff2 && \
    curl -sL "https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-v4compatibility.woff2" \
         -o /usr/share/nginx/html/webfonts/fa-v4compatibility.woff2 && \
    apk del curl

# Copy our custom nginx config
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

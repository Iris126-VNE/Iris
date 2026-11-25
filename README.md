# Hosted Revit MCP Platform

Hệ thống **Hosted Revit MCP Server** theo kiến trúc của 765T Flow:
- **Hub Server (`apps/hub-server`):** MCP Streamable HTTP (`/mcp`) + Outbound WebSocket Relay (`/ws/connector`) + Door Pattern (chỉ expose 6 công cụ gốc để tiết kiệm token) + Knowledge/TCVN search.
- **Revit Thin Connector (`apps/revit-connector`):** C# Add-in chạy trong Revit (hỗ trợ Revit 2022–2026), chủ động kết nối WSS ra ngoài lên Hub, thực thi an toàn trên UI thread qua `IExternalEventHandler` + `TransactionGroup` + `DialogBoxShowing` suppressor.
- **Protocol (`packages/protocol`):** Schema, `compact_delta`, `documentKey` SHA-256, và danh mục catalog dùng chung.

---

## 1. Chạy thử ngay trên máy (không cần Revit)

Yêu cầu: **Node.js >= 20** (hoặc **Docker**).

```bash
cd revit-mcp-platform
npm install
npm run build
```

Mở 3 terminal:
```bash
# Terminal 1: Chạy Hosted MCP Hub
npm run dev:hub

# Terminal 2: Chạy Mock Revit Connector (giả lập Revit kết nối WSS)
npm run mock:connector

# Terminal 3: Chạy kiểm thử End-to-End qua /mcp
npm run test:e2e
```

---

## 2. Đẩy lên GitHub & Deploy tự động (Render / Fly.io + Build Add-in trên Cloud)

### Bước A: Đẩy mã nguồn lên GitHub (nên chọn Private repo)
```bash
cd revit-mcp-platform
git init
git add .
git commit -m "Initial Hosted Revit MCP Platform"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

Sau khi push, mở tab **Actions** trên GitHub:
- Workflow `CI & Build Revit Connector` sẽ tự chạy E2E test cho Hub Server **và tự build sẵn 2 gói cài đặt**:
  - `RevitMcpConnector-Revit2024` (dùng cho Revit 2022–2024)
  - `RevitMcpConnector-Revit2025` (dùng cho Revit 2025–2026)
- Bạn tải file `.zip` tương ứng từ mục **Artifacts** về giải nén vào `%AppData%\Autodesk\Revit\Addins\<RevitVersion>\` mà không cần cài `.NET SDK` trên máy.

### Bước B: Nối GitHub với Render.com (hoặc Fly.io) để chạy Server 24/7
- **Render.com (1-click Blueprint):** Đăng nhập Render -> **New +** -> **Blueprint** -> chọn repo GitHub vừa tạo (Render tự đọc `render.yaml` + `deploy/Dockerfile`) -> điền biến môi trường `API_KEYS` (ví dụ `my-strong-token:my-tenant`) -> bấm **Apply**.
  - Địa chỉ MCP cho AI Client: `https://<app-name>.onrender.com/mcp` (header `Authorization: Bearer my-strong-token`).
  - Địa chỉ WSS cho `connector.settings.json`: `wss://<app-name>.onrender.com/ws/connector`.
- **Fly.io (region Singapore `sin`, giữ kết nối WebSocket 24/7):**
  ```bash
  fly launch --no-deploy
  fly secrets set API_KEYS="my-strong-token:my-tenant"
  fly deploy
  ```

---

## 3. Triển khai lên VPS riêng (Docker + Auto SSL)

1. Tạo file `.env` từ `.env.example` và đổi `API_KEYS` thành khóa bí mật mạnh.
2. Sửa domain thật trong `deploy/Caddyfile` và bỏ comment service `caddy` trong `deploy/docker-compose.yml`.
3. Chạy:
```bash
cd deploy
docker compose up -d --build
```
4. Cấu hình AI Client kết nối tới `https://mcp.your-domain.com/mcp` kèm header `Authorization: Bearer <your-api-key>`.

---

## 4. Build & Cài đặt Revit Thin Connector Add-in (thủ công trên máy)

Yêu cầu: **.NET 8 SDK** trên máy Windows.

```bash
cd apps/revit-connector

# Build cho Revit 2025 (hoặc 2026) - .NET 8
dotnet build -c Release -p:RevitVersion=2025

# Hoặc build cho Revit 2024 (2022-2024) - .NET Framework 4.8
dotnet build -c Release -p:RevitVersion=2024
```

Cài vào Revit:
1. Copy `RevitMcpConnector.addin` vào `%AppData%\Autodesk\Revit\Addins\<RevitVersion>\`.
2. Copy thư mục output DLL + `connector.settings.json` vào `%AppData%\Autodesk\Revit\Addins\<RevitVersion>\RevitMcpConnector\`.
3. Sửa `hubWsUrl` (`wss://mcp.your-domain.com/ws/connector`) và `apiKey` trong `connector.settings.json`, sau đó mở Revit.

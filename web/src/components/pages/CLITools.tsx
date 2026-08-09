import { useCallback, useEffect, useState } from "react"
import {
  Terminal,
  ChevronRight,
  Zap,
  Shuffle,
  Eye,
  EyeOff,
  RefreshCw,
} from "lucide-react"
import { CodeBlock, CopyButton, CopyRow, PageHeader } from "@/components/common"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select"

// ── Types ──────────────────────────────────────────────────────────────

// ── Section ─────────────────────────────────────────────────────────────

function Section({
  icon: Icon,
  title,
  badge,
  children,
}: {
  icon: React.ElementType
  title: string
  badge?: string
  children: React.ReactNode
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
          {badge && (
            <Badge className="bg-primary/15 text-primary">
              {badge}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  )
}


// ── Kết nối tool ngoài ──────────────────────────────────────────────────

interface ConnectInfo {
  url: string
  token: string
  masked: boolean
  gatewayUrl: string
  anthropicUrl: string
  apiKey: string
  hasApiKey: boolean
  keys: Array<{ id: string; name: string; prefix: string; enabled: boolean }>
  models: Array<{ id: string; label: string; provider: string }>
}

/**
 * Bảng kết nối: lấy token CLI thật từ server và dựng sẵn lệnh để dán.
 *
 * Trước đây trang này chỉ là hướng dẫn TĨNH — người dùng phải tự SSH vào máy chủ chạy
 * `agyproxy token`, tự thay `<ip>` và `<token>` trong lệnh mẫu. Giờ lấy thẳng từ
 * `/api/cli/connect`.
 *
 * Token mặc định CHE (`agy-1234…cdef`) và chỉ lộ khi bấm "Hiện": nó cho toàn quyền điều
 * khiển gateway, nên không nên nằm sẵn trên màn hình lúc chia sẻ hay chụp ảnh.
 */
function ConnectPanel() {
  const [info, setInfo] = useState<ConnectInfo | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async (reveal: boolean) => {
    setBusy(true); setErr(null)
    try {
      const r = await fetch(`/api/cli/connect${reveal ? "?reveal=1" : ""}`)
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      setInfo(await r.json() as ConnectInfo)
      setRevealed(reveal)
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Không lấy được thông tin kết nối")
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { load(false) }, [load])

  // Copy lấy token THẬT kể cả khi đang che — không bắt lộ lên màn hình chỉ để sao chép.
  const tokenValue = async () => {
    const r = await fetch("/api/cli/connect?reveal=1")
    return ((await r.json()) as ConnectInfo).token
  }

  const url = info?.url ?? ""
  const models = info?.models ?? []
  // Lọc theo provider để danh sách 35 model không thành một khối chữ khó đọc.
  const [prov, setProv] = useState<string>("all")
  const provs = [...new Set(models.map((m) => m.provider))]
  const shown = prov === "all" ? models : models.filter((m) => m.provider === prov)

  const apiKeyValue = async () => {
    const r = await fetch("/api/cli/connect?reveal=1")
    return ((await r.json()) as ConnectInfo).apiKey
  }

  return (
    <Section icon={Terminal} title="Thông tin kết nối" badge="Copy">
      {err && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{err}</p>
      )}

      {/* ── Địa chỉ ─────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">Địa chỉ</p>
        <CopyRow label="Base URL" value={url} />
        <CopyRow label="OpenAI" value={info?.gatewayUrl ?? ""} />
        <CopyRow label="Anthropic" value={info?.anthropicUrl ?? ""} />
        <p className="text-[11px] text-muted-foreground">
          Anthropic bỏ <code className="rounded bg-muted px-1">/v1</code> — agyproxy tự thêm prefix đúng theo provider.
        </p>
      </div>

      <Separator className="bg-border" />

      {/* ── Khoá ────────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">Khoá</p>
        <p className="text-[11px] text-muted-foreground">
          Hai loại KHÁC NHAU — dùng nhầm sẽ nhận 401 mà không rõ vì sao.
        </p>

        <CopyRow
          label="CLI token"
          value={tokenValue}
          display={info?.token ?? "—"}
          action={
            <Button
              size="sm"
              onClick={() => load(!revealed)}
              disabled={busy}
              className="h-7 gap-1.5 border border-border bg-transparent text-xs text-muted-foreground hover:text-foreground"
            >
              {revealed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {revealed ? "Ẩn" : "Hiện"}
            </Button>
          }
        />
        <p className="pl-30 text-[11px] text-muted-foreground">
          Điều khiển agyproxy (dashboard · CLI · MCP). <strong className="text-foreground">Toàn quyền</strong> —
          chỉ truyền qua mạng tin cậy hoặc HTTPS.
        </p>

        {info?.hasApiKey ? (
          <>
            <CopyRow label="API key" value={apiKeyValue} display={info.apiKey} />
            <p className="pl-30 text-[11px] text-muted-foreground">
              Gọi MODEL qua hai địa chỉ ở trên. Đây là key dùng chung (legacy).
            </p>
          </>
        ) : (
          <p className="text-[11px] text-warning">
            Chưa đặt API key gateway — vào Cấu hình để tạo, nếu không ai gọi cũng lọt.
          </p>
        )}

        {info?.keys?.length ? (
          <div className="mt-1 space-y-1">
            <p className="text-[11px] text-muted-foreground">
              Key riêng đã tạo ({info.keys.length}) — <strong className="text-foreground">không lấy lại được</strong>,
              chỉ hiện đúng một lần lúc tạo (server chỉ giữ mã băm):
            </p>
            <div className="flex flex-wrap gap-1.5">
              {info.keys.map((k) => (
                <span key={k.id} className="rounded-md border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground">
                  {k.name} · {k.prefix}…
                </span>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      <Separator className="bg-border" />

      {/* ── Model ───────────────────────────────────────────────────── */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-medium text-foreground">Model khả dụng ({models.length})</p>
          <div className="flex items-center gap-1">
            {["all", ...provs].map((v) => (
              <button
                key={v}
                onClick={() => setProv(v)}
                className={`rounded-md px-2 py-1 text-[11px] transition-colors ${
                  prov === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {v === "all" ? "Tất cả" : v}
              </button>
            ))}
            <CopyButton value={shown.map((m) => m.id).join("\n")} label="Copy tất cả" size="xs" />
          </div>
        </div>
        <div className="flex max-h-52 flex-wrap gap-1.5 overflow-y-auto rounded-lg border border-border p-2">
          {shown.map((m) => (
            <span key={m.id} className="inline-flex items-center gap-1 rounded-md border border-border bg-muted/40 px-2 py-0.5 font-mono text-[11px] text-foreground">
              {m.id}
              <CopyButton value={m.id} size="xs" title={`Copy ${m.id}`} />
            </span>
          ))}
          {!shown.length ? <span className="p-2 text-xs text-muted-foreground">Đang tải…</span> : null}
        </div>
      </div>

      <Separator className="bg-border" />

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">1 · Cài CLI trên máy tool</p>
        <CodeBlock code={`git clone https://github.com/mvng267/agy-proxy && cd agy-proxy && npm install`} />
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">2 · Kết nối (chạy một lần)</p>
        <CodeBlock code={`agyproxy connect ${url} --token ${revealed ? (info?.token ?? "") : "<bấm Copy ở trên>"}`} />
        <p className="text-[11px] text-muted-foreground">
          Lưu ở <code className="rounded bg-muted px-1">~/.agyproxy/cli.json</code> (chmod 600). Từ đây mọi lệnh chạy trên server này.
        </p>
      </div>

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">3 · Dùng</p>
        <CodeBlock code={`agyproxy ping                      # server sống không + độ trễ
agyproxy status                    # pool, cooldown, requests
agyproxy routes                    # liệt kê toàn bộ endpoint
agyproxy api /api/overview         # gọi thẳng API bất kỳ
agyproxy api PATCH /api/gateway/config '{"rotation":"smart"}'`} />
      </div>

      <Separator className="bg-border" />

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">Không cài CLI — dùng thẳng HTTP</p>
        <p className="text-[11px] text-muted-foreground">
          Token đi qua HTTP Basic, nên bất cứ thứ gì gọi được HTTP đều điều khiển được.
        </p>
        <CodeBlock code={`curl -u ":$AGY_TOKEN" ${url}/api/overview

# hoặc biến môi trường, hợp với CI/container
export AGY_URL=${url}
export AGY_TOKEN=<token>`} />
        <CodeBlock lang="python" code={`import requests
r = requests.get("${url}/api/overview", auth=("", TOKEN))`} />
      </div>

      <Separator className="bg-border" />

      <div className="space-y-2">
        <p className="text-xs font-medium text-foreground">Cắm coding agent vào pool</p>
        <CodeBlock code={`# Claude Code / Anthropic — base URL BỎ /v1
export ANTHROPIC_BASE_URL=${info?.anthropicUrl ?? url}
export ANTHROPIC_API_KEY=<API key ở tab API Keys>

# OpenAI-compatible
export OPENAI_BASE_URL=${info?.gatewayUrl ?? url + "/proxy/v1"}`} />
      </div>
    </Section>
  )
}


// ── Thử API ngay trên tab ───────────────────────────────────────────────

/**
 * Gọi thử endpoint ngay trong dashboard.
 *
 * Lý do có mục này: `agyproxy routes` liệt kê ~88 endpoint, nhưng biết TÊN endpoint chưa
 * đủ để biết nó trả về gì. Thử ngay tại chỗ rồi mới đi viết tool thì nhanh hơn nhiều so
 * với đoán shape rồi sửa dần.
 *
 * Dùng phiên đăng nhập sẵn có, KHÔNG cần token — token chỉ cần cho tool ở máy khác.
 */
function ApiTryer() {
  const [method, setMethod] = useState("GET")
  const [path, setPath] = useState("/api/overview")
  const [body, setBody] = useState("")
  const [res, setRes] = useState<string | null>(null)
  const [status, setStatus] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true); setRes(null); setStatus(null)
    try {
      const opt: RequestInit = { method }
      if (method !== "GET" && body.trim()) {
        opt.headers = { "content-type": "application/json" }
        opt.body = body
      }
      const r = await fetch(path.startsWith("/") ? path : `/${path}`, opt)
      setStatus(r.status)
      const t = await r.text()
      try { setRes(JSON.stringify(JSON.parse(t), null, 2)) } catch { setRes(t) }
    } catch (e) {
      setRes(e instanceof Error ? e.message : "Lỗi gọi API")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section icon={Zap} title="Thử API" badge="Sandbox">
      <p className="text-xs text-muted-foreground">
        Gọi thử bất kỳ endpoint nào bằng phiên đăng nhập hiện tại — để biết shape dữ liệu
        trước khi viết tool. Xem danh sách đầy đủ bằng <code className="rounded bg-muted px-1">agyproxy routes</code>.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={method} onValueChange={(v) => setMethod(v ?? "GET")}>
          <SelectTrigger className="h-8 w-28 text-xs"><span>{method}</span></SelectTrigger>
          <SelectContent>
            {["GET", "POST", "PATCH", "DELETE"].map((m) => (
              <SelectItem key={m} value={m} className="text-xs">{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="/api/overview"
          className="h-8 flex-1 min-w-[220px] font-mono text-xs"
        />
        <Button size="sm" onClick={run} disabled={busy} className="h-8 gap-1.5 text-xs">
          {busy ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
          Gọi
        </Button>
      </div>

      {method !== "GET" && (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder='{"rotation":"smart"}'
          rows={3}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        />
      )}

      <div className="flex flex-wrap gap-1.5">
        {[
          ["GET", "/api/overview"],
          ["GET", "/api/metrics"],
          ["GET", "/api/gateway/accounts?provider=agy"],
          ["GET", "/api/gateway/quota/history?range=7d"],
          ["GET", "/api/metrics/history?hours=6"],
        ].map(([m, pth]) => (
          <button
            key={pth}
            onClick={() => { setMethod(m!); setPath(pth!) }}
            className="rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {pth}
          </button>
        ))}
      </div>

      {res != null && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Badge className={status && status < 400 ? "bg-success/15 text-success" : "bg-destructive/15 text-destructive"}>
              HTTP {status}
            </Badge>
            <span className="text-[11px] text-muted-foreground">{res.length.toLocaleString("vi-VN")} ký tự</span>
          </div>
          <pre className="max-h-80 overflow-auto rounded-xl border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground">
            {res.length > 20000 ? res.slice(0, 20000) + "\n… (cắt bớt)" : res}
          </pre>
        </div>
      )}
    </Section>
  )
}

// ── CLITools Page ────────────────────────────────────────────────────────

export function CLITools() {
  return (
    <div className="space-y-4">
      <PageHeader
        title="CLI Tools"
        desc="Kết nối tool ngoài, thử API, và hướng dẫn cắm coding agent vào pool"
      />

      <ConnectPanel />

      <ApiTryer />

      {/* Quick setup */}
      <Section icon={Terminal} title="Cài đặt nhanh" badge="Setup">
        <p className="text-xs text-muted-foreground">
          Cài Claude Code trỏ vào agyproxy để dùng nhiều account:
        </p>
        <CodeBlock
          lang="bash"
          code={`# Cài claude code (nếu chưa có)
npm install -g @anthropic-ai/claude-code

# Cấu hình base URL trỏ vào agyproxy
export ANTHROPIC_BASE_URL=http://localhost:7788
export ANTHROPIC_API_KEY=any-key

# Hoặc dùng .env
echo 'ANTHROPIC_BASE_URL=http://localhost:7788' >> ~/.bashrc
echo 'ANTHROPIC_API_KEY=placeholder' >> ~/.bashrc`}
        />

        <div className="flex items-start gap-2 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2.5">
          <ChevronRight className="h-3.5 w-3.5 text-primary flex-shrink-0 mt-0.5" />
          <p className="text-xs text-primary">
            <strong>Lưu ý:</strong> base URL bỏ <code className="bg-muted px-1 rounded">/v1</code> — agyproxy tự thêm prefix đúng theo provider.
          </p>
        </div>
      </Section>

      {/* Gọi theo task */}
      <Section icon={Zap} title="Gọi Claude theo task">
        <p className="text-xs text-muted-foreground">
          Ví dụ gọi API trực tiếp qua agyproxy:
        </p>

        <div className="space-y-3">
          <div>
            <p className="text-xs text-muted-foreground mb-2">Basic chat request</p>
            <CodeBlock
              lang="bash"
              code={`curl http://localhost:7788/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer any-key" \\
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role":"user","content":"Hello!"}]
  }'`}
            />
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-2">Stream response</p>
            <CodeBlock
              lang="bash"
              code={`curl http://localhost:7788/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-5",
    "stream": true,
    "messages": [{"role":"user","content":"Write a poem"}]
  }'`}
            />
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-2">Dùng Python SDK</p>
            <CodeBlock
              lang="python"
              code={`import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:7788",
    api_key="placeholder"
)

message = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)`}
            />
          </div>
        </div>
      </Section>

      <Separator className="bg-muted" />

      {/* Combo management */}
      <Section icon={Shuffle} title="Quản lý Combo" badge="Advanced">
        <p className="text-xs text-muted-foreground">
          Combo cho phép nhóm nhiều models với chiến lược round-robin hoặc fallback:
        </p>

        <div className="space-y-3">
          <div>
            <p className="text-xs text-muted-foreground mb-2">Tạo combo mới</p>
            <CodeBlock
              lang="bash"
              code={`curl -X POST http://localhost:7788/api/combos \\
  -H "Content-Type: application/json" \\
  -d '{
    "id": "my-combo",
    "targets": ["claude-sonnet-4-5", "claude-haiku-3-5"],
    "strategy": "round-robin",
    "enabled": true
  }'`}
            />
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-2">Liệt kê combos</p>
            <CodeBlock
              lang="bash"
              code={`curl http://localhost:7788/api/combos`}
            />
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-2">Xoá combo</p>
            <CodeBlock
              lang="bash"
              code={`curl -X DELETE http://localhost:7788/api/combos/my-combo`}
            />
          </div>

          <div>
            <p className="text-xs text-muted-foreground mb-2">Dùng combo trong request</p>
            <CodeBlock
              lang="bash"
              code={`# Dùng combo id làm model name
curl http://localhost:7788/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "my-combo",
    "messages": [{"role":"user","content":"Hi"}]
  }'`}
            />
          </div>
        </div>
      </Section>

      {/* Setup Hermes */}
      <Section icon={Terminal} title="Setup Hermes / OmniRoute">
        <p className="text-xs text-muted-foreground">
          Kết nối Hermes để dùng nhiều provider:
        </p>
        <CodeBlock
          lang="bash"
          code={`# Clone và cài
git clone https://github.com/your/hermes
cd hermes && npm install

# Cấu hình
cp .env.example .env
# Sửa AGYPROXY_URL=http://localhost:7788

# Chạy
npm start`}
        />

        <div className="mt-2 grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="bg-muted/50 rounded-lg px-3 py-2">
            <p className="text-[10px] text-muted-foreground mb-1">Endpoint</p>
            <code className="text-xs text-primary">POST /v1/chat/completions</code>
          </div>
          <div className="bg-muted/50 rounded-lg px-3 py-2">
            <p className="text-[10px] text-muted-foreground mb-1">Events</p>
            <code className="text-xs text-info">GET /events (SSE)</code>
          </div>
        </div>
      </Section>

      {/* Tips */}
      <Card className="bg-muted/30">
        <CardContent className="pt-4">
          <ul className="space-y-2">
            {[
              "Agyproxy tự động xoay vòng accounts khi một account bị cooldown",
              "Cooldown tự động reset sau khi hết thời gian (mặc định 60s)",
              "Dùng /events SSE để theo dõi log realtime",
              "Quota summary có sẵn tại /api/gateway/quota-summary",
              "Models list tại /api/gateway/models — trả về tất cả model hỗ trợ",
            ].map((tip, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-muted-foreground">
                <ChevronRight className="h-3 w-3 text-primary flex-shrink-0 mt-0.5" />
                {tip}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

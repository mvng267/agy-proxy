import { useState } from "react"
import {
  Terminal,
  Copy,
  Check,
  ChevronRight,
  Zap,
  Shuffle,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"

// ── Types ──────────────────────────────────────────────────────────────

interface CodeBlockProps {
  code: string
  lang?: string
}

// ── Code Block ──────────────────────────────────────────────────────────

function CodeBlock({ code, lang = "bash" }: CodeBlockProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // ignore
    }
  }

  return (
    <div className="relative group rounded-xl bg-background border border-border overflow-hidden">
      {lang && (
        <div className="flex items-center justify-between px-4 py-1.5 border-b border-border bg-card/50">
          <span className="text-[10px] text-muted-foreground font-mono uppercase">{lang}</span>
          <button
            onClick={handleCopy}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
          >
            {copied ? (
              <>
                <Check className="h-3 w-3 text-emerald-400" />
                <span className="text-emerald-400">Copied!</span>
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                Copy
              </>
            )}
          </button>
        </div>
      )}
      <pre className="p-4 text-xs text-foreground overflow-x-auto leading-relaxed whitespace-pre">
        <code>{code}</code>
      </pre>
    </div>
  )
}

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
    <Card className="bg-card border-border">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-foreground flex items-center gap-2">
          <Icon className="h-4 w-4 text-muted-foreground" />
          {title}
          {badge && (
            <Badge className="bg-orange-500/15 text-orange-400 border-none text-[10px]">
              {badge}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  )
}

// ── CLITools Page ────────────────────────────────────────────────────────

export function CLITools() {
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <Terminal className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-medium text-foreground">CLI Tools</h2>
      </div>

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

        <div className="flex items-start gap-2 bg-orange-500/5 border border-orange-500/20 rounded-lg px-3 py-2.5">
          <ChevronRight className="h-3.5 w-3.5 text-orange-400 flex-shrink-0 mt-0.5" />
          <p className="text-xs text-orange-300">
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

        <div className="grid grid-cols-2 gap-3 mt-2">
          <div className="bg-muted/50 rounded-lg px-3 py-2">
            <p className="text-[10px] text-muted-foreground mb-1">Endpoint</p>
            <code className="text-xs text-orange-400">POST /v1/chat/completions</code>
          </div>
          <div className="bg-muted/50 rounded-lg px-3 py-2">
            <p className="text-[10px] text-muted-foreground mb-1">Events</p>
            <code className="text-xs text-blue-400">GET /events (SSE)</code>
          </div>
        </div>
      </Section>

      {/* Tips */}
      <Card className="bg-muted/30 border-border">
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
                <ChevronRight className="h-3 w-3 text-orange-500 flex-shrink-0 mt-0.5" />
                {tip}
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  )
}

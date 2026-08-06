import { useEffect, useState, useCallback } from "react"
import {
  Users,
  Search,
  RefreshCw,
  AlertTriangle,
  Shield,
  ShieldOff,
  Snowflake,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"

// ── Types ──────────────────────────────────────────────────────────────

interface Account {
  email: string
  provider: string
  status: string
  cooldownUntil?: string
  health?: number
  requests?: number
  lastUsed?: string
  enabled?: boolean
}

// ── Accounts Page ──────────────────────────────────────────────────────

export function Accounts() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [providerFilter, setProviderFilter] = useState<string>("all")
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const fetchAccounts = useCallback(async () => {
    try {
      const params = providerFilter !== "all" ? `?provider=${providerFilter}` : ""
      const res = await fetch(`/api/gateway/accounts${params}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { accounts: Account[] }
      setAccounts(json.accounts ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [providerFilter])

  useEffect(() => {
    setLoading(true)
    fetchAccounts()
    const interval = setInterval(fetchAccounts, 30_000)
    return () => clearInterval(interval)
  }, [fetchAccounts])

  const handleBulkToggle = async (enabled: boolean) => {
    if (selected.size === 0) return
    try {
      await fetch("/api/gateway/accounts/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails: [...selected], enabled }),
      })
      setSelected(new Set())
      fetchAccounts()
    } catch {
      // ignore
    }
  }

  const handleWake = async (provider: string) => {
    try {
      await fetch("/api/gateway/accounts/wake", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      })
      fetchAccounts()
    } catch {
      // ignore
    }
  }

  const filtered = accounts.filter((a) => {
    if (search && !a.email.toLowerCase().includes(search.toLowerCase())) return false
    return true
  })

  const toggleSelect = (email: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(email)) next.delete(email)
      else next.add(email)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set())
    } else {
      setSelected(new Set(filtered.map((a) => a.email)))
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-10 w-full bg-slate-800" />
        <Skeleton className="h-64 w-full bg-slate-800" />
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <AlertTriangle className="h-8 w-8 text-red-500" />
        <p className="text-sm text-slate-400">Error: {error}</p>
        <button
          onClick={fetchAccounts}
          className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1.5"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  const statusBadge = (status: string) => {
    switch (status) {
      case "active":
        return <Badge className="bg-emerald-500/15 text-emerald-400 border-none text-[10px]">Active</Badge>
      case "cooldown":
        return <Badge className="bg-orange-500/15 text-orange-400 border-none text-[10px]">Cooldown</Badge>
      default:
        return <Badge className="bg-slate-700 text-slate-400 border-none text-[10px]">{status}</Badge>
    }
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500" />
          <Input
            placeholder="Tìm email..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9 bg-slate-900 border-slate-800 text-slate-200 placeholder:text-slate-600 h-9 text-sm"
          />
        </div>
        <div className="flex items-center gap-2">
          {["all", "agy", "kiro"].map((p) => (
            <Button
              key={p}
              variant={providerFilter === p ? "default" : "outline"}
              size="sm"
              onClick={() => setProviderFilter(p)}
              className={
                providerFilter === p
                  ? "bg-orange-500 hover:bg-orange-600 text-white h-8 text-xs"
                  : "border-slate-700 text-slate-400 hover:text-slate-200 hover:bg-slate-800 h-8 text-xs"
              }
            >
              {p === "all" ? "Tất cả" : p.toUpperCase()}
            </Button>
          ))}
        </div>
      </div>

      {/* Bulk actions */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 bg-slate-800/50 rounded-lg px-4 py-2">
          <span className="text-xs text-slate-400">{selected.size} selected</span>
          <Button
            size="sm"
            onClick={() => handleBulkToggle(true)}
            className="bg-emerald-600 hover:bg-emerald-700 text-white h-7 text-xs gap-1"
          >
            <Shield className="h-3 w-3" /> Enable
          </Button>
          <Button
            size="sm"
            onClick={() => handleBulkToggle(false)}
            className="bg-red-600 hover:bg-red-700 text-white h-7 text-xs gap-1"
          >
            <ShieldOff className="h-3 w-3" /> Disable
          </Button>
        </div>
      )}

      {/* Table */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
              <Users className="h-4 w-4 text-slate-500" />
              Accounts ({filtered.length})
            </CardTitle>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleWake("agy")}
                className="border-slate-700 text-slate-400 hover:text-orange-400 h-7 text-xs gap-1"
              >
                <Snowflake className="h-3 w-3" /> Wake AGY
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleWake("kiro")}
                className="border-slate-700 text-slate-400 hover:text-orange-400 h-7 text-xs gap-1"
              >
                <Snowflake className="h-3 w-3" /> Wake Kiro
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="w-10">
                  <input
                    type="checkbox"
                    checked={filtered.length > 0 && selected.size === filtered.length}
                    onChange={toggleAll}
                    className="rounded border-slate-600 bg-slate-800"
                  />
                </TableHead>
                <TableHead className="text-slate-500 text-xs">Email</TableHead>
                <TableHead className="text-slate-500 text-xs">Provider</TableHead>
                <TableHead className="text-slate-500 text-xs">Status</TableHead>
                <TableHead className="text-slate-500 text-xs text-right">Requests</TableHead>
                <TableHead className="text-slate-500 text-xs">Last Used</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.length === 0 ? (
                <TableRow className="border-slate-800">
                  <TableCell colSpan={6} className="text-center text-slate-600 text-xs py-8">
                    Không có tài khoản
                  </TableCell>
                </TableRow>
              ) : (
                filtered.map((acc) => (
                  <TableRow key={acc.email} className="border-slate-800 hover:bg-slate-800/50">
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={selected.has(acc.email)}
                        onChange={() => toggleSelect(acc.email)}
                        className="rounded border-slate-600 bg-slate-800"
                      />
                    </TableCell>
                    <TableCell className="text-sm text-slate-200 font-mono">{acc.email}</TableCell>
                    <TableCell>
                      <Badge className="bg-slate-700 text-slate-300 border-none text-[10px]">
                        {acc.provider}
                      </Badge>
                    </TableCell>
                    <TableCell>{statusBadge(acc.status)}</TableCell>
                    <TableCell className="text-right text-sm text-slate-400 tabular-nums">
                      {(acc.requests ?? 0).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {acc.lastUsed ? new Date(acc.lastUsed).toLocaleString() : "—"}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}

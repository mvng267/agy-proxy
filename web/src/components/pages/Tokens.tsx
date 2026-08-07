import { useEffect, useState, useCallback } from "react"
import {
  KeyRound,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Clock,
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Skeleton } from "@/components/ui/skeleton"
import { Progress } from "@/components/ui/progress"

// ── Types ──────────────────────────────────────────────────────────────

interface TokenAccount {
  email: string
  provider: string
  status: string
  cooldownUntil?: string
  health?: number
  requests?: number
}

// ── Tokens Page ────────────────────────────────────────────────────────

export function Tokens() {
  const [accounts, setAccounts] = useState<TokenAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch("/api/gateway/accounts")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as { accounts: TokenAccount[] }
      setAccounts(json.accounts ?? [])
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchData()
    const interval = setInterval(fetchData, 30_000)
    return () => clearInterval(interval)
  }, [fetchData])

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
          onClick={fetchData}
          className="text-xs text-orange-400 hover:text-orange-300 flex items-center gap-1.5"
        >
          <RefreshCw className="h-3 w-3" /> Retry
        </button>
      </div>
    )
  }

  const healthy = accounts.filter((a) => a.status === "active").length
  const cooldown = accounts.filter((a) => a.status === "cooldown").length
  const total = accounts.length

  const statusIcon = (status: string) => {
    switch (status) {
      case "active":
        return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
      case "cooldown":
        return <Clock className="h-3.5 w-3.5 text-orange-500" />
      default:
        return <XCircle className="h-3.5 w-3.5 text-red-500" />
    }
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <p className="text-xs text-slate-500 uppercase tracking-wider">Total Tokens</p>
            <p className="text-2xl font-bold text-slate-100 tabular-nums">{total}</p>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <p className="text-xs text-slate-500 uppercase tracking-wider">Healthy</p>
            <p className="text-2xl font-bold text-emerald-400 tabular-nums">{healthy}</p>
          </CardContent>
        </Card>
        <Card className="bg-slate-900 border-slate-800">
          <CardContent className="pt-4">
            <p className="text-xs text-slate-500 uppercase tracking-wider">Cooldown</p>
            <p className="text-2xl font-bold text-orange-400 tabular-nums">{cooldown}</p>
          </CardContent>
        </Card>
      </div>

      {/* Table */}
      <Card className="bg-slate-900 border-slate-800">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-slate-500" />
            Token Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow className="border-slate-800 hover:bg-transparent">
                <TableHead className="text-slate-500 text-xs">Email</TableHead>
                <TableHead className="text-slate-500 text-xs">Provider</TableHead>
                <TableHead className="text-slate-500 text-xs">Status</TableHead>
                <TableHead className="text-slate-500 text-xs">Health</TableHead>
                <TableHead className="text-slate-500 text-xs">Cooldown Until</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {accounts.length === 0 ? (
                <TableRow className="border-slate-800">
                  <TableCell colSpan={5} className="text-center text-slate-600 text-xs py-8">
                    Không có token
                  </TableCell>
                </TableRow>
              ) : (
                accounts.map((acc) => (
                  <TableRow key={acc.email} className="border-slate-800 hover:bg-slate-800/50">
                    <TableCell className="text-sm text-slate-200 font-mono">{acc.email}</TableCell>
                    <TableCell>
                      <Badge className="bg-slate-700 text-slate-300 border-none text-[10px]">
                        {acc.provider}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        {statusIcon(acc.status)}
                        <span className="text-xs text-slate-400 capitalize">{acc.status}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2 min-w-[100px]">
                        <Progress value={acc.health ?? 0}>
                          <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                            <div
                              className={`h-full rounded-full transition-all duration-500 ${
                                (acc.health ?? 0) > 70 ? "bg-emerald-500" : (acc.health ?? 0) > 30 ? "bg-orange-500" : "bg-red-500"
                              }`}
                              style={{ width: `${acc.health ?? 0}%` }}
                            />
                          </div>
                        </Progress>
                        <span className="text-xs text-slate-500 tabular-nums w-8">{acc.health ?? 0}%</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-slate-500">
                      {acc.cooldownUntil
                        ? new Date(acc.cooldownUntil).toLocaleString()
                        : "—"}
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

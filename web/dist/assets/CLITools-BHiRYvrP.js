import{r as e}from"./rolldown-runtime-hePW80VL.js";import{p as t,z as n}from"./useButton-DuMlGO3V.js";import{i as r,n as i,r as a,t as o}from"./select-B6nFcKo4.js";import{u as s}from"./DataTable-CVKZcFwl.js";import{c,s as l}from"./common-CtPEbAG6.js";import{n as u,t as d}from"./eye-NT84jdaY.js";import{t as f}from"./terminal-2Mr2GMN8.js";import{T as p,f as m,g as h,m as g,p as _,y as v}from"./index-oJwj1-jx.js";import{i as y,n as b,r as x,t as S}from"./card-C2v1u2hR.js";import{t as C}from"./badge-Bj2otvcG.js";var w=e(n(),1),T=t();function E({icon:e,title:t,badge:n,children:r}){return(0,T.jsxs)(S,{children:[(0,T.jsx)(x,{className:`pb-3`,children:(0,T.jsxs)(y,{className:`text-sm font-medium text-foreground flex items-center gap-2`,children:[(0,T.jsx)(e,{className:`h-4 w-4 text-muted-foreground`}),t,n&&(0,T.jsx)(C,{className:`bg-primary/15 text-primary`,children:n})]})}),(0,T.jsx)(b,{className:`space-y-4`,children:r})]})}function D(){let[e,t]=(0,w.useState)(null),[n,r]=(0,w.useState)(!1),[i,a]=(0,w.useState)(!1),[o,s]=(0,w.useState)(null),p=(0,w.useCallback)(async e=>{a(!0),s(null);try{let n=await fetch(`/api/cli/connect${e?`?reveal=1`:``}`);if(!n.ok)throw Error(`HTTP ${n.status}`);t(await n.json()),r(e)}catch(e){s(e instanceof Error?e.message:`Không lấy được thông tin kết nối`)}finally{a(!1)}},[]);(0,w.useEffect)(()=>{p(!1)},[p]);let h=async()=>(await(await fetch(`/api/cli/connect?reveal=1`)).json()).token,_=e?.url??``,v=e?.token??``;return(0,T.jsxs)(E,{icon:f,title:`Kết nối tool ngoài`,badge:`Token`,children:[o&&(0,T.jsx)(`p`,{className:`rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive`,children:o}),(0,T.jsxs)(`div`,{className:`space-y-2`,children:[(0,T.jsxs)(`p`,{className:`text-xs text-muted-foreground`,children:[`Token CLI — cho `,(0,T.jsx)(`strong`,{className:`text-foreground`,children:`toàn quyền`}),` điều khiển gateway. Chỉ truyền qua mạng tin cậy (Tailscale/VPN) hoặc HTTPS.`]}),(0,T.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2`,children:[(0,T.jsx)(`code`,{className:`flex-1 min-w-[240px] truncate rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground`,children:i?`Đang tải…`:v||`—`}),(0,T.jsxs)(g,{size:`sm`,onClick:()=>p(!n),disabled:i,className:`h-8 gap-1.5 border border-border bg-transparent text-xs text-muted-foreground hover:text-foreground`,children:[n?(0,T.jsx)(u,{className:`h-3.5 w-3.5`}):(0,T.jsx)(d,{className:`h-3.5 w-3.5`}),n?`Ẩn`:`Hiện`]}),(0,T.jsx)(c,{value:h,label:`Copy`,className:`h-8 border border-border`})]})]}),(0,T.jsx)(m,{className:`bg-border`}),(0,T.jsxs)(`div`,{className:`space-y-2`,children:[(0,T.jsx)(`p`,{className:`text-xs font-medium text-foreground`,children:`1 · Cài CLI trên máy tool`}),(0,T.jsx)(l,{code:`git clone https://github.com/mvng267/agy-proxy && cd agy-proxy && npm install`})]}),(0,T.jsxs)(`div`,{className:`space-y-2`,children:[(0,T.jsx)(`p`,{className:`text-xs font-medium text-foreground`,children:`2 · Kết nối (chạy một lần)`}),(0,T.jsx)(l,{code:`agyproxy connect ${_} --token ${n?v:`<bấm Copy ở trên>`}`}),(0,T.jsxs)(`p`,{className:`text-[11px] text-muted-foreground`,children:[`Lưu ở `,(0,T.jsx)(`code`,{className:`rounded bg-muted px-1`,children:`~/.agyproxy/cli.json`}),` (chmod 600). Từ đây mọi lệnh chạy trên server này.`]})]}),(0,T.jsxs)(`div`,{className:`space-y-2`,children:[(0,T.jsx)(`p`,{className:`text-xs font-medium text-foreground`,children:`3 · Dùng`}),(0,T.jsx)(l,{code:`agyproxy ping                      # server sống không + độ trễ
agyproxy status                    # pool, cooldown, requests
agyproxy routes                    # liệt kê toàn bộ endpoint
agyproxy api /api/overview         # gọi thẳng API bất kỳ
agyproxy api PATCH /api/gateway/config '{"rotation":"smart"}'`})]}),(0,T.jsx)(m,{className:`bg-border`}),(0,T.jsxs)(`div`,{className:`space-y-2`,children:[(0,T.jsx)(`p`,{className:`text-xs font-medium text-foreground`,children:`Không cài CLI — dùng thẳng HTTP`}),(0,T.jsx)(`p`,{className:`text-[11px] text-muted-foreground`,children:`Token đi qua HTTP Basic, nên bất cứ thứ gì gọi được HTTP đều điều khiển được.`}),(0,T.jsx)(l,{code:`curl -u ":$AGY_TOKEN" ${_}/api/overview

# hoặc biến môi trường, hợp với CI/container
export AGY_URL=${_}
export AGY_TOKEN=<token>`}),(0,T.jsx)(l,{lang:`python`,code:`import requests
r = requests.get("${_}/api/overview", auth=("", TOKEN))`})]}),(0,T.jsx)(m,{className:`bg-border`}),(0,T.jsxs)(`div`,{className:`space-y-2`,children:[(0,T.jsx)(`p`,{className:`text-xs font-medium text-foreground`,children:`Cắm coding agent vào pool`}),(0,T.jsx)(l,{code:`# Claude Code / Anthropic — base URL BỎ /v1
export ANTHROPIC_BASE_URL=${e?.anthropicUrl??_}
export ANTHROPIC_API_KEY=<API key ở tab API Keys>

# OpenAI-compatible
export OPENAI_BASE_URL=${e?.gatewayUrl??_+`/proxy/v1`}`})]})]})}function O(){let[e,t]=(0,w.useState)(`GET`),[n,s]=(0,w.useState)(`/api/overview`),[c,l]=(0,w.useState)(``),[u,d]=(0,w.useState)(null),[f,m]=(0,w.useState)(null),[v,y]=(0,w.useState)(!1);return(0,T.jsxs)(E,{icon:h,title:`Thử API`,badge:`Sandbox`,children:[(0,T.jsxs)(`p`,{className:`text-xs text-muted-foreground`,children:[`Gọi thử bất kỳ endpoint nào bằng phiên đăng nhập hiện tại — để biết shape dữ liệu trước khi viết tool. Xem danh sách đầy đủ bằng `,(0,T.jsx)(`code`,{className:`rounded bg-muted px-1`,children:`agyproxy routes`}),`.`]}),(0,T.jsxs)(`div`,{className:`flex flex-wrap items-center gap-2`,children:[(0,T.jsxs)(o,{value:e,onValueChange:e=>t(e??`GET`),children:[(0,T.jsx)(r,{className:`h-8 w-28 text-xs`,children:(0,T.jsx)(`span`,{children:e})}),(0,T.jsx)(i,{children:[`GET`,`POST`,`PATCH`,`DELETE`].map(e=>(0,T.jsx)(a,{value:e,className:`text-xs`,children:e},e))})]}),(0,T.jsx)(_,{value:n,onChange:e=>s(e.target.value),placeholder:`/api/overview`,className:`h-8 flex-1 min-w-[220px] font-mono text-xs`}),(0,T.jsxs)(g,{size:`sm`,onClick:async()=>{y(!0),d(null),m(null);try{let t={method:e};e!==`GET`&&c.trim()&&(t.headers={"content-type":`application/json`},t.body=c);let r=await fetch(n.startsWith(`/`)?n:`/${n}`,t);m(r.status);let i=await r.text();try{d(JSON.stringify(JSON.parse(i),null,2))}catch{d(i)}}catch(e){d(e instanceof Error?e.message:`Lỗi gọi API`)}finally{y(!1)}},disabled:v,className:`h-8 gap-1.5 text-xs`,children:[v?(0,T.jsx)(p,{className:`h-3.5 w-3.5 animate-spin`}):(0,T.jsx)(h,{className:`h-3.5 w-3.5`}),`Gọi`]})]}),e!==`GET`&&(0,T.jsx)(`textarea`,{value:c,onChange:e=>l(e.target.value),placeholder:`{"rotation":"smart"}`,rows:3,className:`w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50`}),(0,T.jsx)(`div`,{className:`flex flex-wrap gap-1.5`,children:[[`GET`,`/api/overview`],[`GET`,`/api/metrics`],[`GET`,`/api/gateway/accounts?provider=agy`],[`GET`,`/api/gateway/quota/history?range=7d`],[`GET`,`/api/metrics/history?hours=6`]].map(([e,n])=>(0,T.jsx)(`button`,{onClick:()=>{t(e),s(n)},className:`rounded-md border border-border px-2 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground`,children:n},n))}),u!=null&&(0,T.jsxs)(`div`,{className:`space-y-1.5`,children:[(0,T.jsxs)(`div`,{className:`flex items-center gap-2`,children:[(0,T.jsxs)(C,{className:f&&f<400?`bg-success/15 text-success`:`bg-destructive/15 text-destructive`,children:[`HTTP `,f]}),(0,T.jsxs)(`span`,{className:`text-[11px] text-muted-foreground`,children:[u.length.toLocaleString(`vi-VN`),` ký tự`]})]}),(0,T.jsx)(`pre`,{className:`max-h-80 overflow-auto rounded-xl border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground`,children:u.length>2e4?u.slice(0,2e4)+`
… (cắt bớt)`:u})]})]})}function k(){return(0,T.jsxs)(`div`,{className:`space-y-4`,children:[(0,T.jsxs)(`div`,{className:`flex items-center gap-2`,children:[(0,T.jsx)(f,{className:`h-4 w-4 text-muted-foreground`}),(0,T.jsx)(`h2`,{className:`text-sm font-medium text-foreground`,children:`CLI Tools`})]}),(0,T.jsx)(D,{}),(0,T.jsx)(O,{}),(0,T.jsxs)(E,{icon:f,title:`Cài đặt nhanh`,badge:`Setup`,children:[(0,T.jsx)(`p`,{className:`text-xs text-muted-foreground`,children:`Cài Claude Code trỏ vào agyproxy để dùng nhiều account:`}),(0,T.jsx)(l,{lang:`bash`,code:`# Cài claude code (nếu chưa có)
npm install -g @anthropic-ai/claude-code

# Cấu hình base URL trỏ vào agyproxy
export ANTHROPIC_BASE_URL=http://localhost:7788
export ANTHROPIC_API_KEY=any-key

# Hoặc dùng .env
echo 'ANTHROPIC_BASE_URL=http://localhost:7788' >> ~/.bashrc
echo 'ANTHROPIC_API_KEY=placeholder' >> ~/.bashrc`}),(0,T.jsxs)(`div`,{className:`flex items-start gap-2 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2.5`,children:[(0,T.jsx)(s,{className:`h-3.5 w-3.5 text-primary flex-shrink-0 mt-0.5`}),(0,T.jsxs)(`p`,{className:`text-xs text-primary`,children:[(0,T.jsx)(`strong`,{children:`Lưu ý:`}),` base URL bỏ `,(0,T.jsx)(`code`,{className:`bg-muted px-1 rounded`,children:`/v1`}),` — agyproxy tự thêm prefix đúng theo provider.`]})]})]}),(0,T.jsxs)(E,{icon:h,title:`Gọi Claude theo task`,children:[(0,T.jsx)(`p`,{className:`text-xs text-muted-foreground`,children:`Ví dụ gọi API trực tiếp qua agyproxy:`}),(0,T.jsxs)(`div`,{className:`space-y-3`,children:[(0,T.jsxs)(`div`,{children:[(0,T.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Basic chat request`}),(0,T.jsx)(l,{lang:`bash`,code:`curl http://localhost:7788/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer any-key" \\
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role":"user","content":"Hello!"}]
  }'`})]}),(0,T.jsxs)(`div`,{children:[(0,T.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Stream response`}),(0,T.jsx)(l,{lang:`bash`,code:`curl http://localhost:7788/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-5",
    "stream": true,
    "messages": [{"role":"user","content":"Write a poem"}]
  }'`})]}),(0,T.jsxs)(`div`,{children:[(0,T.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Dùng Python SDK`}),(0,T.jsx)(l,{lang:`python`,code:`import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:7788",
    api_key="placeholder"
)

message = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)`})]})]})]}),(0,T.jsx)(m,{className:`bg-muted`}),(0,T.jsxs)(E,{icon:v,title:`Quản lý Combo`,badge:`Advanced`,children:[(0,T.jsx)(`p`,{className:`text-xs text-muted-foreground`,children:`Combo cho phép nhóm nhiều models với chiến lược round-robin hoặc fallback:`}),(0,T.jsxs)(`div`,{className:`space-y-3`,children:[(0,T.jsxs)(`div`,{children:[(0,T.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Tạo combo mới`}),(0,T.jsx)(l,{lang:`bash`,code:`curl -X POST http://localhost:7788/api/combos \\
  -H "Content-Type: application/json" \\
  -d '{
    "id": "my-combo",
    "targets": ["claude-sonnet-4-5", "claude-haiku-3-5"],
    "strategy": "round-robin",
    "enabled": true
  }'`})]}),(0,T.jsxs)(`div`,{children:[(0,T.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Liệt kê combos`}),(0,T.jsx)(l,{lang:`bash`,code:`curl http://localhost:7788/api/combos`})]}),(0,T.jsxs)(`div`,{children:[(0,T.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Xoá combo`}),(0,T.jsx)(l,{lang:`bash`,code:`curl -X DELETE http://localhost:7788/api/combos/my-combo`})]}),(0,T.jsxs)(`div`,{children:[(0,T.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Dùng combo trong request`}),(0,T.jsx)(l,{lang:`bash`,code:`# Dùng combo id làm model name
curl http://localhost:7788/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "my-combo",
    "messages": [{"role":"user","content":"Hi"}]
  }'`})]})]})]}),(0,T.jsxs)(E,{icon:f,title:`Setup Hermes / OmniRoute`,children:[(0,T.jsx)(`p`,{className:`text-xs text-muted-foreground`,children:`Kết nối Hermes để dùng nhiều provider:`}),(0,T.jsx)(l,{lang:`bash`,code:`# Clone và cài
git clone https://github.com/your/hermes
cd hermes && npm install

# Cấu hình
cp .env.example .env
# Sửa AGYPROXY_URL=http://localhost:7788

# Chạy
npm start`}),(0,T.jsxs)(`div`,{className:`grid grid-cols-2 gap-3 mt-2`,children:[(0,T.jsxs)(`div`,{className:`bg-muted/50 rounded-lg px-3 py-2`,children:[(0,T.jsx)(`p`,{className:`text-[10px] text-muted-foreground mb-1`,children:`Endpoint`}),(0,T.jsx)(`code`,{className:`text-xs text-primary`,children:`POST /v1/chat/completions`})]}),(0,T.jsxs)(`div`,{className:`bg-muted/50 rounded-lg px-3 py-2`,children:[(0,T.jsx)(`p`,{className:`text-[10px] text-muted-foreground mb-1`,children:`Events`}),(0,T.jsx)(`code`,{className:`text-xs text-info`,children:`GET /events (SSE)`})]})]})]}),(0,T.jsx)(S,{className:`bg-muted/30`,children:(0,T.jsx)(b,{className:`pt-4`,children:(0,T.jsx)(`ul`,{className:`space-y-2`,children:[`Agyproxy tự động xoay vòng accounts khi một account bị cooldown`,`Cooldown tự động reset sau khi hết thời gian (mặc định 60s)`,`Dùng /events SSE để theo dõi log realtime`,`Quota summary có sẵn tại /api/gateway/quota-summary`,`Models list tại /api/gateway/models — trả về tất cả model hỗ trợ`].map((e,t)=>(0,T.jsxs)(`li`,{className:`flex items-start gap-2 text-xs text-muted-foreground`,children:[(0,T.jsx)(s,{className:`h-3 w-3 text-primary flex-shrink-0 mt-0.5`}),e]},t))})})})]})}export{k as CLITools};
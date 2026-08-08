import{n as e,o as t,r as n}from"./createLucideIcon-DBOzt3oJ.js";import{t as r}from"./check-CsGeCdZY.js";import{t as i}from"./chevron-right-7G68Xu0q.js";import{t as a}from"./copy-Bm6QgHDz.js";import{t as o}from"./terminal-BYjljtbu.js";import{f as s,h as c,v as l}from"./index-CHpelw_-.js";import{i as u,n as d,r as f,t as p}from"./card-_joWov3S.js";import{t as m}from"./badge-BjCrURwi.js";var h=t(n(),1),g=e();function _({code:e,lang:t=`bash`}){let[n,i]=(0,h.useState)(!1);return(0,g.jsxs)(`div`,{className:`relative group rounded-xl bg-background border border-border overflow-hidden`,children:[t&&(0,g.jsxs)(`div`,{className:`flex items-center justify-between px-4 py-1.5 border-b border-border bg-card/50`,children:[(0,g.jsx)(`span`,{className:`text-[10px] text-muted-foreground font-mono uppercase`,children:t}),(0,g.jsx)(`button`,{onClick:async()=>{try{await navigator.clipboard.writeText(e),i(!0),setTimeout(()=>i(!1),2e3)}catch{}},className:`flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors`,children:n?(0,g.jsxs)(g.Fragment,{children:[(0,g.jsx)(r,{className:`h-3 w-3 text-success`}),(0,g.jsx)(`span`,{className:`text-success`,children:`Copied!`})]}):(0,g.jsxs)(g.Fragment,{children:[(0,g.jsx)(a,{className:`h-3 w-3`}),`Copy`]})})]}),(0,g.jsx)(`pre`,{className:`p-4 text-xs text-foreground overflow-x-auto leading-relaxed whitespace-pre`,children:(0,g.jsx)(`code`,{children:e})})]})}function v({icon:e,title:t,badge:n,children:r}){return(0,g.jsxs)(p,{className:`bg-card border-border`,children:[(0,g.jsx)(f,{className:`pb-3`,children:(0,g.jsxs)(u,{className:`text-sm font-medium text-foreground flex items-center gap-2`,children:[(0,g.jsx)(e,{className:`h-4 w-4 text-muted-foreground`}),t,n&&(0,g.jsx)(m,{className:`bg-primary/15 text-primary border-none text-[10px]`,children:n})]})}),(0,g.jsx)(d,{className:`space-y-4`,children:r})]})}function y(){return(0,g.jsxs)(`div`,{className:`space-y-4`,children:[(0,g.jsxs)(`div`,{className:`flex items-center gap-2`,children:[(0,g.jsx)(o,{className:`h-4 w-4 text-muted-foreground`}),(0,g.jsx)(`h2`,{className:`text-sm font-medium text-foreground`,children:`CLI Tools`})]}),(0,g.jsxs)(v,{icon:o,title:`Cài đặt nhanh`,badge:`Setup`,children:[(0,g.jsx)(`p`,{className:`text-xs text-muted-foreground`,children:`Cài Claude Code trỏ vào agyproxy để dùng nhiều account:`}),(0,g.jsx)(_,{lang:`bash`,code:`# Cài claude code (nếu chưa có)
npm install -g @anthropic-ai/claude-code

# Cấu hình base URL trỏ vào agyproxy
export ANTHROPIC_BASE_URL=http://localhost:7788
export ANTHROPIC_API_KEY=any-key

# Hoặc dùng .env
echo 'ANTHROPIC_BASE_URL=http://localhost:7788' >> ~/.bashrc
echo 'ANTHROPIC_API_KEY=placeholder' >> ~/.bashrc`}),(0,g.jsxs)(`div`,{className:`flex items-start gap-2 bg-primary/5 border border-primary/20 rounded-lg px-3 py-2.5`,children:[(0,g.jsx)(i,{className:`h-3.5 w-3.5 text-primary flex-shrink-0 mt-0.5`}),(0,g.jsxs)(`p`,{className:`text-xs text-primary`,children:[(0,g.jsx)(`strong`,{children:`Lưu ý:`}),` base URL bỏ `,(0,g.jsx)(`code`,{className:`bg-muted px-1 rounded`,children:`/v1`}),` — agyproxy tự thêm prefix đúng theo provider.`]})]})]}),(0,g.jsxs)(v,{icon:c,title:`Gọi Claude theo task`,children:[(0,g.jsx)(`p`,{className:`text-xs text-muted-foreground`,children:`Ví dụ gọi API trực tiếp qua agyproxy:`}),(0,g.jsxs)(`div`,{className:`space-y-3`,children:[(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Basic chat request`}),(0,g.jsx)(_,{lang:`bash`,code:`curl http://localhost:7788/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer any-key" \\
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role":"user","content":"Hello!"}]
  }'`})]}),(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Stream response`}),(0,g.jsx)(_,{lang:`bash`,code:`curl http://localhost:7788/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-5",
    "stream": true,
    "messages": [{"role":"user","content":"Write a poem"}]
  }'`})]}),(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Dùng Python SDK`}),(0,g.jsx)(_,{lang:`python`,code:`import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:7788",
    api_key="placeholder"
)

message = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)`})]})]})]}),(0,g.jsx)(s,{className:`bg-muted`}),(0,g.jsxs)(v,{icon:l,title:`Quản lý Combo`,badge:`Advanced`,children:[(0,g.jsx)(`p`,{className:`text-xs text-muted-foreground`,children:`Combo cho phép nhóm nhiều models với chiến lược round-robin hoặc fallback:`}),(0,g.jsxs)(`div`,{className:`space-y-3`,children:[(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Tạo combo mới`}),(0,g.jsx)(_,{lang:`bash`,code:`curl -X POST http://localhost:7788/api/combos \\
  -H "Content-Type: application/json" \\
  -d '{
    "id": "my-combo",
    "targets": ["claude-sonnet-4-5", "claude-haiku-3-5"],
    "strategy": "round-robin",
    "enabled": true
  }'`})]}),(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Liệt kê combos`}),(0,g.jsx)(_,{lang:`bash`,code:`curl http://localhost:7788/api/combos`})]}),(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Xoá combo`}),(0,g.jsx)(_,{lang:`bash`,code:`curl -X DELETE http://localhost:7788/api/combos/my-combo`})]}),(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-muted-foreground mb-2`,children:`Dùng combo trong request`}),(0,g.jsx)(_,{lang:`bash`,code:`# Dùng combo id làm model name
curl http://localhost:7788/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "my-combo",
    "messages": [{"role":"user","content":"Hi"}]
  }'`})]})]})]}),(0,g.jsxs)(v,{icon:o,title:`Setup Hermes / OmniRoute`,children:[(0,g.jsx)(`p`,{className:`text-xs text-muted-foreground`,children:`Kết nối Hermes để dùng nhiều provider:`}),(0,g.jsx)(_,{lang:`bash`,code:`# Clone và cài
git clone https://github.com/your/hermes
cd hermes && npm install

# Cấu hình
cp .env.example .env
# Sửa AGYPROXY_URL=http://localhost:7788

# Chạy
npm start`}),(0,g.jsxs)(`div`,{className:`grid grid-cols-2 gap-3 mt-2`,children:[(0,g.jsxs)(`div`,{className:`bg-muted/50 rounded-lg px-3 py-2`,children:[(0,g.jsx)(`p`,{className:`text-[10px] text-muted-foreground mb-1`,children:`Endpoint`}),(0,g.jsx)(`code`,{className:`text-xs text-primary`,children:`POST /v1/chat/completions`})]}),(0,g.jsxs)(`div`,{className:`bg-muted/50 rounded-lg px-3 py-2`,children:[(0,g.jsx)(`p`,{className:`text-[10px] text-muted-foreground mb-1`,children:`Events`}),(0,g.jsx)(`code`,{className:`text-xs text-info`,children:`GET /events (SSE)`})]})]})]}),(0,g.jsx)(p,{className:`bg-muted/30 border-border`,children:(0,g.jsx)(d,{className:`pt-4`,children:(0,g.jsx)(`ul`,{className:`space-y-2`,children:[`Agyproxy tự động xoay vòng accounts khi một account bị cooldown`,`Cooldown tự động reset sau khi hết thời gian (mặc định 60s)`,`Dùng /events SSE để theo dõi log realtime`,`Quota summary có sẵn tại /api/gateway/quota-summary`,`Models list tại /api/gateway/models — trả về tất cả model hỗ trợ`].map((e,t)=>(0,g.jsxs)(`li`,{className:`flex items-start gap-2 text-xs text-muted-foreground`,children:[(0,g.jsx)(i,{className:`h-3 w-3 text-primary flex-shrink-0 mt-0.5`}),e]},t))})})})]})}export{y as CLITools};
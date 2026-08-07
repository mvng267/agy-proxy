import{a as e,i as t,s as n}from"./createLucideIcon-CgERQC6d.js";import{t as r}from"./check-CLXJvsns.js";import{t as i}from"./chevron-right-B6MddFEq.js";import{t as a}from"./copy-C2Wwvf12.js";import{d as o,h as s,m as c,u as l}from"./index-Dtg_11SH.js";import{i as u,n as d,r as f,t as p}from"./card-DfRHY8uJ.js";import{t as m}from"./badge-cfEuD5wd.js";var h=n(e(),1),g=t();function _({code:e,lang:t=`bash`}){let[n,i]=(0,h.useState)(!1);return(0,g.jsxs)(`div`,{className:`relative group rounded-xl bg-slate-950 border border-slate-800 overflow-hidden`,children:[t&&(0,g.jsxs)(`div`,{className:`flex items-center justify-between px-4 py-1.5 border-b border-slate-800 bg-slate-900/50`,children:[(0,g.jsx)(`span`,{className:`text-[10px] text-slate-500 font-mono uppercase`,children:t}),(0,g.jsx)(`button`,{onClick:async()=>{try{await navigator.clipboard.writeText(e),i(!0),setTimeout(()=>i(!1),2e3)}catch{}},className:`flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors`,children:n?(0,g.jsxs)(g.Fragment,{children:[(0,g.jsx)(r,{className:`h-3 w-3 text-emerald-400`}),(0,g.jsx)(`span`,{className:`text-emerald-400`,children:`Copied!`})]}):(0,g.jsxs)(g.Fragment,{children:[(0,g.jsx)(a,{className:`h-3 w-3`}),`Copy`]})})]}),(0,g.jsx)(`pre`,{className:`p-4 text-xs text-slate-300 overflow-x-auto leading-relaxed whitespace-pre`,children:(0,g.jsx)(`code`,{children:e})})]})}function v({icon:e,title:t,badge:n,children:r}){return(0,g.jsxs)(p,{className:`bg-slate-900 border-slate-800`,children:[(0,g.jsx)(f,{className:`pb-3`,children:(0,g.jsxs)(u,{className:`text-sm font-medium text-slate-300 flex items-center gap-2`,children:[(0,g.jsx)(e,{className:`h-4 w-4 text-slate-500`}),t,n&&(0,g.jsx)(m,{className:`bg-orange-500/15 text-orange-400 border-none text-[10px]`,children:n})]})}),(0,g.jsx)(d,{className:`space-y-4`,children:r})]})}function y(){return(0,g.jsxs)(`div`,{className:`space-y-6`,children:[(0,g.jsxs)(`div`,{className:`flex items-center gap-2`,children:[(0,g.jsx)(c,{className:`h-4 w-4 text-slate-500`}),(0,g.jsx)(`h2`,{className:`text-sm font-medium text-slate-300`,children:`CLI Tools`})]}),(0,g.jsxs)(v,{icon:c,title:`Cài đặt nhanh`,badge:`Setup`,children:[(0,g.jsx)(`p`,{className:`text-xs text-slate-400`,children:`Cài Claude Code trỏ vào agyproxy để dùng nhiều account:`}),(0,g.jsx)(_,{lang:`bash`,code:`# Cài claude code (nếu chưa có)
npm install -g @anthropic-ai/claude-code

# Cấu hình base URL trỏ vào agyproxy
export ANTHROPIC_BASE_URL=http://localhost:7788
export ANTHROPIC_API_KEY=any-key

# Hoặc dùng .env
echo 'ANTHROPIC_BASE_URL=http://localhost:7788' >> ~/.bashrc
echo 'ANTHROPIC_API_KEY=placeholder' >> ~/.bashrc`}),(0,g.jsxs)(`div`,{className:`flex items-start gap-2 bg-orange-500/5 border border-orange-500/20 rounded-lg px-3 py-2.5`,children:[(0,g.jsx)(i,{className:`h-3.5 w-3.5 text-orange-400 flex-shrink-0 mt-0.5`}),(0,g.jsxs)(`p`,{className:`text-xs text-orange-300`,children:[(0,g.jsx)(`strong`,{children:`Lưu ý:`}),` base URL bỏ `,(0,g.jsx)(`code`,{className:`bg-slate-800 px-1 rounded`,children:`/v1`}),` — agyproxy tự thêm prefix đúng theo provider.`]})]})]}),(0,g.jsxs)(v,{icon:o,title:`Gọi Claude theo task`,children:[(0,g.jsx)(`p`,{className:`text-xs text-slate-400`,children:`Ví dụ gọi API trực tiếp qua agyproxy:`}),(0,g.jsxs)(`div`,{className:`space-y-3`,children:[(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-slate-500 mb-2`,children:`Basic chat request`}),(0,g.jsx)(_,{lang:`bash`,code:`curl http://localhost:7788/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer any-key" \\
  -d '{
    "model": "claude-sonnet-4-5",
    "messages": [{"role":"user","content":"Hello!"}]
  }'`})]}),(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-slate-500 mb-2`,children:`Stream response`}),(0,g.jsx)(_,{lang:`bash`,code:`curl http://localhost:7788/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "claude-sonnet-4-5",
    "stream": true,
    "messages": [{"role":"user","content":"Write a poem"}]
  }'`})]}),(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-slate-500 mb-2`,children:`Dùng Python SDK`}),(0,g.jsx)(_,{lang:`python`,code:`import anthropic

client = anthropic.Anthropic(
    base_url="http://localhost:7788",
    api_key="placeholder"
)

message = client.messages.create(
    model="claude-sonnet-4-5",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}]
)
print(message.content[0].text)`})]})]})]}),(0,g.jsx)(l,{className:`bg-slate-800`}),(0,g.jsxs)(v,{icon:s,title:`Quản lý Combo`,badge:`Advanced`,children:[(0,g.jsx)(`p`,{className:`text-xs text-slate-400`,children:`Combo cho phép nhóm nhiều models với chiến lược round-robin hoặc fallback:`}),(0,g.jsxs)(`div`,{className:`space-y-3`,children:[(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-slate-500 mb-2`,children:`Tạo combo mới`}),(0,g.jsx)(_,{lang:`bash`,code:`curl -X POST http://localhost:7788/api/combos \\
  -H "Content-Type: application/json" \\
  -d '{
    "id": "my-combo",
    "targets": ["claude-sonnet-4-5", "claude-haiku-3-5"],
    "strategy": "round-robin",
    "enabled": true
  }'`})]}),(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-slate-500 mb-2`,children:`Liệt kê combos`}),(0,g.jsx)(_,{lang:`bash`,code:`curl http://localhost:7788/api/combos`})]}),(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-slate-500 mb-2`,children:`Xoá combo`}),(0,g.jsx)(_,{lang:`bash`,code:`curl -X DELETE http://localhost:7788/api/combos/my-combo`})]}),(0,g.jsxs)(`div`,{children:[(0,g.jsx)(`p`,{className:`text-xs text-slate-500 mb-2`,children:`Dùng combo trong request`}),(0,g.jsx)(_,{lang:`bash`,code:`# Dùng combo id làm model name
curl http://localhost:7788/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "my-combo",
    "messages": [{"role":"user","content":"Hi"}]
  }'`})]})]})]}),(0,g.jsxs)(v,{icon:c,title:`Setup Hermes / OmniRoute`,children:[(0,g.jsx)(`p`,{className:`text-xs text-slate-400`,children:`Kết nối Hermes để dùng nhiều provider:`}),(0,g.jsx)(_,{lang:`bash`,code:`# Clone và cài
git clone https://github.com/your/hermes
cd hermes && npm install

# Cấu hình
cp .env.example .env
# Sửa AGYPROXY_URL=http://localhost:7788

# Chạy
npm start`}),(0,g.jsxs)(`div`,{className:`grid grid-cols-2 gap-3 mt-2`,children:[(0,g.jsxs)(`div`,{className:`bg-slate-800/50 rounded-lg px-3 py-2`,children:[(0,g.jsx)(`p`,{className:`text-[10px] text-slate-500 mb-1`,children:`Endpoint`}),(0,g.jsx)(`code`,{className:`text-xs text-orange-400`,children:`POST /v1/chat/completions`})]}),(0,g.jsxs)(`div`,{className:`bg-slate-800/50 rounded-lg px-3 py-2`,children:[(0,g.jsx)(`p`,{className:`text-[10px] text-slate-500 mb-1`,children:`Events`}),(0,g.jsx)(`code`,{className:`text-xs text-blue-400`,children:`GET /events (SSE)`})]})]})]}),(0,g.jsx)(p,{className:`bg-slate-800/30 border-slate-800`,children:(0,g.jsx)(d,{className:`pt-4`,children:(0,g.jsx)(`ul`,{className:`space-y-2`,children:[`Agyproxy tự động xoay vòng accounts khi một account bị cooldown`,`Cooldown tự động reset sau khi hết thời gian (mặc định 60s)`,`Dùng /events SSE để theo dõi log realtime`,`Quota summary có sẵn tại /api/gateway/quota-summary`,`Models list tại /api/gateway/models — trả về tất cả model hỗ trợ`].map((e,t)=>(0,g.jsxs)(`li`,{className:`flex items-start gap-2 text-xs text-slate-400`,children:[(0,g.jsx)(i,{className:`h-3 w-3 text-orange-500 flex-shrink-0 mt-0.5`}),e]},t))})})})]})}export{y as CLITools};
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import { readFileSync } from 'fs'

// Version lấy từ package.json GỐC (không phải web/) — đó là version thật của sản phẩm.
// Trước đây sidebar hard-code 'v2.14.0' trong khi thực tế đã là 2.15.0.
const rootPkg = JSON.parse(readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as { version: string }

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(rootPkg.version) },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:7788',
      '/events': 'http://localhost:7788',
      '/proxy': 'http://localhost:7788',
    },
  },
})

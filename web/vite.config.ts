import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:8083',
        changeOrigin: true,
        timeout: 600000,
        configure: (proxy) => {
          proxy.on('proxyReq', (_proxyReq, _req, _res) => {
            // SSE 请求不设 socket timeout
            _proxyReq.socket?.setTimeout(0)
          })
          proxy.on('proxyRes', (proxyRes, _req, _res) => {
            // 确保 SSE 响应不被缓冲
            if (proxyRes.headers['content-type']?.includes('text/event-stream')) {
              _res.socket?.setTimeout(0)
            }
          })
        },
      },
    },
  },
})

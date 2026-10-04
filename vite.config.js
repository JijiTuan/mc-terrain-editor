import { defineConfig } from 'vite'

/**
 * 桌面版（Electron）用 file:// 加载 dist/index.html，
 * 绝对路径 /assets/xxx 在 file:// 下会被解析成磁盘根目录而 404 —— 必须用相对路径。
 * 所以这里 base 固定为 './'，而不是默认的 '/'。
 *
 * 副作用是本地起 HTTP 服务预览 dist 时资源路径也变成相对，同样能正常工作。
 */
export default defineConfig({
  base: './',
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
  },
})

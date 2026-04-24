import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'

const handleElectronOnStart = (options: { reload: () => void }) => {
  options.reload()
}

export default defineConfig({
  base: './',
  server: {
    // Windows 上 Hyper-V/WSL 动态端口保留区（netsh int ipv4 show excludedportrange）
    // 实际占用了 5142-5241、5387-5586 等多段，触发 EACCES。
    // 5300 落在 5242-5356 的间隙中央，缓冲充足。
    port: 5300,
    strictPort: false
  },
  build: {
    chunkSizeWarningLimit: 900,
    commonjsOptions: {
      ignoreDynamicRequires: true
    }
  },
  optimizeDeps: {
    exclude: []
  },
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'better-sqlite3',
                'koffi',
                'fsevents',
                'whisper-node',
                'shelljs',
                'exceljs',
                'node-llama-cpp',
                '@vscode/sudo-prompt'
              ]
            }
          }
        }
      },
      {
        entry: 'electron/annualReportWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'koffi',
                'fsevents'
              ],
              output: {
                entryFileNames: 'annualReportWorker.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      },
      {
        entry: 'electron/dualReportWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'koffi',
                'fsevents'
              ],
              output: {
                entryFileNames: 'dualReportWorker.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      },
      {
        entry: 'electron/imageSearchWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              output: {
                entryFileNames: 'imageSearchWorker.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      },
      {
        entry: 'electron/wcdbWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'better-sqlite3',
                'koffi',
                'fsevents'
              ],
              output: {
                entryFileNames: 'wcdbWorker.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      },
      {
        entry: 'electron/transcribeWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'sherpa-onnx-node'
              ],
              output: {
                entryFileNames: 'transcribeWorker.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      },
      {
        entry: 'electron/exportWorker.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: [
                'better-sqlite3',
                'koffi',
                'fsevents',
                'exceljs'
              ],
              output: {
                entryFileNames: 'exportWorker.js',
                inlineDynamicImports: true
              }
            }
          }
        }
      },
      {
        entry: 'electron/preload.ts',
        onstart: handleElectronOnStart,
        vite: {
          build: {
            outDir: 'dist-electron'
          }
        }
      }
    ]),
    renderer()
  ],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      '@': resolve(__dirname, 'src')
    }
  }
})

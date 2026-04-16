import { useState, useCallback } from 'react'
import { PlugZap, CheckCircle2, XCircle, Loader2 } from 'lucide-react'

interface Props {
  provider: 'openai' | 'anthropic'
  apiBaseUrl: string
  apiKey: string
  apiModel: string
  disabled?: boolean
}

const ERROR_LABELS: Record<string, string> = {
  unreachable: 'API 地址不可达 / 超时',
  auth: '鉴权失败',
  model_not_found: '模型不存在',
  bad_response: '返回格式异常',
  rate_limit: '请求过于频繁 (429)',
  http: 'HTTP 错误',
  unknown: '未知错误'
}

export function AiConnectionTester({ provider, apiBaseUrl, apiKey, apiModel, disabled }: Props) {
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<Awaited<ReturnType<typeof window.electronAPI.ai.testConnection>> | null>(null)

  const handleTest = useCallback(async () => {
    setTesting(true)
    setResult(null)
    try {
      const r = await window.electronAPI.ai.testConnection({
        provider,
        apiBaseUrl: apiBaseUrl.trim(),
        apiKey: apiKey.trim(),
        model: apiModel.trim()
      })
      setResult(r)
    } catch (e) {
      setResult({ success: false, errorKind: 'unknown', errorMessage: (e as Error).message })
    } finally {
      setTesting(false)
    }
  }, [provider, apiBaseUrl, apiKey, apiModel])

  const canTest = !!(apiBaseUrl.trim() && apiKey.trim() && apiModel.trim())

  return (
    <div className="ai-tester">
      <button
        type="button"
        className="ai-tester-btn"
        onClick={handleTest}
        disabled={testing || disabled || !canTest}
        title={canTest ? '测试连接' : '请先填写完整配置'}
      >
        {testing ? <Loader2 size={14} className="spin" /> : <PlugZap size={14} />}
        {testing ? '测试中...' : '测试连接'}
      </button>

      {result && (
        <div className={`ai-tester-result ${result.success ? 'success' : 'error'}`}>
          {result.success ? (
            <div className="ai-tester-msg">
              <CheckCircle2 size={14} />
              <span>连接成功，模型响应正常</span>
              <span className="ai-tester-meta">
                {typeof result.latencyMs === 'number' && `${result.latencyMs} ms`}
                {result.returnedModel && ` · ${result.returnedModel}`}
              </span>
            </div>
          ) : (
            <details className="ai-tester-details">
              <summary>
                <XCircle size={14} />
                <span>{ERROR_LABELS[result.errorKind || 'unknown']}</span>
                {typeof result.statusCode === 'number' && result.statusCode > 0 && (
                  <span className="ai-tester-meta">HTTP {result.statusCode}</span>
                )}
              </summary>
              <div className="ai-tester-body">
                <div className="ai-tester-row"><strong>原因：</strong>{result.errorMessage || '无'}</div>
                {result.rawSnippet && (
                  <div className="ai-tester-row">
                    <strong>原始响应：</strong>
                    <pre>{result.rawSnippet}</pre>
                  </div>
                )}
              </div>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

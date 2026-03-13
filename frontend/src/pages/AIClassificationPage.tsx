import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { aiClassificationApi } from '@/services/api'
import { TrashIcon } from '@heroicons/react/24/outline'
import { parseExcelForUpload } from '@/utils/excelParser'

// Types
interface AIStatus {
  model_version: string
  is_trained: boolean
  training_samples: number
  total_classifications: number
  correct_classifications: number
  corrected_classifications: number
  accuracy_rate: number
  last_trained_at: string | null
  model_accuracy: number | null
  upload_count: number
  completed_uploads: number
  total_raw_transactions: number
  latest_upload: {
    id: number
    filename: string
    row_count: number
    saved_count: number
    status: string
    created_at: string
  } | null
}

interface UploadHistoryItem {
  id: number
  filename: string
  file_size: number
  file_type: string
  upload_type: string
  row_count: number
  saved_count: number
  error_count: number
  status: string
  error_message: string | null
  created_at: string
}

interface Account {
  id: number
  code: string
  name: string
  category: string
}

interface ClassificationResult {
  row_index: number
  description: string
  merchant_name: string
  amount: number
  predicted_account_code: string
  predicted_account_name: string
  confidence: number
  auto_confirm: boolean
  needs_review: boolean
  review_reasons: string[]
  reasoning: string
  actual_account_code?: string
  alternatives: Array<{
    account_code: string
    account_name: string
    confidence: number
  }>
}

type TabType = 'status' | 'upload' | 'classify' | 'results'

export default function AIClassificationPage() {
  const [activeTab, setActiveTab] = useState<TabType>('status')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)

  // Upload states
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadResult, setUploadResult] = useState<any>(null)

  // Classify states
  const [classifyFile, setClassifyFile] = useState<File | null>(null)
  const [classificationResults, setClassificationResults] = useState<ClassificationResult[]>([])
  const [classifyStats, setClassifyStats] = useState<any>(null)

  // Results filter/sort states
  const [resultFilter, setResultFilter] = useState<'all' | 'review' | 'confirmed'>('all')
  const [resultSort, setResultSort] = useState<'default' | 'confidence_asc' | 'confidence_desc'>('default')

  const queryClient = useQueryClient()

  // React Query - fetch status
  const { data: status } = useQuery<AIStatus>({
    queryKey: ['aiStatus'],
    queryFn: () => aiClassificationApi.getStatus().then((r) => r.data),
    retry: 3,
    retryDelay: 1000,
  })

  // React Query - fetch upload history
  const { data: uploadHistory } = useQuery<UploadHistoryItem[]>({
    queryKey: ['aiUploadHistory'],
    queryFn: () => aiClassificationApi.getUploadHistory().then((r) => r.data),
    retry: 3,
    retryDelay: 1000,
  })

  // React Query - fetch accounts
  const { data: accounts = [] } = useQuery<Account[]>({
    queryKey: ['aiAccounts'],
    queryFn: () => aiClassificationApi.getAccounts().then((r) => r.data),
    retry: 3,
  })

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    // 에러는 15초, 성공은 5초
    setTimeout(() => setMessage(null), type === 'error' ? 15000 : 5000)
  }

  const refreshData = () => {
    queryClient.invalidateQueries({ queryKey: ['aiStatus'] })
    queryClient.invalidateQueries({ queryKey: ['aiUploadHistory'] })
    queryClient.invalidateQueries({ queryKey: ['financialUploadHistory'] })
  }

  // Upload progress state
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)

  // Handle historical data upload - 클라이언트 사이드 파싱 + 배치 전송
  const handleUploadHistorical = async () => {
    if (!uploadFile) {
      showMessage('error', '파일을 선택해주세요.')
      return
    }
    setLoading(true)
    setUploadProgress('파일 파싱 중... (브라우저에서 처리)')

    try {
      // Step 1: 브라우저에서 엑셀 파싱
      const { rows, sheetCount, sheetsProcessed } = await parseExcelForUpload(uploadFile)

      if (rows.length === 0) {
        showMessage('error', '파싱된 데이터가 없습니다. 파일 형식을 확인해주세요.')
        setLoading(false)
        setUploadProgress(null)
        return
      }

      setUploadProgress(`${rows.length.toLocaleString()}행 파싱 완료. 서버로 전송 시작...`)

      // 모든 고유 계정코드 수집 (첫 배치에서 일괄 생성용)
      const allCodes = new Set<string>()
      for (const r of rows) {
        allCodes.add(r.account_code)
        if (r.source_account_code) allCodes.add(r.source_account_code)
      }

      // Step 2: 3000행씩 배치로 서버 전송
      const BATCH_SIZE = 3000
      const totalBatches = Math.ceil(rows.length / BATCH_SIZE)
      let uploadId: number | null = null
      let totalSaved = 0

      for (let i = 0; i < totalBatches; i++) {
        const batch = rows.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)
        const response = await aiClassificationApi.uploadHistoricalBatch({
          upload_id: uploadId,
          filename: uploadFile.name,
          file_size: uploadFile.size,
          batch_index: i,
          total_batches: totalBatches,
          total_rows: rows.length,
          rows: batch,
          ...(i === 0 ? { all_account_codes: Array.from(allCodes) } : {}),
        })

        if (i === 0) {
          uploadId = response.data.upload_id
        }
        totalSaved += response.data.saved_count || 0

        const pct = Math.round(((i + 1) / totalBatches) * 100)
        setUploadProgress(`서버 저장 중... ${pct}% (${(i + 1)}/${totalBatches} 배치)`)
      }

      showMessage('success', `${totalSaved.toLocaleString()}건 업로드 완료! (${sheetCount}개 시트 중 ${sheetsProcessed}개 처리)`)
      setUploadFile(null)
      setUploadProgress(null)
      setUploadResult({ total_rows: rows.length, saved_count: totalSaved })
      refreshData()

    } catch (error: any) {
      console.error('[Upload] 오류:', error)
      const detail = error.response?.data?.detail || error.message || '알 수 없는 오류'
      showMessage('error', `업로드 오류: ${detail}`)
      setUploadProgress(null)
    } finally {
      setLoading(false)
    }
  }

  // Handle delete upload
  const handleDeleteUpload = async (uploadId: number, filename: string) => {
    if (!confirm(`'${filename}' 데이터를 삭제하시겠습니까?\n관련 거래 데이터가 모두 삭제됩니다.`)) return
    setLoading(true)
    try {
      const response = await aiClassificationApi.deleteUpload(uploadId)
      showMessage('success', response.data.message)
      refreshData()
    } catch (error: any) {
      showMessage('error', error.response?.data?.detail || '삭제 실패')
    } finally {
      setLoading(false)
    }
  }

  // Handle model training
  const handleTrainModel = async () => {
    if (!status?.training_samples || status.training_samples < 50) {
      showMessage('error', '학습 데이터가 최소 50개 이상 필요합니다.')
      return
    }
    setLoading(true)
    try {
      const response = await aiClassificationApi.trainModel(50)
      showMessage('success', response.data.message)
      refreshData()
    } catch (error: any) {
      showMessage('error', error.response?.data?.detail || '학습 실패')
    } finally {
      setLoading(false)
    }
  }

  // Handle file classification
  const handleClassifyFile = async () => {
    if (!classifyFile) {
      showMessage('error', '분류할 파일을 선택해주세요.')
      return
    }
    setLoading(true)
    try {
      const response = await aiClassificationApi.classifyFile(classifyFile)
      setClassificationResults(response.data.results)
      setClassifyStats({
        total: response.data.total_rows,
        autoConfirmed: response.data.auto_confirmed,
        needsReview: response.data.needs_review,
        avgConfidence: response.data.average_confidence,
        reviewReasonCounts: response.data.review_reason_counts || {},
      })
      setActiveTab('results')
      showMessage('success', `${response.data.total_rows}개 항목 분류 완료`)
    } catch (error: any) {
      showMessage('error', error.response?.data?.detail || '분류 실패')
    } finally {
      setLoading(false)
    }
  }

  // Handle feedback submission
  const handleSubmitFeedback = async () => {
    const modifiedItems = classificationResults.filter(
      (r) => r.actual_account_code && r.actual_account_code !== r.predicted_account_code
    )
    if (modifiedItems.length === 0) {
      showMessage('error', '수정된 항목이 없습니다.')
      return
    }
    setLoading(true)
    try {
      const feedbackItems = modifiedItems.map((item) => ({
        description: item.description,
        merchant_name: item.merchant_name,
        amount: item.amount,
        predicted_account_code: item.predicted_account_code,
        actual_account_code: item.actual_account_code!,
      }))
      const response = await aiClassificationApi.submitFeedback(feedbackItems)
      showMessage('success', response.data.message)
      refreshData()
    } catch (error: any) {
      showMessage('error', error.response?.data?.detail || '피드백 제출 실패')
    } finally {
      setLoading(false)
    }
  }

  // Update classification result
  const updateClassificationResult = (index: number, accountCode: string) => {
    setClassificationResults((prev) =>
      prev.map((r, i) => (i === index ? { ...r, actual_account_code: accountCode } : r))
    )
  }

  // Download template
  const handleDownloadTemplate = async (type: 'historical' | 'classify') => {
    try {
      const response = await aiClassificationApi.downloadTemplate(type)
      const blob = new Blob([response.data])
      const url = window.URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = type === 'historical' ? 'historical_template.xlsx' : 'classify_template.xlsx'
      a.click()
      window.URL.revokeObjectURL(url)
    } catch {
      showMessage('error', '템플릿 다운로드 실패')
    }
  }

  const fmtNum = (v: number) => new Intl.NumberFormat('ko-KR').format(v)
  const fmtSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes}B`
    if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)}KB`
    return `${(bytes / 1048576).toFixed(1)}MB`
  }

  return (
    <div className="p-6 max-w-7xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">AI 계정 분류</h1>

      {message && (
        <div className={`mb-4 p-4 rounded-lg ${
          message.type === 'success'
            ? 'bg-green-100 text-green-800 border border-green-200'
            : 'bg-red-100 text-red-800 border border-red-200'
        }`}>
          {message.text}
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex space-x-8">
          {([
            { id: 'status', label: '상태/통계' },
            { id: 'upload', label: '과거 데이터 업로드' },
            { id: 'classify', label: '자동 분류' },
            { id: 'results', label: '분류 결과' },
          ] as const).map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`py-4 px-1 border-b-2 font-medium text-sm ${
                activeTab === tab.id
                  ? 'border-blue-500 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {/* Status Tab */}
      {activeTab === 'status' && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="bg-white p-6 rounded-lg shadow border">
              <h3 className="text-sm font-medium text-gray-500">모델 버전</h3>
              <p className="mt-2 text-2xl font-semibold">{status?.model_version || '-'}</p>
              <p className="text-sm text-gray-400">{status?.is_trained ? '학습됨' : '미학습'}</p>
            </div>
            <div className="bg-white p-6 rounded-lg shadow border">
              <h3 className="text-sm font-medium text-gray-500">학습 데이터</h3>
              <p className="mt-2 text-2xl font-semibold">{fmtNum(status?.training_samples || 0)}</p>
              <p className="text-sm text-gray-400">개 항목</p>
            </div>
            <div className="bg-white p-6 rounded-lg shadow border">
              <h3 className="text-sm font-medium text-gray-500">모델 정확도</h3>
              <p className="mt-2 text-2xl font-semibold">
                {status?.model_accuracy ? `${(status.model_accuracy * 100).toFixed(1)}%` : '-'}
              </p>
              <p className="text-sm text-gray-400">교차 검증 기준</p>
            </div>
            <div className="bg-white p-6 rounded-lg shadow border">
              <h3 className="text-sm font-medium text-gray-500">분류 정확도</h3>
              <p className="mt-2 text-2xl font-semibold">
                {status?.accuracy_rate ? `${status.accuracy_rate.toFixed(1)}%` : '-'}
              </p>
              <p className="text-sm text-gray-400">
                {status?.total_classifications || 0}건 중 {status?.correct_classifications || 0}건 정확
              </p>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow border">
            <h3 className="text-lg font-medium mb-4">업로드 통계</h3>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-3xl font-bold text-blue-600">{status?.completed_uploads || 0}</p>
                <p className="text-sm text-gray-500">완료된 업로드</p>
              </div>
              <div>
                <p className="text-3xl font-bold text-green-600">{fmtNum(status?.total_raw_transactions || 0)}</p>
                <p className="text-sm text-gray-500">보관된 거래 데이터</p>
              </div>
              <div>
                <p className="text-3xl font-bold text-purple-600">{fmtNum(status?.training_samples || 0)}</p>
                <p className="text-sm text-gray-500">학습 데이터</p>
              </div>
            </div>
          </div>

          {/* Upload History List */}
          <div className="bg-white p-6 rounded-lg shadow border">
            <h3 className="text-lg font-medium mb-4">업로드 이력</h3>
            {uploadHistory && uploadHistory.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">파일명</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">크기</th>
                      <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">저장건수</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">상태</th>
                      <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">업로드일</th>
                      <th className="px-4 py-3 text-center text-xs font-medium text-gray-500 uppercase">삭제</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {uploadHistory.map((u) => (
                      <tr key={u.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-sm font-medium">{u.filename}</td>
                        <td className="px-4 py-3 text-sm text-right text-gray-500">{fmtSize(u.file_size)}</td>
                        <td className="px-4 py-3 text-sm text-right">{fmtNum(u.saved_count || 0)}건</td>
                        <td className="px-4 py-3 text-center">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            u.status === 'completed' ? 'bg-green-100 text-green-700' :
                            u.status === 'processing' ? 'bg-yellow-100 text-yellow-700' :
                            'bg-red-100 text-red-700'
                          }`}>
                            {u.status === 'completed' ? '완료' : u.status === 'processing' ? '처리중' : '실패'}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-500">
                          {u.created_at ? new Date(u.created_at).toLocaleDateString('ko-KR') : '-'}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <button
                            onClick={() => handleDeleteUpload(u.id, u.filename)}
                            disabled={loading}
                            className="text-red-500 hover:text-red-700 disabled:opacity-50"
                            title="삭제"
                          >
                            <TrashIcon className="h-5 w-5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-center py-4 text-gray-400 text-sm">업로드 이력이 없습니다.</p>
            )}
          </div>

          {(status?.total_classifications ?? 0) > 0 && (
            <div className="bg-white p-6 rounded-lg shadow border">
              <h3 className="text-lg font-medium mb-4">분류 통계</h3>
              <div className="grid grid-cols-3 gap-4 text-center">
                <div>
                  <p className="text-3xl font-bold text-blue-600">{status?.total_classifications || 0}</p>
                  <p className="text-sm text-gray-500">총 분류</p>
                </div>
                <div>
                  <p className="text-3xl font-bold text-green-600">{status?.correct_classifications || 0}</p>
                  <p className="text-sm text-gray-500">정확 분류</p>
                </div>
                <div>
                  <p className="text-3xl font-bold text-orange-600">{status?.corrected_classifications || 0}</p>
                  <p className="text-sm text-gray-500">사용자 수정</p>
                </div>
              </div>
            </div>
          )}

          <div className="bg-white p-6 rounded-lg shadow border">
            <h3 className="text-lg font-medium mb-4">모델 관리</h3>
            <div className="flex gap-4">
              <button
                onClick={handleTrainModel}
                disabled={loading || !status?.training_samples || status.training_samples < 50}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                {loading ? '학습 중...' : '모델 재학습'}
              </button>
              <p className="text-sm text-gray-500 self-center">
                최소 50개 이상의 학습 데이터 필요 (현재: {fmtNum(status?.training_samples || 0)}개)
              </p>
            </div>
            {status?.last_trained_at && (
              <p className="mt-2 text-sm text-gray-400">
                마지막 학습: {new Date(status.last_trained_at).toLocaleString('ko-KR')}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Upload Tab */}
      {activeTab === 'upload' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-lg shadow border">
            <h3 className="text-lg font-medium mb-4">더존 과거 데이터 업로드</h3>
            <p className="text-sm text-gray-600 mb-4">
              더존에서 분류된 과거 데이터를 업로드하면 AI가 학습하여 자동 분류 정확도를 높입니다.
            </p>

            <div className="mb-4">
              <h4 className="font-medium mb-2">필수 컬럼:</h4>
              <ul className="text-sm text-gray-600 list-disc list-inside">
                <li><strong>적요</strong> (또는 거래내역, 내역) - 거래 설명</li>
                <li><strong>계정과목코드</strong> (또는 계정코드) - 분류된 계정 코드</li>
              </ul>
              <h4 className="font-medium mt-3 mb-2">선택 컬럼:</h4>
              <ul className="text-sm text-gray-600 list-disc list-inside">
                <li>거래처명 (또는 가맹점)</li>
                <li>금액</li>
                <li>계정과목명</li>
              </ul>
            </div>

            <div className="flex gap-4 mb-4">
              <button
                onClick={() => handleDownloadTemplate('historical')}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                템플릿 다운로드
              </button>
            </div>

            <div className="border-2 border-dashed border-gray-300 rounded-lg p-6">
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                className="mb-4"
              />
              {uploadFile && (
                <p className="text-sm text-gray-600 mb-4">선택된 파일: {uploadFile.name}</p>
              )}
              <button
                onClick={handleUploadHistorical}
                disabled={loading || !uploadFile}
                className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                {loading ? '업로드 중...' : '데이터 업로드'}
              </button>
              {uploadProgress && (
                <div className="mt-3 flex items-center gap-2 text-sm text-blue-700">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span>{uploadProgress}</span>
                </div>
              )}
            </div>

            {uploadResult && (
              <div className="mt-4 p-4 bg-blue-50 rounded-lg">
                <h4 className="font-medium">업로드 결과</h4>
                <p className="text-sm">총 {uploadResult.total_rows}개 행 중 {uploadResult.saved_count}개 저장됨</p>
                {uploadResult.error_count > 0 && (
                  <p className="text-sm text-red-600">{uploadResult.error_count}개 오류 발생</p>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Classify Tab */}
      {activeTab === 'classify' && (
        <div className="space-y-6">
          <div className="bg-white p-6 rounded-lg shadow border">
            <h3 className="text-lg font-medium mb-4">미분류 데이터 자동 분류</h3>
            <p className="text-sm text-gray-600 mb-4">
              분류되지 않은 거래 데이터를 업로드하면 AI가 자동으로 계정과목을 분류합니다.
            </p>

            {!status?.is_trained && (
              <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                <p className="text-sm text-yellow-800 mb-2">
                  AI 모델이 아직 학습되지 않았습니다.
                  {(status?.training_samples || 0) >= 50
                    ? ' 학습 데이터가 충분합니다. 아래 버튼으로 모델을 학습시켜주세요.'
                    : ' 먼저 과거 데이터를 업로드하고 모델을 학습시켜주세요.'}
                </p>
                {(status?.training_samples || 0) >= 50 && (
                  <button
                    onClick={handleTrainModel}
                    disabled={loading}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 text-sm"
                  >
                    {loading ? '학습 중...' : `모델 학습 시작 (${fmtNum(status?.training_samples || 0)}개 데이터)`}
                  </button>
                )}
              </div>
            )}

            <div className="mb-4">
              <h4 className="font-medium mb-2">필수 컬럼:</h4>
              <ul className="text-sm text-gray-600 list-disc list-inside">
                <li><strong>적요</strong> - 거래 설명</li>
              </ul>
              <h4 className="font-medium mt-3 mb-2">선택 컬럼:</h4>
              <ul className="text-sm text-gray-600 list-disc list-inside">
                <li>거래처명</li>
                <li>금액</li>
                <li>거래일자</li>
              </ul>
            </div>

            <div className="flex gap-4 mb-4">
              <button
                onClick={() => handleDownloadTemplate('classify')}
                className="px-4 py-2 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                템플릿 다운로드
              </button>
            </div>

            <div className="border-2 border-dashed border-gray-300 rounded-lg p-6">
              <input
                type="file"
                accept=".xlsx,.xls,.csv"
                onChange={(e) => setClassifyFile(e.target.files?.[0] || null)}
                className="mb-4"
              />
              {classifyFile && (
                <p className="text-sm text-gray-600 mb-4">선택된 파일: {classifyFile.name}</p>
              )}
              <button
                onClick={handleClassifyFile}
                disabled={loading || !classifyFile || !status?.is_trained}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                {loading ? '분류 중...' : '자동 분류 실행'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Results Tab */}
      {activeTab === 'results' && (
        <div className="space-y-6">
          {classifyStats && (
            <>
              <div className="grid grid-cols-4 gap-4">
                <div className="bg-white p-4 rounded-lg shadow border text-center">
                  <p className="text-2xl font-bold">{classifyStats.total}</p>
                  <p className="text-sm text-gray-500">총 항목</p>
                </div>
                <div className="bg-white p-4 rounded-lg shadow border text-center">
                  <p className="text-2xl font-bold text-green-600">{classifyStats.autoConfirmed}</p>
                  <p className="text-sm text-gray-500">자동 확정</p>
                </div>
                <div className="bg-white p-4 rounded-lg shadow border text-center cursor-pointer hover:ring-2 hover:ring-orange-300"
                  onClick={() => setResultFilter(resultFilter === 'review' ? 'all' : 'review')}
                >
                  <p className="text-2xl font-bold text-orange-600">{classifyStats.needsReview}</p>
                  <p className="text-sm text-gray-500">검토 필요</p>
                </div>
                <div className="bg-white p-4 rounded-lg shadow border text-center">
                  <p className="text-2xl font-bold">{(classifyStats.avgConfidence * 100).toFixed(1)}%</p>
                  <p className="text-sm text-gray-500">평균 신뢰도</p>
                </div>
              </div>

              {/* 검토 사유별 요약 */}
              {classifyStats.reviewReasonCounts && Object.keys(classifyStats.reviewReasonCounts).length > 0 && (
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-orange-800 mb-2">검토 필요 사유 요약</h4>
                  <div className="flex flex-wrap gap-2">
                    {Object.entries(classifyStats.reviewReasonCounts as Record<string, number>).map(([reason, count]) => (
                      <span key={reason} className="inline-flex items-center px-3 py-1 rounded-full text-sm bg-orange-100 text-orange-800 border border-orange-300">
                        {reason}: <span className="font-bold ml-1">{count}건</span>
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {classificationResults.length > 0 ? (
            <div className="bg-white rounded-lg shadow border overflow-hidden">
              <div className="p-4 border-b flex flex-wrap justify-between items-center gap-3">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-medium">분류 결과</h3>
                  {/* 필터 */}
                  <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm">
                    <button
                      onClick={() => setResultFilter('all')}
                      className={`px-3 py-1 ${resultFilter === 'all' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                    >
                      전체 ({classificationResults.length})
                    </button>
                    <button
                      onClick={() => setResultFilter('review')}
                      className={`px-3 py-1 border-l ${resultFilter === 'review' ? 'bg-orange-500 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                    >
                      검토 필요 ({classificationResults.filter(r => r.needs_review).length})
                    </button>
                    <button
                      onClick={() => setResultFilter('confirmed')}
                      className={`px-3 py-1 border-l ${resultFilter === 'confirmed' ? 'bg-green-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                    >
                      확정 ({classificationResults.filter(r => r.auto_confirm).length})
                    </button>
                  </div>
                  {/* 정렬 */}
                  <select
                    value={resultSort}
                    onChange={(e) => setResultSort(e.target.value as typeof resultSort)}
                    className="text-sm border border-gray-300 rounded-lg px-2 py-1"
                  >
                    <option value="default">기본순</option>
                    <option value="confidence_asc">신뢰도 낮은순</option>
                    <option value="confidence_desc">신뢰도 높은순</option>
                  </select>
                </div>
                <button
                  onClick={handleSubmitFeedback}
                  disabled={loading}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300"
                >
                  수정사항 저장 (AI 학습)
                </button>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase w-8">#</th>
                      <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">적요</th>
                      <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">거래처</th>
                      <th className="px-3 py-3 text-right text-xs font-medium text-gray-500 uppercase">금액</th>
                      <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">AI 분류</th>
                      <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase">신뢰도</th>
                      <th className="px-3 py-3 text-center text-xs font-medium text-gray-500 uppercase">검토사유</th>
                      <th className="px-3 py-3 text-left text-xs font-medium text-gray-500 uppercase">수정</th>
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-200">
                    {classificationResults
                      .map((result, originalIndex) => ({ result, originalIndex }))
                      .filter(({ result }) => {
                        if (resultFilter === 'review') return result.needs_review
                        if (resultFilter === 'confirmed') return result.auto_confirm
                        return true
                      })
                      .sort((a, b) => {
                        if (resultSort === 'confidence_asc') return a.result.confidence - b.result.confidence
                        if (resultSort === 'confidence_desc') return b.result.confidence - a.result.confidence
                        return 0
                      })
                      .map(({ result, originalIndex }) => (
                      <tr
                        key={originalIndex}
                        className={
                          result.actual_account_code && result.actual_account_code !== result.predicted_account_code
                            ? 'bg-blue-50'
                            : result.needs_review
                            ? 'bg-yellow-50'
                            : ''
                        }
                      >
                        <td className="px-3 py-3 text-xs text-gray-400 text-center">{result.row_index + 1}</td>
                        <td className="px-3 py-3 text-sm max-w-[200px] truncate" title={result.description}>
                          {result.description}
                        </td>
                        <td className="px-3 py-3 text-sm text-gray-500">{result.merchant_name || '-'}</td>
                        <td className="px-3 py-3 text-sm text-right">{result.amount?.toLocaleString() || 0}</td>
                        <td className="px-3 py-3 text-sm">
                          <span className="font-medium">{result.predicted_account_code}</span>
                          {' '}
                          <span className="text-gray-500">{result.predicted_account_name}</span>
                        </td>
                        <td className="px-3 py-3 text-center">
                          <span className={`inline-flex px-2 py-1 text-xs font-semibold rounded-full ${
                            result.confidence >= 0.85 ? 'bg-green-100 text-green-800' :
                            result.confidence >= 0.6 ? 'bg-yellow-100 text-yellow-800' :
                            'bg-red-100 text-red-800'
                          }`}>
                            {(result.confidence * 100).toFixed(0)}%
                          </span>
                        </td>
                        <td className="px-3 py-3 text-center">
                          {result.review_reasons && result.review_reasons.length > 0 ? (
                            <div className="flex flex-wrap gap-1 justify-center">
                              {result.review_reasons.map((reason, ri) => (
                                <span key={ri} className={`inline-flex px-2 py-0.5 text-xs rounded-full font-medium ${
                                  reason.includes('매우 낮음') ? 'bg-red-100 text-red-700 border border-red-300' :
                                  reason.includes('낮음') ? 'bg-orange-100 text-orange-700 border border-orange-300' :
                                  reason.includes('불확실') ? 'bg-purple-100 text-purple-700 border border-purple-300' :
                                  reason.includes('거래처') ? 'bg-blue-100 text-blue-700 border border-blue-300' :
                                  'bg-gray-100 text-gray-700 border border-gray-300'
                                }`}>
                                  {reason}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-green-500 text-xs">OK</span>
                          )}
                        </td>
                        <td className="px-3 py-3">
                          <select
                            value={result.actual_account_code || result.predicted_account_code}
                            onChange={(e) => updateClassificationResult(originalIndex, e.target.value)}
                            className={`block w-full rounded-md shadow-sm text-sm ${
                              result.actual_account_code && result.actual_account_code !== result.predicted_account_code
                                ? 'border-blue-400 ring-1 ring-blue-300'
                                : 'border-gray-300'
                            } focus:border-blue-500 focus:ring-blue-500`}
                          >
                            <option value={result.predicted_account_code}>
                              {result.predicted_account_code} - {result.predicted_account_name}
                            </option>
                            {result.alternatives.map((alt) => (
                              <option key={alt.account_code} value={alt.account_code}>
                                {alt.account_code} - {alt.account_name} ({(alt.confidence * 100).toFixed(0)}%)
                              </option>
                            ))}
                            <optgroup label="전체 계정과목">
                              {accounts.map((acc) => (
                                <option key={acc.id} value={acc.code}>
                                  {acc.code} - {acc.name} ({acc.category})
                                </option>
                              ))}
                            </optgroup>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 하단 요약 */}
              <div className="p-4 border-t bg-gray-50 flex justify-between items-center text-sm text-gray-600">
                <span>
                  수정된 항목: <span className="font-bold text-blue-600">
                    {classificationResults.filter(r => r.actual_account_code && r.actual_account_code !== r.predicted_account_code).length}
                  </span>건
                </span>
                <span>
                  현재 표시: {
                    resultFilter === 'all' ? classificationResults.length :
                    resultFilter === 'review' ? classificationResults.filter(r => r.needs_review).length :
                    classificationResults.filter(r => r.auto_confirm).length
                  }건
                </span>
              </div>
            </div>
          ) : (
            <div className="bg-white p-12 rounded-lg shadow border text-center text-gray-500">
              <p>분류 결과가 없습니다.</p>
              <p className="text-sm mt-2">자동 분류 탭에서 파일을 업로드하여 분류를 실행하세요.</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

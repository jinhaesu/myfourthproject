import { useState, useEffect, useCallback, useRef } from 'react'
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

interface StandardAccount {
  code: string
  name: string
  group: string
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
  memo?: string
  transaction_date?: string
  journal_entry?: {
    debit_account_code: string
    debit_account_name: string
    debit_amount: number
    credit_account_code: string
    credit_account_name: string
    credit_amount: number
    vat_amount: number
    supply_amount: number
    is_balanced: boolean
  }
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
  const [currentUploadId, setCurrentUploadId] = useState<number | null>(null)

  // 통장 일괄 분류 states
  const [bankUploadMode, setBankUploadMode] = useState(false)
  const [bankFiles, setBankFiles] = useState<File[]>([])
  const [bankUploadProgress, setBankUploadProgress] = useState<string | null>(null)
  const [bankResults, setBankResults] = useState<any>(null)
  const [bankDragOver, setBankDragOver] = useState(false)

  // 행 선택 상태 (장부 반영용)
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set())

  // 계정 수정 상태
  const [creditOverrides, setCreditOverrides] = useState<Record<number, { code: string; name: string }>>({})
  const [editingCell, setEditingCell] = useState<{ rowIndex: number; side: 'debit' | 'credit' } | null>(null)

  // Results filter/sort states
  const [resultFilter, setResultFilter] = useState<'all' | 'review' | 'confirmed'>('all')
  type SortKey = 'default' | 'date_asc' | 'date_desc' | 'debit_asc' | 'debit_desc' | 'debit_amt_asc' | 'debit_amt_desc' | 'credit_asc' | 'credit_desc' | 'credit_amt_asc' | 'credit_amt_desc' | 'confidence_asc' | 'confidence_desc'
  const [resultSort, setResultSort] = useState<SortKey>('default')

  const toggleSort = (column: string) => {
    const ascKey = `${column}_asc` as SortKey
    const descKey = `${column}_desc` as SortKey
    if (resultSort === ascKey) setResultSort(descKey)
    else if (resultSort === descKey) setResultSort('default')
    else setResultSort(ascKey)
  }

  const sortIcon = (column: string) => {
    const ascKey = `${column}_asc`
    const descKey = `${column}_desc`
    if (resultSort === ascKey) return ' ▲'
    if (resultSort === descKey) return ' ▼'
    return ' ↕'
  }

  const queryClient = useQueryClient()

  // React Query - fetch status
  const { data: status, isLoading: statusLoading } = useQuery<AIStatus>({
    queryKey: ['aiStatus'],
    queryFn: () => aiClassificationApi.getStatus().then((r) => r.data),
    retry: 3,
    retryDelay: 1000,
  })

  // React Query - fetch upload history
  const { data: uploadHistory, isError: uploadHistoryError } = useQuery<UploadHistoryItem[]>({
    queryKey: ['aiUploadHistory'],
    queryFn: () => aiClassificationApi.getUploadHistory().then((r) => r.data),
    retry: 3,
    retryDelay: 1000,
  })

  // React Query - fetch accounts (DB)
  const { data: accounts = [] } = useQuery<Account[]>({
    queryKey: ['aiAccounts'],
    queryFn: () => aiClassificationApi.getAccounts().then((r) => r.data),
    retry: 3,
  })

  // React Query - 표준 계정과목 (시산표 기반, 항상 반환)
  const { data: stdAcctData } = useQuery<{
    standard_accounts: StandardAccount[]
    expense_accounts: StandardAccount[]
  }>({
    queryKey: ['aiStandardAccounts'],
    queryFn: () => aiClassificationApi.getStandardAccounts().then((r) => r.data),
    retry: 3,
    staleTime: Infinity,
  })
  const expenseAccounts = stdAcctData?.expense_accounts || []
  const allStandardAccounts = stdAcctData?.standard_accounts || []

  const getAccountName = (code: string): string => {
    return allStandardAccounts.find(a => a.code === code)?.name || accounts.find(a => a.code === code)?.name || ''
  }

  const showMessage = (type: 'success' | 'error', text: string) => {
    setMessage({ type, text })
    // 에러는 15초, 성공은 5초
    setTimeout(() => setMessage(null), type === 'error' ? 15000 : 5000)
  }

  const refreshData = () => {
    queryClient.invalidateQueries({ queryKey: ['aiStatus'] })
    queryClient.invalidateQueries({ queryKey: ['aiUploadHistory'] })
    queryClient.invalidateQueries({ queryKey: ['financialUploadHistory'] })
    // 재무보고서 캐시도 무효화 (장부 반영/삭제 시 보고서 데이터 갱신)
    queryClient.invalidateQueries({ queryKey: ['financialIncome'] })
    queryClient.invalidateQueries({ queryKey: ['financialBalance'] })
    queryClient.invalidateQueries({ queryKey: ['financialTrialBalance'] })
    queryClient.invalidateQueries({ queryKey: ['financialTrend'] })
    queryClient.invalidateQueries({ queryKey: ['financialYears'] })
    queryClient.invalidateQueries({ queryKey: ['financialSummary'] })
  }

  // Upload progress state
  const [uploadProgress, setUploadProgress] = useState<string | null>(null)

  // Classify progress state
  const [classifyProgress, setClassifyProgress] = useState<{
    status: string; step: string; progress: number; message: string;
    total_rows: number; processed_rows: number; low_confidence_count: number;
  } | null>(null)

  // Handle historical data upload - 파싱 → 배치전송 (계정 생성 없이 raw INSERT만)
  const handleUploadHistorical = async () => {
    if (!uploadFile) {
      showMessage('error', '파일을 선택해주세요.')
      return
    }
    setLoading(true)
    setUploadProgress('파일 파싱 중...')

    try {
      const { rows, sheetCount, sheetsProcessed } = await parseExcelForUpload(uploadFile)

      if (rows.length === 0) {
        showMessage('error', '파싱된 데이터가 없습니다. 파일 형식을 확인해주세요.')
        setLoading(false)
        setUploadProgress(null)
        return
      }

      const BATCH_SIZE = 500
      const totalBatches = Math.ceil(rows.length / BATCH_SIZE)
      let uploadId: number | null = null
      let totalSaved = 0

      setUploadProgress(`${rows.length.toLocaleString()}행 파싱 완료. 전송 시작...`)
      console.log(`[Upload] ${rows.length}행, ${totalBatches}배치`)

      for (let i = 0; i < totalBatches; i++) {
        const batch = rows.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE)
        let success = false

        for (let retry = 0; retry < 3 && !success; retry++) {
          try {
            if (retry > 0) {
              console.log(`[Upload] 배치 ${i+1} 재시도 ${retry}/3`)
              await new Promise(r => setTimeout(r, 2000 * retry))
            }

            const t0 = Date.now()
            const response = await aiClassificationApi.uploadHistoricalBatch({
              upload_id: uploadId,
              filename: uploadFile.name,
              file_size: uploadFile.size,
              batch_index: i,
              total_batches: totalBatches,
              total_rows: rows.length,
              rows: batch,
            })
            console.log(`[Upload] 배치 ${i+1}/${totalBatches} OK (${((Date.now()-t0)/1000).toFixed(1)}s)`)

            if (i === 0) uploadId = response.data.upload_id
            totalSaved += response.data.saved_count || 0
            success = true
          } catch (err: any) {
            console.error(`[Upload] 배치 ${i+1} 실패 (${retry+1}/3):`, err.message)
            if (retry === 2) throw err
          }
        }

        const pct = Math.round(((i + 1) / totalBatches) * 100)
        setUploadProgress(`저장 중... ${pct}% (${i + 1}/${totalBatches})`)
      }

      showMessage('success', `${totalSaved.toLocaleString()}건 업로드 완료! (${sheetCount}시트 중 ${sheetsProcessed}개 처리)`)
      setUploadFile(null)
      setUploadProgress(null)
      setUploadResult({ total_rows: rows.length, saved_count: totalSaved })
      refreshData()

    } catch (error: any) {
      console.error('[Upload] 최종 오류:', error)
      const detail = error.response?.data?.detail || error.message || '알 수 없는 오류'
      setUploadProgress(`업로드 실패: ${detail}`)
      showMessage('error', `업로드 오류: ${detail}`)
    } finally {
      setLoading(false)
    }
  }

  // Handle delete upload
  const handleDeleteUpload = async (uploadId: number, _filename?: string) => {
    setLoading(true)
    try {
      const response = await aiClassificationApi.deleteUpload(uploadId)
      showMessage('success', response.data?.message || '삭제되었습니다.')
      if (currentUploadId === uploadId) {
        setClassificationResults([]); setCreditOverrides({}); setEditingCell(null)
        setClassifyStats(null)
        setCurrentUploadId(null)
      }
      refreshData()
    } catch (error: any) {
      showMessage('error', error.response?.data?.detail || '삭제 실패')
    } finally {
      setLoading(false)
    }
  }

  // Handle delete journal entry (장부 반영 취소)
  const handleDeleteJournal = async (uploadId: number, filename: string) => {
    if (!window.confirm(`"${filename}" 장부 반영을 취소하시겠습니까?\n반영된 분개가 모두 삭제됩니다. 재무보고서에서도 제외됩니다.`)) {
      return
    }
    setLoading(true)
    try {
      const response = await aiClassificationApi.deleteJournal(uploadId)
      showMessage('success', response.data?.message || '장부 반영이 취소되었습니다.')
      // 현재 보고 있는 분류 결과가 삭제된 항목과 연결되어 있으면 초기화
      if (currentUploadId === uploadId) {
        setClassificationResults([]); setCreditOverrides({}); setEditingCell(null)
        setClassifyStats(null)
        setCurrentUploadId(null)
        setSelectedRows(new Set())
      }
      // localStorage AI 분석 캐시 클리어 (재무보고서 정합성)
      Object.keys(localStorage).forEach(key => {
        if (key.startsWith('ai_analysis_')) localStorage.removeItem(key)
      })
      refreshData()
    } catch (error: any) {
      showMessage('error', error.response?.data?.detail || '장부 반영 취소 실패')
    } finally {
      setLoading(false)
    }
  }

  // Training progress state
  const [trainProgress, setTrainProgress] = useState<any>(null)
  const [training, setTraining] = useState(false)
  const [selectedUploadIds, setSelectedUploadIds] = useState<number[]>([])
  const [maxSamples, setMaxSamples] = useState<string>('')
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // 학습 진행 폴링
  const startPolling = useCallback(() => {
    if (pollRef.current) return
    pollRef.current = setInterval(async () => {
      try {
        const res = await aiClassificationApi.getTrainProgress()
        setTrainProgress(res.data)
        if (res.data.status === 'completed' || res.data.status === 'failed') {
          if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null }
          setTraining(false)
          if (res.data.status === 'completed') {
            showMessage('success', res.data.message)
            refreshData()
          } else {
            showMessage('error', res.data.message)
          }
        }
      } catch { /* ignore */ }
    }, 2000)
  }, [])

  useEffect(() => {
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [])

  // Handle model training
  const handleTrainModel = async () => {
    if (!status?.training_samples || status.training_samples < 50) {
      showMessage('error', '학습 데이터가 최소 50개 이상 필요합니다.')
      return
    }
    setTraining(true)
    setTrainProgress(null)
    try {
      const maxS = maxSamples ? parseInt(maxSamples) : undefined
      const upIds = selectedUploadIds.length > 0 ? selectedUploadIds : undefined
      await aiClassificationApi.trainModel(50, maxS, upIds)
      startPolling()
    } catch (error: any) {
      showMessage('error', error.response?.data?.detail || '학습 시작 실패')
      setTraining(false)
    }
  }

  // Handle file classification with progress polling
  const handleClassifyFile = async () => {
    if (!classifyFile) {
      showMessage('error', '분류할 파일을 선택해주세요.')
      return
    }
    setLoading(true)
    setClassifyProgress({ status: 'running', step: '시작', progress: 0, message: '분류 요청 전송 중...', total_rows: 0, processed_rows: 0, low_confidence_count: 0 })

    // 진행 상태 폴링 시작
    const pollInterval = setInterval(async () => {
      try {
        const prog = await aiClassificationApi.getClassifyProgress()
        if (prog.data && prog.data.status !== 'idle') {
          setClassifyProgress(prog.data)
        }
      } catch { /* ignore polling errors */ }
    }, 1000)

    try {
      const response = await aiClassificationApi.classifyFile(classifyFile)
      clearInterval(pollInterval)
      setClassifyProgress(null)
      setClassificationResults(response.data.results)
      setSelectedRows(new Set())
      setClassifyStats({
        total: response.data.total_rows,
        autoConfirmed: response.data.auto_confirmed,
        needsReview: response.data.needs_review,
        avgConfidence: response.data.average_confidence,
        totalAmount: response.data.total_amount || 0,
        isCardFormat: response.data.is_card_format || false,
        reviewReasonCounts: response.data.review_reason_counts || {},
      })
      setCurrentUploadId(response.data.upload_id || null)
      setActiveTab('results')
      refreshData()
      showMessage('success', `${response.data.total_rows}개 항목 분류 완료`)
    } catch (error: any) {
      clearInterval(pollInterval)
      setClassifyProgress(null)
      showMessage('error', error.response?.data?.detail || '분류 실패')
    } finally {
      setLoading(false)
    }
  }

  // Handle re-classification (현재 파일로 재분류)
  const handleReclassify = async () => {
    if (!classifyFile) {
      showMessage('error', '재분류할 파일이 없습니다. 자동 분류 탭에서 파일을 다시 업로드해주세요.')
      return
    }
    setLoading(true)
    setClassifyProgress({ status: 'running', step: '시작', progress: 0, message: '재분류 요청 전송 중...', total_rows: 0, processed_rows: 0, low_confidence_count: 0 })

    const pollInterval = setInterval(async () => {
      try {
        const prog = await aiClassificationApi.getClassifyProgress()
        if (prog.data && prog.data.status !== 'idle') {
          setClassifyProgress(prog.data)
        }
      } catch { /* ignore */ }
    }, 1000)

    try {
      const response = await aiClassificationApi.classifyFile(classifyFile)
      clearInterval(pollInterval)
      setClassifyProgress(null)
      setClassificationResults(response.data.results)
      setSelectedRows(new Set())
      setClassifyStats({
        total: response.data.total_rows,
        autoConfirmed: response.data.auto_confirmed,
        needsReview: response.data.needs_review,
        avgConfidence: response.data.average_confidence,
        totalAmount: response.data.total_amount || 0,
        isCardFormat: response.data.is_card_format || false,
        reviewReasonCounts: response.data.review_reason_counts || {},
      })
      setCurrentUploadId(response.data.upload_id || null)
      refreshData()
      showMessage('success', `${response.data.total_rows}개 항목 재분류 완료`)
    } catch (error: any) {
      clearInterval(pollInterval)
      setClassifyProgress(null)
      showMessage('error', error.response?.data?.detail || '재분류 실패')
    } finally {
      setLoading(false)
    }
  }

  // Handle multi-bank statement classification (통장 일괄 분류)
  const handleBankClassify = async () => {
    if (bankFiles.length === 0) return
    setLoading(true)
    setBankUploadProgress('파일 업로드 중...')
    // 진행률 폴링 시작
    const progressPoll = setInterval(async () => {
      try {
        const prog = await aiClassificationApi.getBankClassifyProgress()
        const d = prog.data
        if (d.status === 'running') {
          const elapsed = d.elapsed_seconds || 0
          const remaining = d.estimated_remaining || 0
          const rule = d.rule_classified || 0
          const llm = d.llm_classified || 0
          const pct = d.progress || 0
          setBankUploadProgress(
            `${d.step || '처리 중'} (${pct}%) — 룰분류: ${rule.toLocaleString()}건, AI분류: ${llm.toLocaleString()}건` +
            (elapsed > 0 ? ` | ${elapsed}초 경과` : '') +
            (remaining > 0 ? ` | 약 ${remaining}초 남음` : '')
          )
        }
      } catch { /* ignore polling errors */ }
    }, 2000)
    try {
      const response = await aiClassificationApi.classifyBankStatements(bankFiles)
      clearInterval(progressPoll)
      setBankResults(response.data)
      // Convert bank results to classificationResults format for reuse of existing table
      const converted = response.data.results.map((r: any, idx: number) => ({
        row_index: idx,
        description: r.description,
        merchant_name: r.counterparty || r.description,
        amount: r.withdrawal || r.deposit,
        transaction_date: r.transaction_date,
        predicted_account_code: r.predicted_account_code,
        predicted_account_name: r.predicted_account_name,
        confidence: r.confidence,
        auto_confirm: r.confidence > 0.8,
        needs_review: r.confidence < 0.6,
        review_reasons: r.review_reasons || [],
        reasoning: '',
        alternatives: [],
        memo: `[${r.bank_name}] ${r.description}`,
        journal_entry: {
          debit_account_code: r.is_deposit ? '103' : r.predicted_account_code,
          debit_account_name: r.is_deposit ? '보통예금' : r.predicted_account_name,
          credit_account_code: r.is_deposit ? r.predicted_account_code : '103',
          credit_account_name: r.is_deposit ? r.predicted_account_name : '보통예금',
          debit_amount: r.withdrawal || r.deposit,
          credit_amount: r.withdrawal || r.deposit,
          vat_amount: 0,
          supply_amount: 0,
          is_balanced: true,
        }
      }))
      setClassificationResults(converted)
      setSelectedRows(new Set())
      setClassifyStats({
        total: response.data.total_transactions,
        autoConfirmed: converted.filter((r: any) => r.auto_confirm).length,
        needsReview: converted.filter((r: any) => r.needs_review).length,
        avgConfidence: converted.length > 0 ? converted.reduce((s: number, r: any) => s + r.confidence, 0) / converted.length : 0,
        totalAmount: converted.reduce((s: number, r: any) => s + r.amount, 0),
      })
      setCurrentUploadId(response.data.upload_id || null)
      setActiveTab('results')
      refreshData()
      showMessage('success', `${response.data.banks?.length || 0}개 은행 ${response.data.total_transactions}건 분류 완료${response.data.inter_bank_transfers ? ` (은행간 이체 ${response.data.inter_bank_transfers}건 감지)` : ''}`)
    } catch (error: any) {
      clearInterval(progressPoll)
      showMessage('error', error.response?.data?.detail || '통장 분류 실패')
    } finally {
      setLoading(false)
      setBankUploadProgress(null)
    }
  }

  // Handle bank file drop
  const handleBankFileDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setBankDragOver(false)
    const droppedFiles = Array.from(e.dataTransfer.files).filter(
      f => f.name.endsWith('.xls') || f.name.endsWith('.xlsx')
    )
    if (droppedFiles.length === 0) {
      showMessage('error', '.xls 또는 .xlsx 파일만 업로드할 수 있습니다.')
      return
    }
    setBankFiles(prev => {
      const combined = [...prev, ...droppedFiles]
      if (combined.length > 10) {
        showMessage('error', '최대 10개 파일까지 업로드할 수 있습니다.')
        return combined.slice(0, 10)
      }
      return combined
    })
  }

  const handleBankFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(e.target.files || [])
    setBankFiles(prev => {
      const combined = [...prev, ...selected]
      if (combined.length > 10) {
        showMessage('error', '최대 10개 파일까지 업로드할 수 있습니다.')
        return combined.slice(0, 10)
      }
      return combined
    })
    e.target.value = ''
  }

  const removeBankFile = (index: number) => {
    setBankFiles(prev => prev.filter((_, i) => i !== index))
  }

  // Handle journal entry confirmation (장부 반영)
  const handleConfirmJournal = async () => {
    if (classificationResults.length === 0) {
      showMessage('error', '확정할 분개가 없습니다.')
      return
    }
    // 선택된 행이 있으면 선택된 것만, 없으면 전체
    const indicesToConfirm = selectedRows.size > 0
      ? Array.from(selectedRows)
      : classificationResults.map((_, idx) => idx)

    setLoading(true)
    try {
      const entries = classificationResults.map((r, idx) => {
        const finalCode = r.actual_account_code || r.predicted_account_code
        const finalName = finalCode === r.predicted_account_code
          ? r.predicted_account_name
          : getAccountName(finalCode) || r.predicted_account_name
        const creditCode = creditOverrides[idx]?.code || r.journal_entry?.credit_account_code || '253'
        const creditName = creditOverrides[idx]?.name || r.journal_entry?.credit_account_name || '미지급금'
        return {
          description: r.description,
          merchant_name: r.merchant_name,
          memo: r.memo || r.description,
          transaction_date: r.transaction_date || '',
          amount: r.amount,
          debit_account_code: finalCode,
          debit_account_name: finalName,
          credit_account_code: creditCode,
          credit_account_name: creditName,
          vat_amount: r.journal_entry?.vat_amount || 0,
          supply_amount: r.journal_entry?.supply_amount || 0,
        }
      })
      const response = await aiClassificationApi.confirmJournal(entries, classifyFile?.name, indicesToConfirm)
      showMessage('success', response.data.message)

      if (selectedRows.size > 0 && selectedRows.size < classificationResults.length) {
        // 선택된 항목만 반영: 나머지 결과 유지
        setClassificationResults(prev => prev.filter((_, idx) => !selectedRows.has(idx)))
        // creditOverrides 인덱스 재매핑
        const remaining = classificationResults
          .map((_, idx) => idx)
          .filter(idx => !selectedRows.has(idx))
        const newOverrides: Record<number, { code: string; name: string }> = {}
        remaining.forEach((oldIdx, newIdx) => {
          if (creditOverrides[oldIdx]) newOverrides[newIdx] = creditOverrides[oldIdx]
        })
        setCreditOverrides(newOverrides)
        setSelectedRows(new Set())
        setEditingCell(null)
        refreshData()
      } else {
        // 전체 반영: 결과 초기화
        setClassificationResults([]); setCreditOverrides({}); setEditingCell(null)
        setSelectedRows(new Set())
        setClassifyStats(null)
        setBankResults(null)
        setActiveTab('status')
        refreshData()
      }
    } catch (error: any) {
      showMessage('error', error.response?.data?.detail || '장부 반영 실패')
    } finally {
      setLoading(false)
    }
  }

  // Clear classification results
  const handleClearResults = () => {
    setClassificationResults([]); setCreditOverrides({}); setEditingCell(null)
    setSelectedRows(new Set())
    setClassifyStats(null)
    setClassifyFile(null)
    setCurrentUploadId(null)
    setBankResults(null)
    setActiveTab('classify')
  }

  // Load saved classification result
  const handleLoadClassifyResult = async (uploadId: number) => {
    setLoading(true)
    try {
      const response = await aiClassificationApi.getClassifyResult(uploadId)
      setClassificationResults(response.data.results || [])
      setSelectedRows(new Set())
      setClassifyStats({
        total: response.data.total_rows || 0,
        autoConfirmed: response.data.auto_confirmed || 0,
        needsReview: response.data.needs_review || 0,
        avgConfidence: response.data.average_confidence || 0,
        totalAmount: response.data.total_amount || 0,
        isCardFormat: response.data.is_card_format || false,
        reviewReasonCounts: response.data.review_reason_counts || {},
      })
      setCurrentUploadId(uploadId)
      setActiveTab('results')
    } catch (error: any) {
      showMessage('error', error.response?.data?.detail || '분류 결과 불러오기 실패')
    } finally {
      setLoading(false)
    }
  }


  // Update classification result (차변 계정 수정)
  const updateClassificationResult = (index: number, accountCode: string) => {
    setClassificationResults((prev) =>
      prev.map((r, i) => (i === index ? { ...r, actual_account_code: accountCode } : r))
    )
    setEditingCell(null)
  }

  // 대변 계정 수정
  const updateCreditAccount = (index: number, accountCode: string) => {
    const name = getAccountName(accountCode)
    setCreditOverrides((prev) => ({
      ...prev,
      [index]: { code: accountCode, name },
    }))
    setEditingCell(null)
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
              <p className="mt-2 text-2xl font-semibold">{statusLoading ? '로딩 중...' : (status?.model_version || '-')}</p>
              <p className="text-sm text-gray-400">{statusLoading ? '' : (status?.is_trained ? '학습됨' : '미학습')}</p>
            </div>
            <div className="bg-white p-6 rounded-lg shadow border">
              <h3 className="text-sm font-medium text-gray-500">학습 데이터</h3>
              <p className="mt-2 text-2xl font-semibold">{statusLoading ? '로딩 중...' : fmtNum(status?.training_samples || 0)}</p>
              <p className="text-sm text-gray-400">개 항목</p>
            </div>
            <div className="bg-white p-6 rounded-lg shadow border">
              <h3 className="text-sm font-medium text-gray-500">모델 정확도</h3>
              <p className="mt-2 text-2xl font-semibold">
                {statusLoading ? '로딩 중...' : (status?.model_accuracy ? `${(status.model_accuracy * 100).toFixed(1)}%` : '-')}
              </p>
              <p className="text-sm text-gray-400">교차 검증 기준</p>
            </div>
            <div className="bg-white p-6 rounded-lg shadow border">
              <h3 className="text-sm font-medium text-gray-500">분류 정확도</h3>
              <p className="mt-2 text-2xl font-semibold">
                {statusLoading ? '로딩 중...' : (status?.accuracy_rate ? `${status.accuracy_rate.toFixed(1)}%` : '-')}
              </p>
              <p className="text-sm text-gray-400">
                {statusLoading ? '불러오는 중...' : `${status?.total_classifications || 0}건 중 ${status?.correct_classifications || 0}건 정확`}
              </p>
            </div>
          </div>

          <div className="bg-white p-6 rounded-lg shadow border">
            <h3 className="text-lg font-medium mb-4">업로드 통계</h3>
            <div className="grid grid-cols-3 gap-4 text-center">
              <div>
                <p className="text-3xl font-bold text-blue-600">{statusLoading ? '...' : (status?.completed_uploads || 0)}</p>
                <p className="text-sm text-gray-500">완료된 업로드</p>
              </div>
              <div>
                <p className="text-3xl font-bold text-green-600">{statusLoading ? '...' : fmtNum(status?.total_raw_transactions || 0)}</p>
                <p className="text-sm text-gray-500">보관된 거래 데이터</p>
              </div>
              <div>
                <p className="text-3xl font-bold text-purple-600">{statusLoading ? '...' : fmtNum(status?.training_samples || 0)}</p>
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
                        <td className="px-4 py-3 text-sm font-medium">
                          {u.filename}
                          {u.upload_type === 'classification' && (
                            <span className="ml-2 text-xs px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded">분류</span>
                          )}
                          {u.upload_type === 'journal_entry' && (
                            <span className="ml-2 text-xs px-1.5 py-0.5 bg-green-100 text-green-700 rounded">장부반영</span>
                          )}
                        </td>
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
                          <div className="flex items-center justify-center gap-1">
                            {u.upload_type === 'journal_entry' && (
                              <button
                                onClick={() => handleDeleteJournal(u.id, u.filename)}
                                disabled={loading}
                                className="text-xs text-orange-600 hover:text-orange-800 hover:bg-orange-50 px-2 py-1 rounded disabled:opacity-50"
                                title="장부 반영 취소"
                              >
                                장부 반영 취소
                              </button>
                            )}
                            <button
                              onClick={() => handleDeleteUpload(u.id, u.filename)}
                              disabled={loading}
                              className="text-red-500 hover:text-red-700 disabled:opacity-50"
                              title="삭제"
                            >
                              <TrashIcon className="h-5 w-5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : uploadHistoryError ? (
              <p className="text-center py-4 text-red-400 text-sm">
                업로드 이력을 불러오지 못했습니다. 새로고침해 주세요.
              </p>
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

            {/* 학습 데이터 소스 선택 */}
            {uploadHistory && uploadHistory.length > 0 && (
              <div className="mb-4">
                <label className="text-sm font-medium text-gray-700 block mb-2">
                  학습 데이터 선택 (미선택 시 전체 사용)
                </label>
                <div className="max-h-36 overflow-auto border rounded-lg p-2 space-y-1">
                  {uploadHistory.filter(u => u.status === 'completed').map((u) => (
                    <label key={u.id} className="flex items-center gap-2 text-sm cursor-pointer hover:bg-gray-50 p-1 rounded">
                      <input
                        type="checkbox"
                        checked={selectedUploadIds.includes(u.id)}
                        onChange={(e) => {
                          if (e.target.checked) setSelectedUploadIds(prev => [...prev, u.id])
                          else setSelectedUploadIds(prev => prev.filter(id => id !== u.id))
                        }}
                        className="rounded border-gray-300"
                      />
                      <span className="truncate">{u.filename}</span>
                      <span className="text-gray-400 text-xs whitespace-nowrap">({fmtNum(u.saved_count || 0)}건)</span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {/* 최대 샘플 수 */}
            <div className="mb-4 flex items-center gap-3">
              <label className="text-sm font-medium text-gray-700 whitespace-nowrap">최대 샘플 수</label>
              <input
                type="number"
                value={maxSamples}
                onChange={(e) => setMaxSamples(e.target.value)}
                placeholder="전체 (제한 없음)"
                className="w-40 px-3 py-1.5 text-sm border rounded-lg"
              />
              <span className="text-xs text-gray-400">데이터가 많으면 10,000~20,000으로 제한하면 빠릅니다</span>
            </div>

            <div className="flex gap-4 items-center">
              <button
                onClick={handleTrainModel}
                disabled={training || loading || !status?.training_samples || status.training_samples < 50}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed"
              >
                {training ? '학습 진행 중...' : '모델 재학습'}
              </button>
              <p className="text-sm text-gray-500">
                최소 50개 이상 필요 (현재: {fmtNum(status?.training_samples || 0)}개)
                {selectedUploadIds.length > 0 && ` | ${selectedUploadIds.length}개 업로드 선택됨`}
              </p>
            </div>

            {/* 학습 진행 상태 표시 */}
            {(training || (trainProgress && trainProgress.status === 'running')) && (
              <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-blue-800">{trainProgress?.step || '시작 중...'}</span>
                  <span className="text-sm font-bold text-blue-800">{trainProgress?.progress || 0}%</span>
                </div>
                <div className="w-full bg-blue-200 rounded-full h-3">
                  <div
                    className="bg-blue-600 h-3 rounded-full transition-all duration-500"
                    style={{ width: `${trainProgress?.progress || 0}%` }}
                  />
                </div>
                <p className="text-xs text-blue-600 mt-2">{trainProgress?.message || '학습을 준비하고 있습니다...'}</p>
              </div>
            )}

            {trainProgress?.status === 'completed' && (
              <div className="mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
                {trainProgress.message}
              </div>
            )}

            {trainProgress?.status === 'failed' && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {trainProgress.message}
              </div>
            )}

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
          {/* Mode Toggle: 파일 분류 / 통장 일괄 분류 */}
          <div className="flex rounded-lg border border-gray-300 overflow-hidden text-sm w-fit">
            <button
              onClick={() => setBankUploadMode(false)}
              className={`px-5 py-2.5 font-medium transition-colors ${
                !bankUploadMode
                  ? 'bg-blue-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              파일 분류
            </button>
            <button
              onClick={() => setBankUploadMode(true)}
              className={`px-5 py-2.5 font-medium border-l transition-colors ${
                bankUploadMode
                  ? 'bg-teal-600 text-white'
                  : 'bg-white text-gray-600 hover:bg-gray-50'
              }`}
            >
              통장 일괄 분류
            </button>
          </div>

          {/* Single File Classification Mode */}
          {!bankUploadMode && (
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
                    disabled={training || loading}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 text-sm"
                  >
                    {training ? '학습 진행 중...' : `모델 학습 시작 (${fmtNum(status?.training_samples || 0)}개 데이터)`}
                  </button>
                )}
                {training && trainProgress && (
                  <div className="mt-2 text-xs text-blue-600">
                    {trainProgress.step}: {trainProgress.progress}% - {trainProgress.message}
                  </div>
                )}
              </div>
            )}

            <div className="mb-4 grid grid-cols-2 gap-4">
              <div className="border rounded-lg p-3">
                <h4 className="font-medium mb-2 text-sm">일반 엑셀</h4>
                <ul className="text-xs text-gray-600 list-disc list-inside space-y-0.5">
                  <li><strong>적요</strong> (필수)</li>
                  <li>거래처명, 금액, 거래일자</li>
                </ul>
              </div>
              <div className="border rounded-lg p-3 border-blue-200 bg-blue-50/50">
                <h4 className="font-medium mb-2 text-sm text-blue-700">위하고 신용카드(매입)</h4>
                <ul className="text-xs text-gray-600 list-disc list-inside space-y-0.5">
                  <li><strong>가맹점명</strong> → 적요로 자동 사용</li>
                  <li>매입금액, 부가세, 공급가액</li>
                  <li>거래일자, 승인번호, 카드번호</li>
                </ul>
              </div>
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

              {/* 분류 진행 상태 표시 */}
              {classifyProgress && classifyProgress.status === 'running' && (
                <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-blue-700">{classifyProgress.step}</span>
                    <span className="text-sm text-blue-600">{classifyProgress.progress}%</span>
                  </div>
                  <div className="w-full bg-blue-200 rounded-full h-3">
                    <div
                      className="bg-blue-600 h-3 rounded-full transition-all duration-500"
                      style={{ width: `${classifyProgress.progress}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-600 mt-2">{classifyProgress.message}</p>
                  {classifyProgress.total_rows > 0 && (
                    <p className="text-xs text-gray-500 mt-1">
                      처리: {classifyProgress.processed_rows}/{classifyProgress.total_rows}행
                      {classifyProgress.low_confidence_count > 0 && ` | 저신뢰(AI 분석 대상): ${classifyProgress.low_confidence_count}건`}
                    </p>
                  )}
                </div>
              )}
              {classifyProgress && classifyProgress.status === 'failed' && (
                <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-sm text-red-700">분류 오류: {classifyProgress.message}</p>
                </div>
              )}
            </div>
          </div>
          )}

          {/* Multi-Bank Upload Mode (통장 일괄 분류) */}
          {bankUploadMode && (
          <div className="bg-white p-6 rounded-lg shadow border">
            <h3 className="text-lg font-medium mb-2 flex items-center gap-2">
              <span>통장 일괄 분류</span>
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              여러 은행의 통장 내역 파일을 한번에 업로드하면 은행을 자동 감지하고 AI가 계정과목을 분류합니다.
            </p>

            {!status?.is_trained && (
              <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
                <p className="text-sm text-yellow-800 mb-2">
                  AI 모델이 아직 학습되지 않았습니다.
                  {(status?.training_samples || 0) >= 50
                    ? ' 학습 데이터가 충분합니다. 상태/통계 탭에서 모델을 학습시켜주세요.'
                    : ' 먼저 과거 데이터를 업로드하고 모델을 학습시켜주세요.'}
                </p>
              </div>
            )}

            {/* Drag & Drop area */}
            <div
              className={`border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors ${
                bankDragOver
                  ? 'border-teal-500 bg-teal-50'
                  : 'border-gray-300 hover:border-teal-400 hover:bg-gray-50'
              }`}
              onDragOver={(e) => { e.preventDefault(); setBankDragOver(true) }}
              onDragLeave={(e) => { e.preventDefault(); setBankDragOver(false) }}
              onDrop={handleBankFileDrop}
              onClick={() => document.getElementById('bank-file-input')?.click()}
            >
              <input
                id="bank-file-input"
                type="file"
                accept=".xlsx,.xls"
                multiple
                onChange={handleBankFileSelect}
                className="hidden"
              />
              <div className="text-gray-500">
                <svg className="mx-auto h-12 w-12 text-gray-400 mb-3" stroke="currentColor" fill="none" viewBox="0 0 48 48">
                  <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <p className="text-sm font-medium">여러 통장 파일을 드래그하거나 클릭해서 선택</p>
                <p className="text-xs text-gray-400 mt-1">.xls, .xlsx 형식 (최대 10개)</p>
              </div>
            </div>

            {/* Selected files list */}
            {bankFiles.length > 0 && (
              <div className="mt-4">
                <p className="text-sm font-medium text-gray-700 mb-2">
                  선택된 파일 ({bankFiles.length}개):
                </p>
                <div className="space-y-2">
                  {bankFiles.map((file, idx) => (
                    <div key={`${file.name}-${idx}`} className="flex items-center justify-between bg-gray-50 rounded-lg px-4 py-2.5 border border-gray-200">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="text-lg flex-shrink-0">🏦</span>
                        <span className="text-sm font-medium text-gray-800 truncate">{file.name}</span>
                        <span className="text-xs text-gray-400 flex-shrink-0">{(file.size / 1024).toFixed(0)}KB</span>
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeBankFile(idx) }}
                        className="text-red-400 hover:text-red-600 flex-shrink-0 ml-3 p-1 rounded hover:bg-red-50"
                        title="제거"
                      >
                        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Upload progress - detailed */}
            {bankUploadProgress && (
              <div className="mt-4 p-4 bg-teal-50 border border-teal-200 rounded-lg">
                <div className="flex items-center gap-2 text-sm font-medium text-teal-800 mb-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  <span>{bankUploadProgress}</span>
                </div>
                <div className="w-full bg-teal-200 rounded-full h-2">
                  <div className="bg-teal-600 h-2 rounded-full transition-all duration-500"
                    style={{ width: `${Math.min(parseInt(bankUploadProgress.match(/(\d+)%/)?.[1] || '5'), 100)}%` }} />
                </div>
              </div>
            )}

            {/* Submit button */}
            <div className="mt-4">
              <button
                onClick={handleBankClassify}
                disabled={loading || bankFiles.length === 0 || !status?.is_trained}
                className="px-6 py-2.5 bg-teal-600 text-white rounded-lg hover:bg-teal-700 disabled:bg-gray-300 disabled:cursor-not-allowed font-medium transition-colors"
              >
                {loading ? '분류 중...' : `통장 일괄 분류 시작${bankFiles.length > 0 ? ` (${bankFiles.length}개 파일)` : ''}`}
              </button>
            </div>
          </div>
          )}
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

              {/* 신뢰도 낮을 때 안내 */}
              {classifyStats.avgConfidence < 0.6 && (
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <h4 className="text-sm font-medium text-blue-800 mb-1">신뢰도 안내</h4>
                  <p className="text-sm text-blue-700">
                    {status?.training_samples && status.training_samples > 100
                      ? `현재 모델: ${status.model_version} (학습 데이터: ${status.training_samples.toLocaleString()}건). 신뢰도가 낮은 항목은 AI(Claude)가 보조 분석합니다.`
                      : '과거 회계 데이터를 업로드하고 모델을 학습시키면 정확도가 향상됩니다.'
                    }
                    {' '}아래 결과에서 잘못된 계정을 수정 후 "분개 확정 → 장부 반영"을 클릭하면 수정 내용이 AI 학습 데이터로 자동 저장됩니다.
                  </p>
                </div>
              )}

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

          {/* Bank Summary Card (shown when bankResults exists) */}
          {bankResults && bankResults.banks && bankResults.banks.length > 0 && (
            <div className="bg-white rounded-lg shadow border overflow-hidden">
              <div className="p-4 border-b">
                <h3 className="text-sm font-medium text-gray-700">은행별 요약</h3>
              </div>
              <div className="p-4 space-y-2">
                {bankResults.banks.map((bank: any, idx: number) => (
                  <div key={idx} className="flex items-center gap-3 text-sm">
                    <span className="text-lg">🏦</span>
                    <span className="font-medium text-gray-800">{bank.bank_name}</span>
                    {bank.account_number && (
                      <span className="text-gray-400">({bank.account_number})</span>
                    )}
                    <span className="text-gray-500">|</span>
                    <span className="text-gray-600">{fmtNum(bank.transaction_count || 0)}건</span>
                    <span className="text-gray-500">|</span>
                    <span className="text-green-600">
                      입금 {fmtNum(bank.total_deposit || 0)}
                    </span>
                    <span className="text-red-600">
                      출금 {fmtNum(bank.total_withdrawal || 0)}
                    </span>
                  </div>
                ))}
                {bankResults.inter_bank_transfers > 0 && (
                  <div className="flex items-center gap-2 text-sm text-amber-700 mt-2 pt-2 border-t border-gray-100">
                    <span>&#9888;&#65039;</span>
                    <span>은행간 이체 {bankResults.inter_bank_transfers}건 감지 (자동 매칭됨)</span>
                  </div>
                )}
              </div>
            </div>
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
                    onChange={(e) => setResultSort(e.target.value as SortKey)}
                    className="text-sm border border-gray-300 rounded-lg px-2 py-1"
                  >
                    <option value="default">기본순</option>
                    <option value="date_asc">일자 오름차순</option>
                    <option value="date_desc">일자 내림차순</option>
                    <option value="debit_asc">차변 코드순</option>
                    <option value="debit_desc">차변 역순</option>
                    <option value="debit_amt_asc">차변금액 낮은순</option>
                    <option value="debit_amt_desc">차변금액 높은순</option>
                    <option value="credit_asc">대변 코드순</option>
                    <option value="credit_desc">대변 역순</option>
                    <option value="confidence_asc">신뢰도 낮은순</option>
                    <option value="confidence_desc">신뢰도 높은순</option>
                  </select>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleClearResults}
                    className="px-4 py-2 border border-gray-400 text-gray-600 rounded-lg hover:bg-gray-100"
                  >
                    결과 초기화
                  </button>
                  <button
                    onClick={() => {
                      if (!classifyFile) {
                        showMessage('error', '자동 분류 탭에서 파일을 다시 선택 후 재분류해주세요.')
                        setActiveTab('classify')
                        return
                      }
                      handleReclassify()
                    }}
                    disabled={loading}
                    className="px-4 py-2 border border-purple-600 text-purple-600 rounded-lg hover:bg-purple-50 disabled:bg-gray-300 disabled:text-white disabled:border-gray-300"
                    title={classifyFile ? '현재 파일을 최신 AI 모델로 다시 분류합니다' : '자동 분류 탭에서 파일 선택 필요'}
                  >
                    {loading && classifyProgress ? `재분류 ${classifyProgress.progress}%` : loading ? '분류 중...' : 'AI 재분류'}
                  </button>
                  <button
                    onClick={handleConfirmJournal}
                    disabled={loading}
                    className="px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-300"
                    title="확정된 분개를 장부에 반영하고, 수정된 계정은 AI 학습 데이터로 자동 저장됩니다"
                  >
                    {selectedRows.size > 0
                      ? `선택된 ${selectedRows.size}건 장부 반영`
                      : `전체 장부 반영 (${classificationResults.length}건)`}
                  </button>
                </div>
              </div>

              {/* 재분류 진행 상태 */}
              {classifyProgress && classifyProgress.status === 'running' && (
                <div className="p-4 bg-purple-50 border border-purple-200 rounded-lg">
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-sm font-medium text-purple-700">{classifyProgress.step}</span>
                    <span className="text-sm text-purple-600">{classifyProgress.progress}%</span>
                  </div>
                  <div className="w-full bg-purple-200 rounded-full h-3">
                    <div
                      className="bg-purple-600 h-3 rounded-full transition-all duration-500"
                      style={{ width: `${classifyProgress.progress}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-600 mt-2">{classifyProgress.message}</p>
                </div>
              )}

              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-2 py-3 text-center text-xs font-medium text-gray-500 w-8">
                        <input
                          type="checkbox"
                          checked={classificationResults.length > 0 && selectedRows.size === classificationResults.length}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedRows(new Set(classificationResults.map((_, i) => i)))
                            } else {
                              setSelectedRows(new Set())
                            }
                          }}
                          className="rounded border-gray-300"
                          title="전체 선택/해제"
                        />
                      </th>
                      <th className="px-2 py-3 text-center text-xs font-medium text-gray-500 w-8">#</th>
                      <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 cursor-pointer hover:bg-gray-100 select-none" onClick={() => toggleSort('date')}>일자{sortIcon('date')}</th>
                      <th className="px-2 py-3 text-left text-xs font-medium text-gray-500">적요/가맹점</th>
                      <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 bg-blue-50 cursor-pointer hover:bg-blue-100 select-none" onClick={() => toggleSort('debit')} title="클릭하여 계정 변경 가능">차변(비용){sortIcon('debit')}</th>
                      <th className="px-2 py-3 text-right text-xs font-medium text-gray-500 bg-blue-50 cursor-pointer hover:bg-blue-100 select-none" onClick={() => toggleSort('debit_amt')}>차변금액{sortIcon('debit_amt')}</th>
                      <th className="px-2 py-3 text-left text-xs font-medium text-gray-500 bg-red-50 cursor-pointer hover:bg-red-100 select-none" onClick={() => toggleSort('credit')} title="클릭하여 계정 변경 가능">대변(지급){sortIcon('credit')}</th>
                      <th className="px-2 py-3 text-right text-xs font-medium text-gray-500 bg-red-50">대변금액</th>
                      <th className="px-2 py-3 text-center text-xs font-medium text-gray-500 cursor-pointer hover:bg-gray-100 select-none" onClick={() => toggleSort('confidence')}>신뢰도{sortIcon('confidence')}</th>
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
                        const ar = a.result, br = b.result
                        switch (resultSort) {
                          case 'date_asc': return (ar.transaction_date || '').localeCompare(br.transaction_date || '')
                          case 'date_desc': return (br.transaction_date || '').localeCompare(ar.transaction_date || '')
                          case 'debit_asc': return (ar.predicted_account_code || '').localeCompare(br.predicted_account_code || '')
                          case 'debit_desc': return (br.predicted_account_code || '').localeCompare(ar.predicted_account_code || '')
                          case 'debit_amt_asc': return (ar.amount || 0) - (br.amount || 0)
                          case 'debit_amt_desc': return (br.amount || 0) - (ar.amount || 0)
                          case 'credit_asc': return (ar.journal_entry?.credit_account_code || '').localeCompare(br.journal_entry?.credit_account_code || '')
                          case 'credit_desc': return (br.journal_entry?.credit_account_code || '').localeCompare(ar.journal_entry?.credit_account_code || '')
                          case 'confidence_asc': return ar.confidence - br.confidence
                          case 'confidence_desc': return br.confidence - ar.confidence
                          default: return 0
                        }
                      })
                      .map(({ result, originalIndex }) => (
                      <tr
                        key={originalIndex}
                        className={
                          (result.actual_account_code && result.actual_account_code !== result.predicted_account_code) ||
                          (creditOverrides[originalIndex] && creditOverrides[originalIndex].code !== (result.journal_entry?.credit_account_code || '253'))
                            ? 'bg-blue-50'
                            : result.needs_review
                            ? 'bg-yellow-50'
                            : ''
                        }
                      >
                        <td className="px-2 py-2 text-center">
                          <input
                            type="checkbox"
                            checked={selectedRows.has(originalIndex)}
                            onChange={(e) => {
                              setSelectedRows(prev => {
                                const next = new Set(prev)
                                if (e.target.checked) next.add(originalIndex)
                                else next.delete(originalIndex)
                                return next
                              })
                            }}
                            className="rounded border-gray-300"
                          />
                        </td>
                        <td className="px-2 py-2 text-xs text-gray-400 text-center">{result.row_index + 1}</td>
                        <td className="px-2 py-2 text-xs text-gray-500 whitespace-nowrap">
                          {result.transaction_date || '-'}
                        </td>
                        <td className="px-2 py-2 text-sm max-w-[180px] truncate" title={result.memo || result.description}>
                          {result.memo || result.description}
                        </td>

                        {/* 차변 (비용 계정) — 클릭하여 인라인 수정 */}
                        <td
                          className="px-2 py-2 text-sm bg-blue-50/50 cursor-pointer group"
                          onClick={() => setEditingCell({ rowIndex: originalIndex, side: 'debit' })}
                        >
                          {editingCell?.rowIndex === originalIndex && editingCell?.side === 'debit' ? (
                            <select
                              autoFocus
                              value={result.actual_account_code || result.predicted_account_code}
                              onChange={(e) => { e.stopPropagation(); updateClassificationResult(originalIndex, e.target.value) }}
                              onBlur={() => setEditingCell(null)}
                              className="block w-full rounded-md border-blue-400 ring-1 ring-blue-300 text-xs focus:border-blue-500 focus:ring-blue-500"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <option value={result.predicted_account_code}>
                                {result.predicted_account_code} {result.predicted_account_name} (AI)
                              </option>
                              {result.alternatives && result.alternatives.length > 0 && (
                                <optgroup label="AI 대안">
                                  {result.alternatives.map((alt) => (
                                    <option key={alt.account_code} value={alt.account_code}>
                                      {alt.account_code} {alt.account_name} ({(alt.confidence * 100).toFixed(0)}%)
                                    </option>
                                  ))}
                                </optgroup>
                              )}
                              <optgroup label="비용 계정과목">
                                {expenseAccounts.map((acc) => (
                                  <option key={acc.code} value={acc.code}>
                                    {acc.code} {acc.name}
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="전체 계정과목">
                                {allStandardAccounts.filter(a => !a.code.startsWith('5') && !a.code.startsWith('8')).map((acc) => (
                                  <option key={acc.code} value={acc.code}>
                                    {acc.code} {acc.name}
                                  </option>
                                ))}
                              </optgroup>
                            </select>
                          ) : (
                            <>
                              {result.actual_account_code && result.actual_account_code !== result.predicted_account_code && (
                                <span className="inline-block w-2 h-2 rounded-full bg-orange-400 mr-1" title="수정됨" />
                              )}
                              {(result.actual_account_code || result.predicted_account_code) ? (
                                <>
                                  <span className="font-medium text-blue-800">
                                    {result.actual_account_code || result.predicted_account_code}
                                  </span>{' '}
                                  <span className="text-gray-500 text-xs">
                                    {result.actual_account_code && result.actual_account_code !== result.predicted_account_code
                                      ? getAccountName(result.actual_account_code) || result.predicted_account_name
                                      : result.predicted_account_name}
                                  </span>
                                  <span className="text-gray-300 text-xs ml-1 opacity-0 group-hover:opacity-100 transition-opacity">&#9998;</span>
                                </>
                              ) : (
                                <span className="text-orange-500 text-xs">미분류 (클릭하여 선택)</span>
                              )}
                            </>
                          )}
                        </td>

                        <td className="px-2 py-2 text-sm text-right font-mono bg-blue-50/50 text-blue-700">
                          {result.amount?.toLocaleString()}
                        </td>

                        {/* 대변 (지급 계정) — 클릭하여 인라인 수정 */}
                        <td
                          className="px-2 py-2 text-sm bg-red-50/50 cursor-pointer group"
                          onClick={() => setEditingCell({ rowIndex: originalIndex, side: 'credit' })}
                        >
                          {editingCell?.rowIndex === originalIndex && editingCell?.side === 'credit' ? (
                            <select
                              autoFocus
                              value={creditOverrides[originalIndex]?.code || result.journal_entry?.credit_account_code || '253'}
                              onChange={(e) => { e.stopPropagation(); updateCreditAccount(originalIndex, e.target.value) }}
                              onBlur={() => setEditingCell(null)}
                              className="block w-full rounded-md border-red-400 ring-1 ring-red-300 text-xs focus:border-red-500 focus:ring-red-500"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <option value={result.journal_entry?.credit_account_code || '253'}>
                                {result.journal_entry?.credit_account_code || '253'} {result.journal_entry?.credit_account_name || '미지급금'} (기본)
                              </option>
                              <optgroup label="부채/자산 계정">
                                {allStandardAccounts.filter(a => a.code.startsWith('2') || a.code.startsWith('1')).map((acc) => (
                                  <option key={acc.code} value={acc.code}>
                                    {acc.code} {acc.name}
                                  </option>
                                ))}
                              </optgroup>
                              <optgroup label="전체 계정과목">
                                {allStandardAccounts.filter(a => !a.code.startsWith('2') && !a.code.startsWith('1')).map((acc) => (
                                  <option key={acc.code} value={acc.code}>
                                    {acc.code} {acc.name}
                                  </option>
                                ))}
                              </optgroup>
                            </select>
                          ) : (
                            <>
                              {creditOverrides[originalIndex] && creditOverrides[originalIndex].code !== (result.journal_entry?.credit_account_code || '253') && (
                                <span className="inline-block w-2 h-2 rounded-full bg-orange-400 mr-1" title="수정됨" />
                              )}
                              <span className="text-gray-600">
                                {creditOverrides[originalIndex]?.code || result.journal_entry?.credit_account_code || '253'}
                              </span>{' '}
                              <span className="text-gray-400 text-xs">
                                {creditOverrides[originalIndex]?.name || result.journal_entry?.credit_account_name || '미지급금'}
                              </span>
                              <span className="text-gray-300 text-xs ml-1 opacity-0 group-hover:opacity-100 transition-opacity">&#9998;</span>
                            </>
                          )}
                        </td>

                        <td className="px-2 py-2 text-sm text-right font-mono bg-red-50/50 text-red-600">
                          {result.amount?.toLocaleString()}
                        </td>

                        {/* 신뢰도 */}
                        <td className="px-2 py-2 text-center">
                          <span className={`inline-flex px-2 py-0.5 text-xs font-semibold rounded-full ${
                            result.confidence >= 0.85 ? 'bg-green-100 text-green-800' :
                            result.confidence >= 0.6 ? 'bg-yellow-100 text-yellow-800' :
                            'bg-red-100 text-red-800'
                          }`}>
                            {(result.confidence * 100).toFixed(0)}%
                          </span>
                          {result.review_reasons && result.review_reasons.length > 0 && (
                            <span className="block text-xs text-orange-500 mt-0.5" title={result.review_reasons.join(', ')}>
                              {result.review_reasons[0]}
                            </span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 하단 합계 */}
              <div className="p-4 border-t bg-gray-50">
                <div className="flex justify-between items-center text-sm">
                  <div className="flex gap-6">
                    <span className="text-gray-600">
                      수정: <span className="font-bold text-blue-600">
                        {classificationResults.filter(r => r.actual_account_code && r.actual_account_code !== r.predicted_account_code).length
                         + Object.entries(creditOverrides).filter(([idx, ov]) => {
                           const r = classificationResults[Number(idx)]
                           return r && ov.code !== (r.journal_entry?.credit_account_code || '253')
                         }).length}
                      </span>건
                      <span className="text-xs text-gray-400 ml-1">
                        (차변 {classificationResults.filter(r => r.actual_account_code && r.actual_account_code !== r.predicted_account_code).length} /
                        대변 {Object.entries(creditOverrides).filter(([idx, ov]) => {
                          const r = classificationResults[Number(idx)]
                          return r && ov.code !== (r.journal_entry?.credit_account_code || '253')
                        }).length})
                      </span>
                    </span>
                    {selectedRows.size > 0 && (
                      <span className="text-green-700 font-medium">
                        선택: <span className="font-bold">{selectedRows.size}</span>건
                      </span>
                    )}
                    <span className="text-gray-600">
                      표시: {
                        resultFilter === 'all' ? classificationResults.length :
                        resultFilter === 'review' ? classificationResults.filter(r => r.needs_review).length :
                        classificationResults.filter(r => r.auto_confirm).length
                      }건
                    </span>
                  </div>
                  <div className="flex gap-6 font-mono">
                    <span className="text-blue-700">
                      차변 합계: <span className="font-bold">{classificationResults.reduce((s, r) => s + (r.amount || 0), 0).toLocaleString()}</span>
                    </span>
                    <span className="text-red-600">
                      대변 합계: <span className="font-bold">{classificationResults.reduce((s, r) => s + (r.amount || 0), 0).toLocaleString()}</span>
                    </span>
                    <span className="text-green-700 font-bold">
                      대차 일치
                    </span>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* 분류 이력 목록 */}
          <div className="bg-white rounded-lg shadow border">
            <div className="p-4 border-b">
              <h3 className="text-lg font-medium">분류 이력</h3>
              <p className="text-sm text-gray-500 mt-1">과거 분류 결과를 클릭하면 다시 불러올 수 있습니다.</p>
            </div>
            {uploadHistory && uploadHistory.filter(u => u.upload_type === 'classification').length > 0 ? (
              <div className="divide-y divide-gray-100">
                {uploadHistory
                  .filter(u => u.upload_type === 'classification')
                  .map(u => (
                    <div
                      key={u.id}
                      className={`flex items-center justify-between px-4 py-3 hover:bg-gray-50 ${
                        currentUploadId === u.id ? 'bg-blue-50 border-l-4 border-blue-500' : ''
                      }`}
                    >
                      <div
                        className="flex-1 cursor-pointer"
                        onClick={() => handleLoadClassifyResult(u.id)}
                      >
                        <span className="font-medium text-sm">{u.filename}</span>
                        <span className="text-xs text-gray-400 ml-3">
                          {u.row_count}건 | {u.created_at ? new Date(u.created_at).toLocaleString('ko-KR') : '-'}
                        </span>
                        {currentUploadId === u.id && (
                          <span className="ml-2 text-xs text-blue-600 font-medium">현재 보는 중</span>
                        )}
                      </div>
                      <button
                        onClick={(e) => { e.stopPropagation(); handleDeleteUpload(u.id, u.filename) }}
                        disabled={loading}
                        className="text-xs text-red-500 hover:text-red-700 px-2 py-1 rounded hover:bg-red-50"
                      >
                        삭제
                      </button>
                    </div>
                  ))}
              </div>
            ) : (
              <div className="p-8 text-center text-gray-400 text-sm">
                분류 이력이 없습니다. 자동 분류 탭에서 파일을 업로드하여 분류를 실행하세요.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

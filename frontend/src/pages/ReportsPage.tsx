import { useState } from 'react'
import toast from 'react-hot-toast'
import { reportsApi } from '@/services/api'
import {
  DocumentChartBarIcon,
  ArrowDownTrayIcon,
  DocumentTextIcon,
} from '@heroicons/react/24/outline'

function downloadBlob(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  window.URL.revokeObjectURL(url)
}

export default function ReportsPage() {
  const currentYear = new Date().getFullYear()
  const [loading, setLoading] = useState<string | null>(null)

  // Voucher report params
  const [voucherParams, setVoucherParams] = useState({
    fromDate: new Date(currentYear, 0, 1).toISOString().split('T')[0],
    toDate: new Date().toISOString().split('T')[0],
    status: '',
  })

  // Budget report params
  const [budgetYear, setBudgetYear] = useState(currentYear)

  // Aging report params
  const [agingType, setAgingType] = useState<'receivables' | 'payables'>('receivables')

  // Douzone export params
  const [douzoneParams, setDouzoneParams] = useState({
    fromDate: new Date(currentYear, new Date().getMonth(), 1).toISOString().split('T')[0],
    toDate: new Date().toISOString().split('T')[0],
  })

  const handleExportVouchers = async () => {
    if (!voucherParams.fromDate || !voucherParams.toDate) {
      toast.error('기간을 설정해주세요.')
      return
    }
    setLoading('vouchers')
    try {
      const response = await reportsApi.exportVouchersExcel(
        voucherParams.fromDate,
        voucherParams.toDate,
        undefined,
        voucherParams.status || undefined
      )
      downloadBlob(
        new Blob([response.data]),
        `전표목록_${voucherParams.fromDate}_${voucherParams.toDate}.xlsx`
      )
      toast.success('전표 보고서가 다운로드되었습니다.')
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '보고서 다운로드에 실패했습니다.')
    } finally {
      setLoading(null)
    }
  }

  const handleExportBudgetVsActual = async () => {
    setLoading('budget')
    try {
      const response = await reportsApi.exportBudgetVsActualExcel(budgetYear)
      downloadBlob(
        new Blob([response.data]),
        `예산대비실적_${budgetYear}.xlsx`
      )
      toast.success('예산 대비 실적 보고서가 다운로드되었습니다.')
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '보고서 다운로드에 실패했습니다.')
    } finally {
      setLoading(null)
    }
  }

  const handleExportAging = async () => {
    setLoading('aging')
    try {
      const response = await reportsApi.exportAgingExcel(agingType)
      downloadBlob(
        new Blob([response.data]),
        `${agingType === 'receivables' ? '매출채권' : '매입채무'}_연령분석.xlsx`
      )
      toast.success('연령 분석 보고서가 다운로드되었습니다.')
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '보고서 다운로드에 실패했습니다.')
    } finally {
      setLoading(null)
    }
  }

  const handleExportDouzone = async () => {
    if (!douzoneParams.fromDate || !douzoneParams.toDate) {
      toast.error('기간을 설정해주세요.')
      return
    }
    setLoading('douzone')
    try {
      const response = await reportsApi.exportToDouzone(
        douzoneParams.fromDate,
        douzoneParams.toDate
      )
      downloadBlob(
        new Blob([response.data]),
        `더존전표_${douzoneParams.fromDate}_${douzoneParams.toDate}.xlsx`
      )
      toast.success('더존 양식 내보내기가 완료되었습니다.')
    } catch (error: any) {
      toast.error(error.response?.data?.detail || '내보내기에 실패했습니다.')
    } finally {
      setLoading(null)
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">보고서</h1>
        <p className="text-gray-500 mt-1">
          다양한 재무 보고서를 생성하고 내보냅니다.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Voucher Report */}
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-blue-100 rounded-lg">
              <DocumentTextIcon className="h-6 w-6 text-blue-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">전표 목록 보고서</h3>
              <p className="text-sm text-gray-500">기간별 전표를 엑셀로 내보냅니다.</p>
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={voucherParams.fromDate}
                onChange={(e) =>
                  setVoucherParams({ ...voucherParams, fromDate: e.target.value })
                }
                className="input w-40"
              />
              <span className="text-gray-400">~</span>
              <input
                type="date"
                value={voucherParams.toDate}
                onChange={(e) =>
                  setVoucherParams({ ...voucherParams, toDate: e.target.value })
                }
                className="input w-40"
              />
            </div>
            <div>
              <select
                value={voucherParams.status}
                onChange={(e) =>
                  setVoucherParams({ ...voucherParams, status: e.target.value })
                }
                className="input w-full"
              >
                <option value="">전체 상태</option>
                <option value="draft">임시저장</option>
                <option value="pending_approval">결재대기</option>
                <option value="approved">결재완료</option>
                <option value="confirmed">확정</option>
                <option value="rejected">반려</option>
              </select>
            </div>
            <button
              onClick={handleExportVouchers}
              disabled={loading === 'vouchers'}
              className="btn-primary w-full"
            >
              <ArrowDownTrayIcon className="h-5 w-5 mr-2" />
              {loading === 'vouchers' ? '다운로드 중...' : '엑셀 다운로드'}
            </button>
          </div>
        </div>

        {/* Budget vs Actual Report */}
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-green-100 rounded-lg">
              <DocumentChartBarIcon className="h-6 w-6 text-green-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">예산 대비 실적 보고서</h3>
              <p className="text-sm text-gray-500">
                연도별 예산 대비 실적을 비교합니다.
              </p>
            </div>
          </div>
          <div className="space-y-3">
            <select
              value={budgetYear}
              onChange={(e) => setBudgetYear(Number(e.target.value))}
              className="input w-full"
            >
              {[currentYear - 2, currentYear - 1, currentYear, currentYear + 1].map(
                (year) => (
                  <option key={year} value={year}>
                    {year}년
                  </option>
                )
              )}
            </select>
            <button
              onClick={handleExportBudgetVsActual}
              disabled={loading === 'budget'}
              className="btn-primary w-full"
            >
              <ArrowDownTrayIcon className="h-5 w-5 mr-2" />
              {loading === 'budget' ? '다운로드 중...' : '엑셀 다운로드'}
            </button>
          </div>
        </div>

        {/* Aging Report */}
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-yellow-100 rounded-lg">
              <DocumentChartBarIcon className="h-6 w-6 text-yellow-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">채권/채무 연령 분석</h3>
              <p className="text-sm text-gray-500">
                매출채권 또는 매입채무의 연령 분석을 제공합니다.
              </p>
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex gap-2">
              <button
                onClick={() => setAgingType('receivables')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium ${
                  agingType === 'receivables'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                매출채권
              </button>
              <button
                onClick={() => setAgingType('payables')}
                className={`flex-1 py-2 rounded-lg text-sm font-medium ${
                  agingType === 'payables'
                    ? 'bg-blue-100 text-blue-700'
                    : 'bg-gray-100 text-gray-600'
                }`}
              >
                매입채무
              </button>
            </div>
            <button
              onClick={handleExportAging}
              disabled={loading === 'aging'}
              className="btn-primary w-full"
            >
              <ArrowDownTrayIcon className="h-5 w-5 mr-2" />
              {loading === 'aging' ? '다운로드 중...' : '엑셀 다운로드'}
            </button>
          </div>
        </div>

        {/* Douzone Export */}
        <div className="card">
          <div className="flex items-center gap-3 mb-4">
            <div className="p-2 bg-purple-100 rounded-lg">
              <DocumentTextIcon className="h-6 w-6 text-purple-600" />
            </div>
            <div>
              <h3 className="font-semibold text-gray-900">더존 양식 내보내기</h3>
              <p className="text-sm text-gray-500">
                더존 호환 형식으로 전표를 내보냅니다.
              </p>
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={douzoneParams.fromDate}
                onChange={(e) =>
                  setDouzoneParams({ ...douzoneParams, fromDate: e.target.value })
                }
                className="input w-40"
              />
              <span className="text-gray-400">~</span>
              <input
                type="date"
                value={douzoneParams.toDate}
                onChange={(e) =>
                  setDouzoneParams({ ...douzoneParams, toDate: e.target.value })
                }
                className="input w-40"
              />
            </div>
            <button
              onClick={handleExportDouzone}
              disabled={loading === 'douzone'}
              className="btn-primary w-full"
            >
              <ArrowDownTrayIcon className="h-5 w-5 mr-2" />
              {loading === 'douzone' ? '내보내기 중...' : '더존 양식 내보내기'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { salesApi } from '@/services/api'
import {
  PlusIcon,
  ArrowDownTrayIcon,
  PaperAirplaneIcon,
  CheckCircleIcon,
  PencilIcon,
  TrashIcon,
  DocumentArrowUpIcon,
} from '@heroicons/react/24/outline'
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

function formatCurrency(value: number) {
  return new Intl.NumberFormat('ko-KR', {
    style: 'currency',
    currency: 'KRW',
    maximumFractionDigits: 0,
  }).format(value)
}

function formatNumber(value: number) {
  return new Intl.NumberFormat('ko-KR').format(value)
}

type TabType = 'dashboard' | 'channels' | 'voucher' | 'automation'

const statusBadge: Record<string, { className: string; label: string }> = {
  pending: { className: 'bg-yellow-100 text-yellow-800', label: '대기' },
  confirmed: { className: 'bg-blue-100 text-blue-800', label: '확정' },
  settled: { className: 'bg-green-100 text-green-800', label: '정산' },
  converted: { className: 'bg-gray-100 text-gray-800', label: '전환완료' },
}

const channelTypeBadge: Record<string, { className: string; label: string }> = {
  online_marketplace: { className: 'bg-blue-100 text-blue-800', label: '온라인' },
  own_website: { className: 'bg-indigo-100 text-indigo-800', label: '자사몰' },
  offline: { className: 'bg-green-100 text-green-800', label: '오프라인' },
  wholesale: { className: 'bg-purple-100 text-purple-800', label: '도매/B2B' },
}

// ============================================================================
// Main Page Component
// ============================================================================
export default function SalesAutomationPage() {
  const [activeTab, setActiveTab] = useState<TabType>('dashboard')

  const tabs: { id: TabType; label: string }[] = [
    { id: 'dashboard', label: '매출 현황' },
    { id: 'channels', label: '채널 관리' },
    { id: 'voucher', label: '전표 전환' },
    { id: 'automation', label: '자동화 설정' },
  ]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">매출 자동화</h1>
        <p className="text-gray-500 mt-1">채널별 매출을 수집하고 전표로 전환합니다.</p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="flex gap-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`pb-3 px-1 text-sm font-medium border-b-2 transition-colors ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </nav>
      </div>

      {activeTab === 'dashboard' && <SalesDashboardTab />}
      {activeTab === 'channels' && <ChannelManagementTab />}
      {activeTab === 'voucher' && <VoucherConversionTab />}
      {activeTab === 'automation' && <AutomationSettingsTab />}
    </div>
  )
}

// ============================================================================
// Tab 1: Sales Dashboard
// ============================================================================
function SalesDashboardTab() {
  const queryClient = useQueryClient()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [selectedIds, setSelectedIds] = useState<number[]>([])
  const [showReportModal, setShowReportModal] = useState(false)

  const { data: monthlySummary } = useQuery({
    queryKey: ['salesMonthlySummary', year, month],
    queryFn: () => salesApi.getMonthlySummary(year, month).then((r) => r.data),
  })

  const { data: yearlySummary } = useQuery({
    queryKey: ['salesYearlySummary', year],
    queryFn: () => salesApi.getYearlySummary(year).then((r) => r.data),
  })

  const { data: records, isLoading: recordsLoading } = useQuery({
    queryKey: ['salesRecords', year, month],
    queryFn: () => salesApi.getRecords({ year, month }).then((r) => r.data),
  })

  const confirmMutation = useMutation({
    mutationFn: (id: number) => salesApi.confirmRecord(id),
    onSuccess: () => {
      toast.success('매출이 확정되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['salesRecords'] })
      queryClient.invalidateQueries({ queryKey: ['salesMonthlySummary'] })
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '확정에 실패했습니다.')
    },
  })

  const convertMutation = useMutation({
    mutationFn: (ids: number[]) => salesApi.convertToVoucher(ids),
    onSuccess: (res) => {
      toast.success(`${res.data?.voucher_count || 0}건의 전표가 생성되었습니다.`)
      queryClient.invalidateQueries({ queryKey: ['salesRecords'] })
      setSelectedIds([])
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '전표 전환에 실패했습니다.')
    },
  })

  const handleExportExcel = async () => {
    try {
      const response = await salesApi.exportExcel(year, month)
      const url = window.URL.createObjectURL(new Blob([response.data]))
      const link = document.createElement('a')
      link.href = url
      link.setAttribute('download', `매출현황_${year}${String(month).padStart(2, '0')}.xlsx`)
      document.body.appendChild(link)
      link.click()
      link.remove()
      window.URL.revokeObjectURL(url)
      toast.success('엑셀 파일이 다운로드되었습니다.')
    } catch {
      toast.error('엑셀 다운로드에 실패했습니다.')
    }
  }

  const handleSelectAll = (checked: boolean) => {
    if (checked && records) {
      setSelectedIds(records.map((r: any) => r.id))
    } else {
      setSelectedIds([])
    }
  }

  const handleSelectOne = (id: number, checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => [...prev, id])
    } else {
      setSelectedIds((prev) => prev.filter((x) => x !== id))
    }
  }

  const confirmSelected = () => {
    const pendingSelected = (records || [])
      .filter((r: any) => selectedIds.includes(r.id) && r.status === 'pending')
    if (pendingSelected.length === 0) {
      toast.error('확정할 대기 상태 항목을 선택하세요.')
      return
    }
    pendingSelected.forEach((r: any) => confirmMutation.mutate(r.id))
  }

  const convertSelected = () => {
    const confirmedSelected = (records || [])
      .filter((r: any) => selectedIds.includes(r.id) && r.status === 'confirmed')
      .map((r: any) => r.id)
    if (confirmedSelected.length === 0) {
      toast.error('전표 전환할 확정 상태 항목을 선택하세요.')
      return
    }
    convertMutation.mutate(confirmedSelected)
  }

  // Summary cards data
  const totalGross = monthlySummary?.total_gross_sales || 0
  const totalNet = monthlySummary?.total_net_sales || 0
  const totalCommission = monthlySummary?.total_commission || 0
  const totalSettlement = monthlySummary?.total_settlement || 0

  // Channel bar chart data
  const channelChartData = useMemo(() => {
    return (monthlySummary?.channels || []).map((ch: any) => ({
      name: ch.channel_name,
      net_sales: ch.net_sales || 0,
    }))
  }, [monthlySummary])

  // Monthly trend data
  const trendData = useMemo(() => {
    return (yearlySummary?.monthly_trend || []).map((m: any) => ({
      month: `${m.month}월`,
      net_sales: m.net_sales || 0,
    }))
  }, [yearlySummary])

  return (
    <div className="space-y-6">
      {/* Year/Month Selector */}
      <div className="card">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">연도</label>
            <select
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
              className="input w-28"
            >
              {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((y) => (
                <option key={y} value={y}>{y}년</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">월</label>
            <select
              value={month}
              onChange={(e) => setMonth(Number(e.target.value))}
              className="input w-24"
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>{m}월</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="card">
          <p className="text-sm text-gray-500">총 매출</p>
          <p className="text-xl font-bold text-gray-900">{formatCurrency(totalGross)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">순 매출</p>
          <p className="text-xl font-bold text-blue-600">{formatCurrency(totalNet)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">수수료</p>
          <p className="text-xl font-bold text-red-600">{formatCurrency(totalCommission)}</p>
        </div>
        <div className="card">
          <p className="text-sm text-gray-500">정산액</p>
          <p className="text-xl font-bold text-green-600">{formatCurrency(totalSettlement)}</p>
        </div>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Channel Bar Chart */}
        <div className="card">
          <h3 className="card-header">채널별 매출 비교</h3>
          <div className="h-72">
            {channelChartData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={channelChartData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis type="number" stroke="#6b7280" fontSize={12} tickFormatter={(v) => `${(v / 10000).toFixed(0)}만`} />
                  <YAxis dataKey="name" type="category" stroke="#6b7280" fontSize={12} width={90} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }}
                    formatter={(value: number) => formatCurrency(value)}
                  />
                  <Bar dataKey="net_sales" name="순매출" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                데이터가 없습니다.
              </div>
            )}
          </div>
        </div>

        {/* Monthly Trend Line Chart */}
        <div className="card">
          <h3 className="card-header">월별 매출 추이</h3>
          <div className="h-72">
            {trendData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" />
                  <XAxis dataKey="month" stroke="#6b7280" fontSize={12} />
                  <YAxis stroke="#6b7280" fontSize={12} tickFormatter={(v) => `${(v / 10000).toFixed(0)}만`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'white', border: '1px solid #e5e7eb', borderRadius: '8px' }}
                    formatter={(value: number) => formatCurrency(value)}
                  />
                  <Line type="monotone" dataKey="net_sales" name="순매출" stroke="#3b82f6" strokeWidth={2} dot={{ r: 4 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-400 text-sm">
                데이터가 없습니다.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Action Buttons */}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={confirmSelected} className="btn-primary" disabled={confirmMutation.isPending}>
          <CheckCircleIcon className="h-5 w-5 mr-1" />
          선택 확정
        </button>
        <button onClick={convertSelected} className="btn-secondary" disabled={convertMutation.isPending}>
          <DocumentArrowUpIcon className="h-5 w-5 mr-1" />
          전표 전환
        </button>
        <button onClick={handleExportExcel} className="btn-secondary">
          <ArrowDownTrayIcon className="h-5 w-5 mr-1" />
          엑셀 다운로드
        </button>
        <button onClick={() => setShowReportModal(true)} className="btn-secondary">
          <PaperAirplaneIcon className="h-5 w-5 mr-1" />
          리포트 발송
        </button>
      </div>

      {/* Records Table */}
      <div className="card">
        <h3 className="card-header">채널별 매출 테이블</h3>
        {recordsLoading ? (
          <div className="text-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
            <p className="text-gray-500 mt-2">로딩 중...</p>
          </div>
        ) : records && records.length > 0 ? (
          <div className="table-container">
            <table className="table">
              <thead className="table-header">
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={records.length > 0 && selectedIds.length === records.length}
                      onChange={(e) => handleSelectAll(e.target.checked)}
                      className="rounded border-gray-300"
                    />
                  </th>
                  <th>채널명</th>
                  <th className="text-right">총매출</th>
                  <th className="text-right">반품</th>
                  <th className="text-right">순매출</th>
                  <th className="text-right">수수료</th>
                  <th className="text-right">정산액</th>
                  <th className="text-right">건수</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {records.map((record: any) => {
                  const badge = statusBadge[record.status] || statusBadge.pending
                  return (
                    <tr key={record.id}>
                      <td>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(record.id)}
                          onChange={(e) => handleSelectOne(record.id, e.target.checked)}
                          className="rounded border-gray-300"
                        />
                      </td>
                      <td className="font-medium">{record.channel_name}</td>
                      <td className="amount">{formatCurrency(record.gross_sales || 0)}</td>
                      <td className="amount">{formatCurrency(record.returns || 0)}</td>
                      <td className="amount">{formatCurrency(record.net_sales || 0)}</td>
                      <td className="amount text-red-600">{formatCurrency(record.commission || 0)}</td>
                      <td className="amount text-green-600">{formatCurrency(record.settlement || 0)}</td>
                      <td className="text-right">{formatNumber(record.transaction_count || 0)}</td>
                      <td>
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${badge.className}`}>
                          {badge.label}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8 text-gray-500">매출 기록이 없습니다.</div>
        )}
      </div>

      {/* Report Modal */}
      {showReportModal && (
        <ReportModal
          year={year}
          month={month}
          onClose={() => setShowReportModal(false)}
        />
      )}
    </div>
  )
}

// ============================================================================
// Report Modal
// ============================================================================
function ReportModal({ year, month, onClose }: { year: number; month: number; onClose: () => void }) {
  const [recipients, setRecipients] = useState('')

  const sendMutation = useMutation({
    mutationFn: () =>
      salesApi.sendReport({
        year,
        month,
        recipients: recipients.split(',').map((r) => r.trim()).filter(Boolean),
      }),
    onSuccess: () => {
      toast.success('리포트가 발송되었습니다.')
      onClose()
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '리포트 발송에 실패했습니다.')
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!recipients.trim()) {
      toast.error('수신자 이메일을 입력하세요.')
      return
    }
    sendMutation.mutate()
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-md">
        <h3 className="text-lg font-bold text-gray-900 mb-4">리포트 발송</h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">기간</label>
            <p className="text-sm text-gray-600">{year}년 {month}월</p>
          </div>
          <div>
            <label className="label">수신자 이메일 (쉼표 구분)</label>
            <input
              type="text"
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              className="w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              placeholder="user1@example.com, user2@example.com"
            />
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">
              취소
            </button>
            <button type="submit" disabled={sendMutation.isPending} className="px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {sendMutation.isPending ? '발송 중...' : '발송'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ============================================================================
// Tab 2: Channel Management
// ============================================================================
function ChannelManagementTab() {
  const queryClient = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [editingChannel, setEditingChannel] = useState<any>(null)

  const { data: channels, isLoading } = useQuery({
    queryKey: ['salesChannels'],
    queryFn: () => salesApi.getChannels().then((r) => r.data),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => salesApi.deleteChannel(id),
    onSuccess: () => {
      toast.success('채널이 삭제되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['salesChannels'] })
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '채널 삭제에 실패했습니다.')
    },
  })

  const handleEdit = (channel: any) => {
    setEditingChannel(channel)
    setShowModal(true)
  }

  const handleDelete = (channel: any) => {
    if (window.confirm(`"${channel.name}" 채널을 삭제하시겠습니까?`)) {
      deleteMutation.mutate(channel.id)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button
          onClick={() => { setEditingChannel(null); setShowModal(true) }}
          className="btn-primary"
        >
          <PlusIcon className="h-5 w-5 mr-1" />
          채널 추가
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
          <p className="text-gray-500 mt-2">로딩 중...</p>
        </div>
      ) : channels && channels.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {channels.map((channel: any) => {
            const typeBadge = channelTypeBadge[channel.channel_type] || channelTypeBadge.online
            return (
              <div key={channel.id} className="card">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h4 className="font-semibold text-gray-900">{channel.name}</h4>
                    <p className="text-sm text-gray-500">{channel.channel_code}</p>
                  </div>
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${typeBadge.className}`}>
                    {typeBadge.label}
                  </span>
                </div>

                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-500">수수료율</span>
                    <span className="font-medium">{channel.commission_rate || 0}%</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">정산일</span>
                    <span className="font-medium">매월 {channel.settlement_day || '-'}일</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">수집방식</span>
                    <span className="font-medium">{channel.collection_method || '-'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">최근 동기화</span>
                    <span className="font-medium text-xs">{channel.last_sync || '-'}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-gray-500">활성화</span>
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${
                      channel.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                    }`}>
                      {channel.is_active ? '활성' : '비활성'}
                    </span>
                  </div>
                </div>

                <div className="flex justify-end gap-2 mt-4 pt-3 border-t">
                  <button
                    onClick={() => handleEdit(channel)}
                    className="p-2 text-gray-400 hover:text-blue-600 rounded-lg hover:bg-blue-50"
                  >
                    <PencilIcon className="h-4 w-4" />
                  </button>
                  <button
                    onClick={() => handleDelete(channel)}
                    className="p-2 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50"
                  >
                    <TrashIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="card text-center py-12 text-gray-500">
          등록된 채널이 없습니다. '채널 추가' 버튼을 눌러 추가하세요.
        </div>
      )}

      {showModal && (
        <ChannelModal
          channel={editingChannel}
          onClose={() => { setShowModal(false); setEditingChannel(null) }}
        />
      )}
    </div>
  )
}

// ============================================================================
// Channel Create/Edit Modal
// ============================================================================
function ChannelModal({ channel, onClose }: { channel: any | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const isEdit = !!channel

  const [formData, setFormData] = useState({
    name: channel?.name || '',
    channel_code: channel?.channel_code || '',
    channel_type: channel?.channel_type || 'online',
    collection_method: channel?.collection_method || 'manual',
    platform_url: channel?.platform_url || '',
    seller_id: channel?.seller_id || '',
    api_key: channel?.api_key || '',
    api_secret: channel?.api_secret || '',
    commission_rate: channel?.commission_rate || 0,
    settlement_day: channel?.settlement_day || 25,
    login_id: channel?.login_id || '',
    login_password: '',
    is_active: channel?.is_active ?? true,
  })

  const createMutation = useMutation({
    mutationFn: (data: any) => salesApi.createChannel(data),
    onSuccess: () => {
      toast.success('채널이 추가되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['salesChannels'] })
      onClose()
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '채널 추가에 실패했습니다.')
    },
  })

  const updateMutation = useMutation({
    mutationFn: (data: any) => salesApi.updateChannel(channel.id, data),
    onSuccess: () => {
      toast.success('채널이 수정되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['salesChannels'] })
      onClose()
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '채널 수정에 실패했습니다.')
    },
  })

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.name.trim()) {
      toast.error('채널명을 입력하세요.')
      return
    }
    if (!formData.channel_code.trim()) {
      toast.error('채널코드를 입력하세요.')
      return
    }

    // 백엔드 필드명으로 매핑
    const channelTypeMap: Record<string, string> = {
      online: 'online_marketplace',
      offline: 'offline',
      wholesale: 'wholesale',
      own_website: 'own_website',
    }

    const payload: any = {
      code: formData.channel_code,
      name: formData.name,
      channel_type: channelTypeMap[formData.channel_type] || formData.channel_type,
      api_type: formData.collection_method,
      platform_url: formData.platform_url || null,
      commission_rate: formData.commission_rate,
      settlement_day: formData.settlement_day,
      is_active: formData.is_active,
    }

    // API 방식일 때만 API 필드 포함
    if (formData.collection_method === 'api') {
      payload.seller_id = formData.seller_id || null
      payload.api_key = formData.api_key || null
      payload.api_secret = formData.api_secret || null
    }

    // 스크래핑 방식일 때만 로그인 필드 포함
    if (formData.collection_method === 'scraping') {
      payload.login_id = formData.login_id || null
      if (formData.login_password) {
        payload.login_password = formData.login_password
      }
    }

    if (isEdit) {
      updateMutation.mutate(payload)
    } else {
      createMutation.mutate(payload)
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending
  const inputClass = 'w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent'

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-bold text-gray-900 mb-4">
          {isEdit ? '채널 수정' : '채널 추가'}
        </h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">채널명 <span className="text-red-500">*</span></label>
              <input type="text" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className={inputClass} placeholder="예: 쿠팡" />
            </div>
            <div>
              <label className="label">채널코드 <span className="text-red-500">*</span></label>
              <input type="text" value={formData.channel_code} onChange={(e) => setFormData({ ...formData, channel_code: e.target.value })} className={inputClass} placeholder="예: COUPANG" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">채널유형</label>
              <select value={formData.channel_type} onChange={(e) => setFormData({ ...formData, channel_type: e.target.value })} className={inputClass}>
                <option value="online">온라인 마켓플레이스</option>
                <option value="own_website">자사몰</option>
                <option value="offline">오프라인</option>
                <option value="wholesale">도매/B2B</option>
              </select>
            </div>
            <div>
              <label className="label">수집방식</label>
              <select value={formData.collection_method} onChange={(e) => setFormData({ ...formData, collection_method: e.target.value })} className={inputClass}>
                <option value="api">API</option>
                <option value="scraping">스크래핑</option>
                <option value="manual">수동</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">수수료율 (%)</label>
              <input type="number" value={formData.commission_rate} onChange={(e) => setFormData({ ...formData, commission_rate: Number(e.target.value) })} className={inputClass} min={0} max={100} step={0.1} />
            </div>
            <div>
              <label className="label">정산일</label>
              <input type="number" value={formData.settlement_day} onChange={(e) => setFormData({ ...formData, settlement_day: Number(e.target.value) })} className={inputClass} min={1} max={31} />
            </div>
          </div>

          <div>
            <label className="label">플랫폼 URL</label>
            <input type="url" value={formData.platform_url} onChange={(e) => setFormData({ ...formData, platform_url: e.target.value })} className={inputClass} placeholder="https://wing.coupang.com 등 (선택)" />
          </div>

          {/* API 방식일 때만 API 연동 필드 */}
          {formData.collection_method === 'api' && (
            <div className="bg-blue-50 rounded-lg p-4 space-y-3">
              <p className="text-sm font-medium text-blue-700">API 연동 설정</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">셀러 ID</label>
                  <input type="text" value={formData.seller_id} onChange={(e) => setFormData({ ...formData, seller_id: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label className="label">API Key</label>
                  <input type="password" value={formData.api_key} onChange={(e) => setFormData({ ...formData, api_key: e.target.value })} className={inputClass} />
                </div>
              </div>
              <div>
                <label className="label">API Secret</label>
                <input type="password" value={formData.api_secret} onChange={(e) => setFormData({ ...formData, api_secret: e.target.value })} className={inputClass} />
              </div>
            </div>
          )}

          {/* 스크래핑 방식일 때만 로그인 필드 */}
          {formData.collection_method === 'scraping' && (
            <div className="bg-amber-50 rounded-lg p-4 space-y-3">
              <p className="text-sm font-medium text-amber-700">스크래핑 로그인 설정</p>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="label">로그인 ID</label>
                  <input type="text" value={formData.login_id} onChange={(e) => setFormData({ ...formData, login_id: e.target.value })} className={inputClass} />
                </div>
                <div>
                  <label className="label">비밀번호</label>
                  <input type="password" value={formData.login_password} onChange={(e) => setFormData({ ...formData, login_password: e.target.value })} className={inputClass} />
                </div>
              </div>
            </div>
          )}

          {/* 수동 방식 안내 */}
          {formData.collection_method === 'manual' && (
            <div className="bg-gray-50 rounded-lg p-4">
              <p className="text-sm text-gray-600">수동 방식: 매출 데이터를 직접 입력하거나 엑셀로 업로드합니다.</p>
            </div>
          )}

          <div className="flex items-center gap-2">
            <input
              type="checkbox"
              id="channel-active"
              checked={formData.is_active}
              onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
            />
            <label htmlFor="channel-active" className="text-sm text-gray-700">활성화</label>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">
              취소
            </button>
            <button type="submit" disabled={isPending} className="px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {isPending ? '저장 중...' : isEdit ? '수정' : '추가'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// ============================================================================
// Tab 3: Voucher Conversion
// ============================================================================
function VoucherConversionTab() {
  const queryClient = useQueryClient()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [selectedIds, setSelectedIds] = useState<number[]>([])

  const { data: records, isLoading } = useQuery({
    queryKey: ['salesRecords', year, month],
    queryFn: () => salesApi.getRecords({ year, month }).then((r) => r.data),
  })

  const confirmedRecords = useMemo(() => {
    return (records || []).filter((r: any) => r.status === 'confirmed')
  }, [records])

  const convertedRecords = useMemo(() => {
    return (records || []).filter((r: any) => r.status === 'converted')
  }, [records])

  const convertMutation = useMutation({
    mutationFn: (ids: number[]) => salesApi.convertToVoucher(ids),
    onSuccess: (res) => {
      toast.success(`${res.data?.voucher_count || 0}건의 전표가 생성되었습니다.`)
      queryClient.invalidateQueries({ queryKey: ['salesRecords'] })
      setSelectedIds([])
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '전표 전환에 실패했습니다.')
    },
  })

  const handleConvert = () => {
    if (selectedIds.length === 0) {
      toast.error('전환할 항목을 선택하세요.')
      return
    }
    convertMutation.mutate(selectedIds)
  }

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      setSelectedIds(confirmedRecords.map((r: any) => r.id))
    } else {
      setSelectedIds([])
    }
  }

  const handleSelectOne = (id: number, checked: boolean) => {
    if (checked) {
      setSelectedIds((prev) => [...prev, id])
    } else {
      setSelectedIds((prev) => prev.filter((x) => x !== id))
    }
  }

  return (
    <div className="space-y-6">
      {/* Year/Month Selector */}
      <div className="card">
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">연도</label>
            <select value={year} onChange={(e) => setYear(Number(e.target.value))} className="input w-28">
              {[now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1].map((y) => (
                <option key={y} value={y}>{y}년</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm font-medium text-gray-700">월</label>
            <select value={month} onChange={(e) => setMonth(Number(e.target.value))} className="input w-24">
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>{m}월</option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Conversion Info */}
      <div className="card bg-blue-50 border border-blue-200">
        <h4 className="font-semibold text-blue-900 mb-2">전표 전환 안내</h4>
        <div className="text-sm text-blue-800 space-y-1">
          <p>확정된 매출 기록을 선택하여 전표로 전환합니다. 전환 시 다음 전표가 자동 생성됩니다:</p>
          <ul className="list-disc list-inside ml-2 space-y-1">
            <li><strong>매출 전표:</strong> 차변(매출채권) / 대변(상품매출)</li>
            <li><strong>수수료 전표:</strong> 차변(판매수수료) / 대변(매출채권)</li>
          </ul>
        </div>
      </div>

      {/* Confirmed Records (ready for conversion) */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900">전환 대상 (확정 상태)</h3>
          <button
            onClick={handleConvert}
            disabled={selectedIds.length === 0 || convertMutation.isPending}
            className="btn-primary"
          >
            <DocumentArrowUpIcon className="h-5 w-5 mr-1" />
            {convertMutation.isPending ? '전환 중...' : `전표 전환 (${selectedIds.length}건)`}
          </button>
        </div>

        {isLoading ? (
          <div className="text-center py-8">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
            <p className="text-gray-500 mt-2">로딩 중...</p>
          </div>
        ) : confirmedRecords.length > 0 ? (
          <div className="table-container">
            <table className="table">
              <thead className="table-header">
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={confirmedRecords.length > 0 && selectedIds.length === confirmedRecords.length}
                      onChange={(e) => handleSelectAll(e.target.checked)}
                      className="rounded border-gray-300"
                    />
                  </th>
                  <th>채널명</th>
                  <th className="text-right">순매출</th>
                  <th className="text-right">수수료</th>
                  <th className="text-right">정산액</th>
                  <th className="text-right">건수</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {confirmedRecords.map((record: any) => (
                  <tr key={record.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedIds.includes(record.id)}
                        onChange={(e) => handleSelectOne(record.id, e.target.checked)}
                        className="rounded border-gray-300"
                      />
                    </td>
                    <td className="font-medium">{record.channel_name}</td>
                    <td className="amount">{formatCurrency(record.net_sales || 0)}</td>
                    <td className="amount text-red-600">{formatCurrency(record.commission || 0)}</td>
                    <td className="amount text-green-600">{formatCurrency(record.settlement || 0)}</td>
                    <td className="text-right">{formatNumber(record.transaction_count || 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8 text-gray-500">
            전환 대상인 확정 상태의 매출이 없습니다.
          </div>
        )}
      </div>

      {/* Conversion History (already converted) */}
      <div className="card">
        <h3 className="card-header">전환 이력 (전환 완료)</h3>
        {convertedRecords.length > 0 ? (
          <div className="table-container">
            <table className="table">
              <thead className="table-header">
                <tr>
                  <th>채널명</th>
                  <th className="text-right">순매출</th>
                  <th className="text-right">수수료</th>
                  <th className="text-right">정산액</th>
                  <th>전표번호</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {convertedRecords.map((record: any) => (
                  <tr key={record.id}>
                    <td className="font-medium">{record.channel_name}</td>
                    <td className="amount">{formatCurrency(record.net_sales || 0)}</td>
                    <td className="amount text-red-600">{formatCurrency(record.commission || 0)}</td>
                    <td className="amount text-green-600">{formatCurrency(record.settlement || 0)}</td>
                    <td className="text-sm text-blue-600">
                      {record.voucher_id ? `#${record.voucher_id}` : '-'}
                    </td>
                    <td>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                        전환완료
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center py-8 text-gray-500">
            전환 이력이 없습니다.
          </div>
        )}
      </div>
    </div>
  )
}

// ============================================================================
// Tab 4: Automation Settings
// ============================================================================
function AutomationSettingsTab() {
  const queryClient = useQueryClient()
  const [showModal, setShowModal] = useState(false)
  const [editingSchedule, setEditingSchedule] = useState<any>(null)

  const { data: schedules, isLoading } = useQuery({
    queryKey: ['salesSchedules'],
    queryFn: () => salesApi.getSchedules().then((r) => r.data),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: number) => salesApi.deleteSchedule(id),
    onSuccess: () => {
      toast.success('스케줄이 삭제되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['salesSchedules'] })
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '스케줄 삭제에 실패했습니다.')
    },
  })

  const handleEdit = (schedule: any) => {
    setEditingSchedule(schedule)
    setShowModal(true)
  }

  const handleDelete = (schedule: any) => {
    if (window.confirm(`"${schedule.name}" 스케줄을 삭제하시겠습니까?`)) {
      deleteMutation.mutate(schedule.id)
    }
  }

  const scheduleTypeLabel: Record<string, string> = {
    daily: '매일',
    weekly: '매주',
    monthly: '매월',
  }

  return (
    <div className="space-y-6">
      <div className="flex justify-end">
        <button
          onClick={() => { setEditingSchedule(null); setShowModal(true) }}
          className="btn-primary"
        >
          <PlusIcon className="h-5 w-5 mr-1" />
          스케줄 추가
        </button>
      </div>

      {isLoading ? (
        <div className="text-center py-8">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600 mx-auto" />
          <p className="text-gray-500 mt-2">로딩 중...</p>
        </div>
      ) : schedules && schedules.length > 0 ? (
        <div className="card">
          <div className="table-container">
            <table className="table">
              <thead className="table-header">
                <tr>
                  <th>작업명</th>
                  <th>유형</th>
                  <th>실행 일정</th>
                  <th>다음 실행</th>
                  <th>최근 실행</th>
                  <th>상태</th>
                  <th className="text-right">관리</th>
                </tr>
              </thead>
              <tbody className="table-body">
                {schedules.map((schedule: any) => (
                  <tr key={schedule.id}>
                    <td className="font-medium">{schedule.name}</td>
                    <td>
                      <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
                        {scheduleTypeLabel[schedule.schedule_type] || schedule.schedule_type}
                      </span>
                    </td>
                    <td className="text-sm text-gray-600">
                      {schedule.execution_day ? `${schedule.execution_day}일 ` : ''}
                      {schedule.execution_time || '-'}
                    </td>
                    <td className="text-sm">{schedule.next_run || '-'}</td>
                    <td className="text-sm">{schedule.last_run || '-'}</td>
                    <td>
                      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                        schedule.is_active ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'
                      }`}>
                        {schedule.is_active ? '활성' : '비활성'}
                      </span>
                    </td>
                    <td className="text-right">
                      <div className="flex justify-end gap-1">
                        <button
                          onClick={() => handleEdit(schedule)}
                          className="p-2 text-gray-400 hover:text-blue-600 rounded-lg hover:bg-blue-50"
                        >
                          <PencilIcon className="h-4 w-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(schedule)}
                          className="p-2 text-gray-400 hover:text-red-600 rounded-lg hover:bg-red-50"
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="card text-center py-12 text-gray-500">
          등록된 스케줄이 없습니다. '스케줄 추가' 버튼을 눌러 추가하세요.
        </div>
      )}

      {showModal && (
        <ScheduleModal
          schedule={editingSchedule}
          onClose={() => { setShowModal(false); setEditingSchedule(null) }}
        />
      )}
    </div>
  )
}

// ============================================================================
// Schedule Create/Edit Modal
// ============================================================================
function ScheduleModal({ schedule, onClose }: { schedule: any | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const isEdit = !!schedule

  const { data: channels } = useQuery({
    queryKey: ['salesChannels'],
    queryFn: () => salesApi.getChannels().then((r) => r.data),
  })

  const [formData, setFormData] = useState({
    name: schedule?.name || '',
    schedule_type: schedule?.schedule_type || 'daily',
    execution_day: schedule?.execution_day || 1,
    execution_time: schedule?.execution_time || '09:00',
    channel_ids: schedule?.channel_ids || [],
    recipients: schedule?.recipients?.join(', ') || '',
    attach_excel: schedule?.attach_excel ?? true,
    is_active: schedule?.is_active ?? true,
  })

  const createMutation = useMutation({
    mutationFn: (data: any) => salesApi.createSchedule(data),
    onSuccess: () => {
      toast.success('스케줄이 추가되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['salesSchedules'] })
      onClose()
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '스케줄 추가에 실패했습니다.')
    },
  })

  const updateMutation = useMutation({
    mutationFn: (data: any) => salesApi.updateSchedule(schedule.id, data),
    onSuccess: () => {
      toast.success('스케줄이 수정되었습니다.')
      queryClient.invalidateQueries({ queryKey: ['salesSchedules'] })
      onClose()
    },
    onError: (error: any) => {
      toast.error(error.response?.data?.detail || '스케줄 수정에 실패했습니다.')
    },
  })

  const handleChannelToggle = (channelId: number) => {
    setFormData((prev) => ({
      ...prev,
      channel_ids: prev.channel_ids.includes(channelId)
        ? prev.channel_ids.filter((id: number) => id !== channelId)
        : [...prev.channel_ids, channelId],
    }))
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!formData.name.trim()) {
      toast.error('작업명을 입력하세요.')
      return
    }

    const payload = {
      ...formData,
      recipients: formData.recipients
        .split(',')
        .map((r: string) => r.trim())
        .filter(Boolean),
    }

    if (isEdit) {
      updateMutation.mutate(payload)
    } else {
      createMutation.mutate(payload)
    }
  }

  const isPending = createMutation.isPending || updateMutation.isPending
  const inputClass = 'w-full mt-1 px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent'

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <h3 className="text-lg font-bold text-gray-900 mb-4">
          {isEdit ? '스케줄 수정' : '스케줄 추가'}
        </h3>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="label">작업명 <span className="text-red-500">*</span></label>
            <input type="text" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} className={inputClass} placeholder="예: 일일 매출 수집" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="label">스케줄 유형</label>
              <select value={formData.schedule_type} onChange={(e) => setFormData({ ...formData, schedule_type: e.target.value })} className={inputClass}>
                <option value="daily">매일</option>
                <option value="weekly">매주</option>
                <option value="monthly">매월</option>
              </select>
            </div>
            {formData.schedule_type !== 'daily' && (
              <div>
                <label className="label">
                  {formData.schedule_type === 'weekly' ? '요일 (1=월 ~ 7=일)' : '실행일'}
                </label>
                <input
                  type="number"
                  value={formData.execution_day}
                  onChange={(e) => setFormData({ ...formData, execution_day: Number(e.target.value) })}
                  className={inputClass}
                  min={1}
                  max={formData.schedule_type === 'weekly' ? 7 : 31}
                />
              </div>
            )}
          </div>

          <div>
            <label className="label">실행시간</label>
            <input type="time" value={formData.execution_time} onChange={(e) => setFormData({ ...formData, execution_time: e.target.value })} className={inputClass} />
          </div>

          {/* Channel multi-select */}
          <div>
            <label className="label">대상 채널</label>
            <div className="mt-1 border border-gray-300 rounded-lg p-3 max-h-40 overflow-y-auto space-y-2">
              {channels && channels.length > 0 ? (
                channels.map((ch: any) => (
                  <label key={ch.id} className="flex items-center gap-2 text-sm cursor-pointer">
                    <input
                      type="checkbox"
                      checked={formData.channel_ids.includes(ch.id)}
                      onChange={() => handleChannelToggle(ch.id)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    {ch.name}
                  </label>
                ))
              ) : (
                <p className="text-sm text-gray-400">등록된 채널이 없습니다.</p>
              )}
            </div>
          </div>

          <div>
            <label className="label">수신자 이메일 (쉼표 구분)</label>
            <input type="text" value={formData.recipients} onChange={(e) => setFormData({ ...formData, recipients: e.target.value })} className={inputClass} placeholder="user1@example.com, user2@example.com" />
          </div>

          <div className="flex items-center gap-6">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={formData.attach_excel}
                onChange={(e) => setFormData({ ...formData, attach_excel: e.target.checked })}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              엑셀 첨부
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={formData.is_active}
                onChange={(e) => setFormData({ ...formData, is_active: e.target.checked })}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              활성화
            </label>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-gray-700 bg-gray-100 rounded-lg hover:bg-gray-200">
              취소
            </button>
            <button type="submit" disabled={isPending} className="px-4 py-2 text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {isPending ? '저장 중...' : isEdit ? '수정' : '추가'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

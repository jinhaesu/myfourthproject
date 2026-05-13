import axios, { AxiosError, AxiosRequestConfig } from 'axios'
import { useAuthStore } from '@/store/authStore'

// 환경변수 우선, 없으면 Railway production URL을 명시적 fallback (Vercel 환경변수 누락 방어)
// 로컬 개발 시 vite proxy 사용하려면 VITE_API_URL=/api/v1 설정
const API_BASE_URL =
  import.meta.env.VITE_API_URL ||
  (import.meta.env.DEV
    ? '/api/v1'
    : 'https://myfourthproject-production.up.railway.app/api/v1')

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
})

// Request interceptor - add auth token
api.interceptors.request.use(
  (config) => {
    const token = useAuthStore.getState().accessToken
    if (token) {
      config.headers.Authorization = `Bearer ${token}`
    }
    return config
  },
  (error) => Promise.reject(error)
)

// Response interceptor - handle token refresh
// 중요: /granter/ 등 외부 API forward endpoint는 401이 그랜터 응답일 수 있으므로
// 인증 만료로 처리하지 않음 (auto-logout/refresh 시도 안 함)
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as AxiosRequestConfig & { _retry?: boolean }
    const url = String(originalRequest?.url || '')

    // 외부 API forward(그랜터/홈택스 등)에서 401은 외부 응답이므로 그대로 reject
    const isExternalForward =
      url.includes('/granter/') ||
      url.includes('/exchange-rates/') ||
      url.includes('/integrations/')

    if (
      error.response?.status === 401 &&
      !originalRequest._retry &&
      !isExternalForward
    ) {
      originalRequest._retry = true

      const refreshToken = useAuthStore.getState().refreshToken

      if (refreshToken) {
        try {
          const response = await axios.post(`${API_BASE_URL}/auth/refresh`, {
            refresh_token: refreshToken,
          })

          const { access_token } = response.data
          useAuthStore.setState({ accessToken: access_token })

          if (originalRequest.headers) {
            originalRequest.headers.Authorization = `Bearer ${access_token}`
          }

          return api(originalRequest)
        } catch (refreshError) {
          useAuthStore.getState().logout()
          window.location.href = '/login'
        }
      } else {
        useAuthStore.getState().logout()
        window.location.href = '/login'
      }
    }

    return Promise.reject(error)
  }
)

// Auth API
export const authApi = {
  login: (email: string) =>
    api.post('/auth/login', { email }),

  verifyOtp: (email: string, otpCode: string) =>
    api.post('/auth/verify-otp', { email, otp_code: otpCode }),

  resendOtp: (email: string) =>
    api.post('/auth/resend-otp', { email }),

  logout: () => api.post('/auth/logout'),

  refresh: (refreshToken: string) =>
    api.post('/auth/refresh', { refresh_token: refreshToken }),

  getMe: () => api.get('/auth/me'),
}

// Vouchers API
export const vouchersApi = {
  list: (params?: {
    page?: number
    size?: number
    departmentId?: number
    status?: string
    fromDate?: string
    toDate?: string
    search?: string
  }) =>
    api.get('/vouchers/', {
      params: params
        ? {
            page: params.page,
            size: params.size,
            department_id: params.departmentId,
            status: params.status,
            from_date: params.fromDate,
            to_date: params.toDate,
            search: params.search,
          }
        : undefined,
    }),

  get: (id: number) => api.get(`/vouchers/${id}`),

  create: (data: any, userId: number) =>
    api.post('/vouchers/', data, { params: { user_id: userId } }),

  update: (id: number, data: any, userId: number) =>
    api.patch(`/vouchers/${id}`, data, { params: { user_id: userId } }),

  confirm: (id: number, userId: number, finalAccountId?: number) =>
    api.post(`/vouchers/${id}/confirm`, null, {
      params: { user_id: userId, final_account_id: finalAccountId },
    }),

  delete: (id: number) => api.delete(`/vouchers/${id}`),

  cancel: (id: number, userId: number, reason?: string) =>
    api.post(`/vouchers/${id}/cancel`, null, {
      params: { user_id: userId, reason: reason || '' },
    }),

  getAccounts: (categoryId?: number, search?: string) =>
    api.get('/vouchers/accounts/', { params: { category_id: categoryId, search } }),

  importCardTransactions: (transactions: any[], departmentId: number, userId: number) =>
    api.post('/vouchers/import/card', transactions, {
      params: { department_id: departmentId, user_id: userId },
    }),
}

// Approvals API
export const approvalsApi = {
  getPending: (userId: number, includeDelegated = true) =>
    api.get('/approvals/pending', { params: { user_id: userId, include_delegated: includeDelegated } }),

  get: (id: number) => api.get(`/approvals/${id}`),

  create: (data: any, userId: number) =>
    api.post('/approvals/', data, { params: { user_id: userId } }),

  action: (id: number, actionData: any, userId: number) =>
    api.post(`/approvals/${id}/action`, actionData, { params: { user_id: userId } }),

  cancel: (id: number, userId: number, reason?: string) =>
    api.post(`/approvals/${id}/cancel`, null, { params: { user_id: userId, reason } }),

  getHistory: (id: number) => api.get(`/approvals/${id}/history`),

  getLines: (departmentId?: number) =>
    api.get('/approvals/lines/', { params: { department_id: departmentId } }),
}

// Treasury API
export const treasuryApi = {
  getCashPosition: () => api.get('/treasury/cash-position'),

  getBankAccounts: () => api.get('/treasury/accounts/'),

  autoReconcile: (bankAccountId?: number, fromDate?: string, toDate?: string) =>
    api.post('/treasury/reconcile', null, {
      params: { bank_account_id: bankAccountId, from_date: fromDate, to_date: toDate },
    }),

  getReceivables: (status?: string, customerName?: string) =>
    api.get('/treasury/receivables/', { params: { status, customer_name: customerName } }),

  getPayables: (status?: string, vendorName?: string) =>
    api.get('/treasury/payables/', { params: { status, vendor_name: vendorName } }),

  getArAging: (asOfDate?: string) =>
    api.get('/treasury/receivables/aging', { params: { as_of_date: asOfDate } }),

  getApAging: (asOfDate?: string) =>
    api.get('/treasury/payables/aging', { params: { as_of_date: asOfDate } }),

  getUpcomingPayments: (daysAhead = 30, bankAccountId?: number) =>
    api.get('/treasury/payment-schedules/upcoming', {
      params: { days_ahead: daysAhead, bank_account_id: bankAccountId },
    }),
}

// Budget API
export const budgetApi = {
  list: (fiscalYear?: number, departmentId?: number, status?: string) =>
    api.get('/budget/', { params: { fiscal_year: fiscalYear, department_id: departmentId, status } }),

  get: (id: number) => api.get(`/budget/${id}`),

  create: (data: any, userId: number) =>
    api.post('/budget/', data, { params: { user_id: userId } }),

  check: (departmentId: number, accountId: number, amount: number, voucherDate?: string) =>
    api.post('/budget/check', null, {
      params: { department_id: departmentId, account_id: accountId, amount, voucher_date: voucherDate },
    }),

  getSummary: (departmentId: number, fiscalYear?: number) =>
    api.get(`/budget/summary/${departmentId}`, { params: { fiscal_year: fiscalYear } }),

  getVsActual: (fiscalYear: number, departmentId?: number) =>
    api.get('/budget/vs-actual', { params: { fiscal_year: fiscalYear, department_id: departmentId } }),
}

// AI API
export const aiApi = {
  classify: (data: {
    description: string
    merchantName?: string
    merchantCategory?: string
    amount: number
    transactionTime?: string
  }) =>
    api.post('/ai/classify', {
      description: data.description,
      merchant_name: data.merchantName,
      merchant_category: data.merchantCategory,
      amount: data.amount,
      transaction_time: data.transactionTime,
    }),

  submitFeedback: (data: any, userId: number) =>
    api.post('/ai/feedback', data, { params: { user_id: userId } }),

  getModelStatus: () => api.get('/ai/model-status'),

  getCustomTags: (tagType?: string, departmentId?: number) =>
    api.get('/ai/tags/', { params: { tag_type: tagType, department_id: departmentId } }),
}

// Forecast API
export const forecastApi = {
  getPL: (periodStart: string, periodEnd: string, departmentId?: number) =>
    api.get('/forecast/pl', {
      params: { period_start: periodStart, period_end: periodEnd, department_id: departmentId },
    }),

  getCashFlow: (forecastDays = 30, startDate?: string) =>
    api.get('/forecast/cashflow', { params: { forecast_days: forecastDays, start_date: startDate } }),

  runScenario: (data: any) => api.post('/forecast/scenario', data),

  getDashboard: () => api.get('/forecast/dashboard'),
}

// Reports API
export const reportsApi = {
  exportVouchersExcel: (fromDate: string, toDate: string, departmentId?: number, status?: string) =>
    api.get('/reports/vouchers/excel', {
      params: { from_date: fromDate, to_date: toDate, department_id: departmentId, status },
      responseType: 'blob',
    }),

  exportBudgetVsActualExcel: (fiscalYear: number, departmentId?: number) =>
    api.get('/reports/budget-vs-actual/excel', {
      params: { fiscal_year: fiscalYear, department_id: departmentId },
      responseType: 'blob',
    }),

  exportAgingExcel: (reportType: 'receivables' | 'payables', asOfDate?: string) =>
    api.get('/reports/aging/excel', {
      params: { report_type: reportType, as_of_date: asOfDate },
      responseType: 'blob',
    }),

  exportToDouzone: (fromDate: string, toDate: string, exportType = 'excel') =>
    api.post('/reports/douzone-export', null, {
      params: { from_date: fromDate, to_date: toDate, export_type: exportType },
      responseType: 'blob',
    }),
}

// Users API
export const usersApi = {
  get: (id: number) => api.get(`/users/${id}`),

  create: (data: any) => api.post('/users/', data),

  update: (id: number, data: any) => api.patch(`/users/${id}`, data),

  changePassword: (id: number, currentPassword: string, newPassword: string) =>
    api.post(`/users/${id}/change-password`, null, {
      params: { current_password: currentPassword, new_password: newPassword },
    }),

  getDepartments: () => api.get('/users/departments/'),

  getRoles: () => api.get('/users/roles/'),

  // Admin APIs
  getAllUsers: () => api.get('/users/admin/all'),

  getPendingUsers: () => api.get('/users/admin/pending'),

  approveUser: (userId: number, employeeId: string) =>
    api.post(`/users/admin/${userId}/approve`, null, { params: { employee_id: employeeId } }),

  rejectUser: (userId: number) => api.post(`/users/admin/${userId}/reject`),

  activateUser: (userId: number) => api.post(`/users/admin/${userId}/activate`),

  deactivateUser: (userId: number) => api.post(`/users/admin/${userId}/deactivate`),

  updateUserRole: (userId: number, roleId: number) =>
    api.patch(`/users/admin/${userId}/role`, null, { params: { role_id: roleId } }),
}

// Admin API (감사로그, 시스템 상태)
export const adminApi = {
  getAuditLogs: (params?: { limit?: number; action_type?: string; user_id?: number }) =>
    api.get('/admin/audit-logs', { params }),

  getSnapshots: (params?: { limit?: number }) =>
    api.get('/admin/snapshots', { params }),

  getSystemHealth: () => api.get('/health'),
}

// AI Classification API (학습 및 자동분류)
export const aiClassificationApi = {
  // 상태 조회
  getStatus: () => api.get('/ai-classification/status'),

  // 계정과목 목록
  getAccounts: () => api.get('/ai-classification/accounts'),

  // 표준 계정과목 (시산표 기반, 항상 반환)
  getStandardAccounts: () => api.get('/ai-classification/standard-accounts'),

  // 과거 데이터 업로드 (학습용) - 백그라운드 처리, 10분 타임아웃
  uploadHistorical: (file: File, onUploadProgress?: (pct: number) => void) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post('/ai-classification/upload-historical', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 600000,
      onUploadProgress: (e) => {
        if (onUploadProgress && e.total) {
          onUploadProgress(Math.round((e.loaded / e.total) * 100))
        }
      },
    })
  },

  // 모델 학습 (백그라운드)
  trainModel: (minSamples = 50, maxSamples?: number, uploadIds?: number[]) =>
    api.post('/ai-classification/train', null, {
      params: {
        min_samples: minSamples,
        max_samples: maxSamples,
        upload_ids: uploadIds?.join(','),
      },
      timeout: 10000,
    }),

  // 학습 진행 상태
  getTrainProgress: () =>
    api.get('/ai-classification/train-progress'),

  // 단일 항목 분류
  classifyItems: (items: Array<{
    id?: string
    description: string
    merchant_name?: string
    amount?: number
    transaction_date?: string
  }>) => api.post('/ai-classification/classify', { items }),

  // 파일 분류
  classifyFile: (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post('/ai-classification/classify-file', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 600000,  // 10분
    })
  },

  // 분류 진행 상태 조회
  getClassifyProgress: () => api.get('/ai-classification/classify-progress'),

  // 분개 확정 (장부 반영) - selectedIndices가 주어지면 해당 인덱스만 전송
  confirmJournal: (entries: Array<{
    description: string
    merchant_name?: string
    memo: string
    transaction_date?: string
    amount: number
    debit_account_code: string
    debit_account_name?: string
    credit_account_code?: string
    credit_account_name?: string
    vat_amount?: number
    supply_amount?: number
  }>, sourceFilename?: string, selectedIndices?: number[]) => {
    const filteredEntries = selectedIndices
      ? entries.filter((_, idx) => selectedIndices.includes(idx))
      : entries
    return api.post('/ai-classification/confirm-journal', {
      entries: filteredEntries,
      source_filename: sourceFilename,
    })
  },

  // 피드백 제출
  submitFeedback: (items: Array<{
    description: string
    merchant_name?: string
    amount?: number
    predicted_account_code: string
    actual_account_code: string
    correction_reason?: string
  }>) => api.post('/ai-classification/feedback', { items }),

  // 템플릿 다운로드
  downloadTemplate: (templateType: 'historical' | 'classify' = 'historical') =>
    api.get('/ai-classification/template', {
      params: { template_type: templateType },
      responseType: 'blob',
    }),

  // 학습 이력
  getTrainingHistory: (limit = 10) =>
    api.get('/ai-classification/training-history', { params: { limit } }),

  // 업로드 이력
  getUploadHistory: (limit = 50) =>
    api.get('/ai-classification/upload-history', { params: { limit } }),

  // 분류 결과 불러오기
  getClassifyResult: (uploadId: number) =>
    api.get(`/ai-classification/classify-result/${uploadId}`),

  // 장부 반영 취소 (journal_entry 삭제)
  deleteJournal: (uploadId: number) =>
    api.delete(`/ai-classification/journal/${uploadId}`),

  // 업로드 삭제
  deleteUpload: (uploadId: number) =>
    api.delete(`/ai-classification/upload/${uploadId}`),

  // 재분류
  reclassifyUpload: (uploadId: number) =>
    api.post(`/ai-classification/reclassify/${uploadId}`),
  reclassifyAll: () =>
    api.post('/ai-classification/reclassify-all'),

  // 연도별 데이터 삭제
  deleteDataByYear: (year: number) =>
    api.delete(`/ai-classification/data-by-year/${year}`),

  // 업로드 상태 폴링
  getUploadStatus: (uploadId: number) =>
    api.get(`/ai-classification/upload-status/${uploadId}`),

  // 통장 일괄 분류 (여러 은행 파일) — SSE 스트리밍 응답
  classifyBankStatements: (files: File[]) => {
    const formData = new FormData()
    files.forEach(file => formData.append('files', file))
    const token = useAuthStore.getState().accessToken
    return fetch(`${API_BASE_URL}/ai-classification/classify-bank-statements`, {
      method: 'POST',
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      body: formData,
    })
  },

  // 세금계산서 분류 — SSE 스트리밍 응답 (매입/매출 구분)
  classifyTaxInvoices: (files: File[], taxDirection: 'purchase' | 'sales' = 'purchase') => {
    const formData = new FormData()
    files.forEach(file => formData.append('files', file))
    const token = useAuthStore.getState().accessToken
    return fetch(`${API_BASE_URL}/ai-classification/classify-tax-invoices?tax_direction=${taxDirection}`, {
      method: 'POST',
      headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      body: formData,
    })
  },

  // 배치 업로드 (클라이언트 사이드 파싱 후)
  uploadHistoricalBatch: (data: {
    upload_id: number | null
    filename: string
    file_size: number
    batch_index: number
    total_batches: number
    total_rows: number
    all_account_codes?: string[]
    rows: Array<{
      description: string
      account_code: string
      merchant_name?: string
      amount?: number
      debit?: number
      credit?: number
      date?: string
      account_name?: string
      source_account_code?: string
      source_account_name?: string
    }>
  }) => api.post('/ai-classification/upload-historical-batch', data, { timeout: 120000 }),

}

// Sales Automation API
export const salesApi = {
  // Channels
  getChannels: () => api.get('/sales/channels/'),
  createChannel: (data: any) => api.post('/sales/channels/', data),
  updateChannel: (id: number, data: any) => api.put(`/sales/channels/${id}`, data),
  deleteChannel: (id: number) => api.delete(`/sales/channels/${id}`),

  // Records
  getRecords: (params: { year: number; month: number; channel_id?: number }) =>
    api.get('/sales/records/', { params }),
  createRecord: (data: any) => api.post('/sales/records/', data),
  confirmRecord: (id: number) => api.put(`/sales/records/${id}/confirm`),

  // Summary
  getMonthlySummary: (year: number, month: number) =>
    api.get('/sales/summary/monthly', { params: { year, month } }),
  getYearlySummary: (year: number) =>
    api.get('/sales/summary/yearly', { params: { year } }),
  getChannelTrend: (channelId: number, months?: number) =>
    api.get(`/sales/trend/${channelId}`, { params: { months: months || 12 } }),

  // Voucher conversion
  convertToVoucher: (recordIds: number[]) =>
    api.post('/sales/convert-to-voucher', { record_ids: recordIds }),

  // Excel & Report
  exportExcel: (year: number, month: number) =>
    api.get('/sales/export/excel', { params: { year, month }, responseType: 'blob' }),
  sendReport: (data: { year: number; month: number; recipients: string[] }) =>
    api.post('/sales/send-report', data),
  importExcel: (formData: FormData) =>
    api.post('/sales/import/excel', formData, { headers: { 'Content-Type': 'multipart/form-data' } }),

  // Schedules
  getSchedules: () => api.get('/sales/schedules/'),
  createSchedule: (data: any) => api.post('/sales/schedules/', data),
  updateSchedule: (id: number, data: any) => api.put(`/sales/schedules/${id}`, data),
  deleteSchedule: (id: number) => api.delete(`/sales/schedules/${id}`),
}

// Data Import/Export API
export const dataApi = {
  uploadVouchers: (file: File) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post('/data/vouchers/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
  },

  downloadVouchers: (params?: { start_date?: string; end_date?: string; status_filter?: string }) =>
    api.get('/data/vouchers/download', { params, responseType: 'blob' }),

  downloadTemplate: () =>
    api.get('/data/vouchers/template', { responseType: 'blob' }),

  downloadAccountsList: () =>
    api.get('/data/accounts/download', { responseType: 'blob' }),

  uploadHistoricalData: (file: File, dataType: string) => {
    const formData = new FormData()
    formData.append('file', file)
    return api.post('/data/historical-data/upload', formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
      params: { data_type: dataType },
    })
  },
}

// ==================== 통합 데이터 실시간 조회 ====================
export const unifiedApi = {
  getSummary: (params?: { from_date?: string; to_date?: string }) =>
    api.get('/unified/summary', { params }),

  listTransactions: (params?: {
    from_date?: string
    to_date?: string
    sources?: string[]
    direction?: 'inbound' | 'outbound'
    counterparty?: string
    min_amount?: number
    max_amount?: number
    search?: string
    only_unclassified?: boolean
    page?: number
    size?: number
  }) => api.get('/unified/transactions', { params }),

  listSources: () => api.get('/unified/sources'),

  createSource: (data: {
    type: 'bank' | 'card' | 'tax_invoice'
    institution: string
    credential_token: string
    name?: string
  }) => api.post('/unified/sources', data),

  triggerSync: (sourceId: number) => api.post(`/unified/sources/${sourceId}/sync`),

  removeSource: (sourceId: number) => api.delete(`/unified/sources/${sourceId}`),

  getDashboard: (params: { period_start?: string; period_end?: string }) =>
    api.get('/unified/dashboard', { params }),

  getSourceTransactions: (params: {
    source_account_code?: string
    merchant_name?: string
    period_start?: string
    period_end?: string
    page?: number
    size?: number
  }) => api.get('/unified/source-transactions', { params }),
}

// ==================== 실시간 자금일보 ====================
export const dailyReportApi = {
  getToday: () => api.get('/daily-report/today'),
  getByDate: (reportDate: string) =>
    api.get('/daily-report/by-date', { params: { report_date: reportDate } }),
  sendNow: (reportDate?: string) =>
    api.post('/daily-report/send-now', null, { params: { report_date: reportDate } }),
  listSubscriptions: () => api.get('/daily-report/subscriptions'),
  createSubscription: (
    data: {
      delivery_method: 'email' | 'kakao' | 'slack'
      delivery_target: string
      schedule_time?: string
      include_attachments?: boolean
    },
    userId: number
  ) => api.post('/daily-report/subscriptions', data, { params: { user_id: userId } }),
  deleteSubscription: (subId: number) => api.delete(`/daily-report/subscriptions/${subId}`),
  getHistory: (limit = 30) => api.get('/daily-report/history', { params: { limit } }),
}

// ==================== 현금주의 손익 분석 ====================
export const cashPLApi = {
  getCashPL: (data: {
    from_date: string
    to_date: string
    basis?: 'cash' | 'accrual'
    period_type?: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'
    department_id?: number
    project_tag?: string
  }) => api.post('/cash-pl/', data),

  getComparison: (fromDate: string, toDate: string) =>
    api.get('/cash-pl/comparison', { params: { from_date: fromDate, to_date: toDate } }),

  getSnapshot: () => api.get('/cash-pl/snapshot'),

  getByAccountCrossTab: (data: {
    from_date: string
    to_date: string
    basis?: 'cash' | 'accrual'
    period_type?: 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'yearly'
  }) => api.post('/cash-pl/by-account-cross-tab', data),
}

// ==================== Granter Public API ====================
// 가이드: granter-public-api / Base: app.granter.biz/api/public-docs / Auth: HTTP Basic
export const granterApi = {
  health: () => api.get('/granter/health'),
  ping: () => api.get('/granter/ping'),
  clearCache: () => api.post('/granter/cache/clear'),

  listTickets: (payload: any) => api.post('/granter/tickets', payload),
  bulkUpdateTickets: (payload: any) => api.post('/granter/tickets/bulk-update', payload),

  listAssets: (payload: { assetType: string }) => api.post('/granter/assets', payload),
  listAllAssets: (onlyActive: boolean = true) =>
    api.get('/granter/assets/all', { params: { only_active: onlyActive } }),
  listTicketsAllTypes: (startDate: string, endDate: string, assetId?: number, slim: boolean = false) =>
    api.post('/granter/tickets/all', null, {
      params: { start_date: startDate, end_date: endDate, asset_id: assetId, slim },
      timeout: 60_000,  // 1개월 단위 호출은 ~10초, 여유있게 60초
    }),
  listTicketsExtended: (months: number = 6, slim: boolean = false) =>
    api.get('/granter/tickets/extended', {
      params: { months, slim },
      timeout: 300_000,  // 6개월 분할 호출은 시간 걸림 (cold cache 시 ~3분, gzip 적용 후 더 빠름)
    }),
  recentActivityPeriod: (assetId?: number) =>
    api.get('/granter/recent-activity-period', { params: { asset_id: assetId } }),
  listBalances: (payload: any) => api.post('/granter/balances', payload),
  getDailyReport: (payload: any) => api.post('/granter/daily-report', payload),
  getExchangeRates: (payload: any) => api.post('/granter/exchange-rates', payload),

  issueTaxInvoice: (payload: any, idempotencyKey?: string) =>
    api.post('/granter/tax-invoices/issue', payload, {
      params: { idempotency_key: idempotencyKey },
    }),
  modifyTaxInvoice: (payload: any, idempotencyKey?: string) =>
    api.post('/granter/tax-invoices/modify', payload, {
      params: { idempotency_key: idempotencyKey },
    }),
  cancelTaxInvoice: (payload: any, idempotencyKey?: string) =>
    api.post('/granter/tax-invoices/cancel', payload, {
      params: { idempotency_key: idempotencyKey },
    }),
  issueCashReceipt: (payload: any, idempotencyKey?: string) =>
    api.post('/granter/cash-receipts/issue', payload, {
      params: { idempotency_key: idempotencyKey },
    }),
  cancelCashReceipt: (payload: any, idempotencyKey?: string) =>
    api.post('/granter/cash-receipts/cancel', payload, {
      params: { idempotency_key: idempotencyKey },
    }),

  listTags: () => api.get('/granter/tags'),
  listCategories: () => api.get('/granter/categories'),

  // 지난 N개월 세금계산서에서 거래처 풀 추출 (default 12개월)
  contractorsPool: (months: number = 12) =>
    api.get('/granter/contractors-pool', { params: { months } }),
}

// ==================== 매출·매입·거래처 정산 ====================
export const settlementApi = {
  list: (params?: {
    counterparty_type?: 'customer' | 'vendor' | 'both'
    status?: string
    only_overdue?: boolean
    search?: string
    sort_by?: string
    page?: number
    size?: number
  }) => api.get('/settlement/', { params }),

  getDetail: (counterpartyId: number, params?: { from_date?: string; to_date?: string }) =>
    api.get(`/settlement/${counterpartyId}`, { params }),

  createOffset: (
    data: {
      counterparty_id: number
      receivable_ids: number[]
      payable_ids: number[]
      offset_amount: number
      note?: string
    },
    userId: number
  ) => api.post('/settlement/offset', data, { params: { user_id: userId } }),

  sendStatement: (counterpartyId: number, deliveryMethod: 'email' | 'kakao' | 'sms') =>
    api.post(`/settlement/${counterpartyId}/send-statement`, null, {
      params: { delivery_method: deliveryMethod },
    }),

  getAging: (counterpartyId: number) => api.get(`/settlement/${counterpartyId}/aging`),
}

// ==================== 세금계산서 ====================
export const taxInvoiceApi = {
  issue: (data: any, userId: number) =>
    api.post('/tax-invoices/', data, { params: { user_id: userId } }),

  list: (params?: {
    direction?: 'sales' | 'purchase'
    status?: string
    counterparty_business_number?: string
    from_date?: string
    to_date?: string
    page?: number
    size?: number
  }) => api.get('/tax-invoices/', { params }),

  get: (invoiceId: number) => api.get(`/tax-invoices/${invoiceId}`),

  cancel: (invoiceId: number, data: { reason: string; cancel_date: string }, userId: number) =>
    api.post(`/tax-invoices/${invoiceId}/cancel`, data, { params: { user_id: userId } }),

  send: (invoiceId: number, deliveryMethod: 'email' | 'kakao') =>
    api.post(`/tax-invoices/${invoiceId}/send`, null, {
      params: { delivery_method: deliveryMethod },
    }),

  getPdf: (invoiceId: number) => api.get(`/tax-invoices/${invoiceId}/pdf`),

  listTemplates: () => api.get('/tax-invoices/templates/counterparties'),

  createTemplate: (nickname: string, party: any) =>
    api.post('/tax-invoices/templates/counterparties', party, { params: { nickname } }),
}

// ==================== 계좌 이체 ====================
export const transferApi = {
  create: (data: any, userId: number) =>
    api.post('/transfers/', data, { params: { user_id: userId } }),

  createBulk: (data: any, userId: number) =>
    api.post('/transfers/bulk', data, { params: { user_id: userId } }),

  list: (params?: {
    status?: string
    from_bank_account_id?: number
    from_date?: string
    to_date?: string
    counterparty_search?: string
    page?: number
    size?: number
  }) => api.get('/transfers/', { params }),

  get: (transferId: number) => api.get(`/transfers/${transferId}`),

  requestOtp: (transferId: number) => api.post(`/transfers/${transferId}/request-otp`),

  execute: (transferId: number, otpCode: string, userId: number) =>
    api.post(
      `/transfers/${transferId}/execute`,
      { transfer_id: transferId, otp_code: otpCode },
      { params: { user_id: userId } }
    ),

  cancel: (transferId: number, reason: string, userId: number) =>
    api.post(`/transfers/${transferId}/cancel`, null, {
      params: { reason, user_id: userId },
    }),

  listBookmarks: () => api.get('/transfers/bookmarks/'),

  createBookmark: (data: {
    nickname: string
    bank_code: string
    account_number: string
    account_holder: string
  }) => api.post('/transfers/bookmarks/', data),

  deleteBookmark: (bookmarkId: number) => api.delete(`/transfers/bookmarks/${bookmarkId}`),
}

// ==================== 클로브커넥트 (세무대리인) ====================
export const connectApi = {
  // 수임고객
  listClients: (params?: {
    client_status?: string
    collection_status?: string
    only_pending_review?: boolean
    search?: string
    page?: number
    size?: number
  }) => api.get('/connect/clients', { params }),

  getClient: (clientId: number) => api.get(`/connect/clients/${clientId}`),

  createClient: (data: any) => api.post('/connect/clients', data),

  updateClient: (clientId: number, data: any) =>
    api.patch(`/connect/clients/${clientId}`, data),

  deleteClient: (clientId: number) => api.delete(`/connect/clients/${clientId}`),

  // 자동 수집
  getCollectionStatus: (clientId: number) =>
    api.get(`/connect/clients/${clientId}/collection`),

  triggerCollection: (clientId: number, sourceId?: number) =>
    api.post(`/connect/clients/${clientId}/collection/trigger`, null, {
      params: { source_id: sourceId },
    }),

  // 검토 대기 전표
  listPendingVouchers: (clientId: number, params?: {
    only_low_confidence?: boolean
    page?: number
    size?: number
  }) => api.get(`/connect/clients/${clientId}/pending-vouchers`, { params }),

  approveVoucher: (voucherId: number, userId: number) =>
    api.post(`/connect/vouchers/${voucherId}/approve`, null, { params: { user_id: userId } }),

  reclassifyVoucher: (voucherId: number, newAccountCode: string, userId: number) =>
    api.post(`/connect/vouchers/${voucherId}/reclassify`, null, {
      params: { new_account_code: newAccountCode, user_id: userId },
    }),

  // 결산
  listClosingPeriods: (clientId: number, params?: { fiscal_year?: number; status?: string }) =>
    api.get(`/connect/clients/${clientId}/closing-periods`, { params }),

  startClosing: (
    data: {
      client_id: number
      fiscal_year: number
      period_type: 'monthly' | 'quarterly' | 'yearly'
      period_start: string
      period_end: string
    },
    userId: number
  ) => api.post('/connect/closing', data, { params: { user_id: userId } }),

  completeClosing: (closingId: number, notes: string | undefined, userId: number) =>
    api.post(
      `/connect/closing/${closingId}/complete`,
      { closing_period_id: closingId, notes },
      { params: { user_id: userId } }
    ),

  exportToWehago: (closingId: number, data: {
    client_id: number
    closing_period_id: number
    file_format?: 'wehago_csv' | 'wehago_xlsx' | 'wehago_xml'
    include_attachments?: boolean
  }) => api.post(`/connect/closing/${closingId}/wehago-export`, data),

  listExports: (closingId: number) => api.get(`/connect/closing/${closingId}/exports`),
}

// ==================== 계정별 원장 ====================
export const ledgerApi = {
  diag: () => api.get('/ledger/diag'),

  getAvailableYears: () => api.get('/ledger/years'),

  listAccounts: (params: {
    fiscal_year: number
    period_start?: string
    period_end?: string
    category?: string
    only_with_activity?: boolean
    search?: string
  }) => api.get('/ledger/accounts', { params }),

  getTree: (params: { fiscal_year: number; period_start?: string; period_end?: string }) =>
    api.get('/ledger/accounts/tree', { params }),

  getSummary: (accountCode: string, periodStart: string, periodEnd: string) =>
    api.get(`/ledger/accounts/${accountCode}/summary`, {
      params: { period_start: periodStart, period_end: periodEnd },
    }),

  getEntries: (
    accountCode: string,
    params: {
      period_start: string
      period_end: string
      counterparty?: string
      direction?: 'debit' | 'credit'
      min_amount?: number
      max_amount?: number
      search?: string
      page?: number
      size?: number
    }
  ) => api.get(`/ledger/accounts/${accountCode}/entries`, { params }),

  updateEntry: (
    entryId: number,
    data: {
      description?: string
      direction?: 'debit' | 'credit'
      amount?: number
      debit_amount?: number
      credit_amount?: number
      source_account_code?: string
      source_account_name?: string
      account_code?: string
      account_name?: string
      counterparty?: string
      counterparty_code?: string
      memo?: string
      project_tag?: string
    },
    userId: number
  ) => api.patch(`/ledger/entries/${entryId}`, data, { params: { user_id: userId } }),

  exportExcel: (accountCode: string, periodStart: string, periodEnd: string) =>
    api.get(`/ledger/accounts/${accountCode}/export`, {
      params: { period_start: periodStart, period_end: periodEnd },
    }),

  // 매출채권/매입채무 거래처별·월별 요약 — codes로 계정 단위 선택 가능
  getArApSummary: (fiscalYear: number, type: 'receivable' | 'payable', codes?: string[]) =>
    api.get('/ledger/ar-ap/summary', {
      params: {
        fiscal_year: fiscalYear,
        type,
        ...(codes && codes.length > 0 ? { codes: codes.join(',') } : {}),
      },
    }),
}

// Financial Reports API (기간 기반 재무보고서)
export const financialApi = {
  getAvailableYears: () => api.get('/financial/available-years'),
  getSummary: (year?: number) =>
    api.get('/financial/summary', { params: { year } }),
  getTrialBalance: (year?: number, month?: number) =>
    api.get('/financial/trial-balance', { params: { year, month } }),
  getIncomeStatement: (year?: number, month?: number) =>
    api.get('/financial/income-statement', { params: { year, month } }),
  getBalanceSheet: (year?: number) =>
    api.get('/financial/balance-sheet', { params: { year } }),
  getBalanceSheetMonthly: (year: number) =>
    api.get('/financial/balance-sheet-monthly', { params: { year } }),
  getMonthlyTrend: (year?: number, accountCode?: string) =>
    api.get('/financial/monthly-trend', { params: { year, account_code: accountCode } }),
  getAccountDetail: (accountCode: string, year?: number, page?: number, size?: number, month?: number) =>
    api.get('/financial/account-detail', { params: { account_code: accountCode, year, page, size, month } }),
  getAccountMonthly: (accountCode: string, year?: number) =>
    api.get('/financial/account-monthly', { params: { account_code: accountCode, year } }),
  exportAccountDetailExcel: (accountCode: string, year?: number, month?: number) =>
    api.get('/financial/account-detail/export/excel', {
      params: { account_code: accountCode, year, month },
      responseType: 'blob'
    }),
  backfillNames: (mappings: Array<{ code: string; name: string }>) =>
    api.post('/financial/backfill-names', { mappings }),
  getDebugData: () => api.get('/financial/debug-data'),
  getAIAnalysis: (year?: number, month?: number) =>
    api.get('/financial/ai-analysis', { params: { year, month }, timeout: 300000 }),
  getAIAccountCheck: (year?: number, accountCodes?: string[]) =>
    api.get('/financial/ai-account-check', { params: { year, account_codes: accountCodes?.join(',') }, timeout: 300000 }),
}


// ==================== 자동 전표 검수 큐 API ====================
export interface AutoVoucherLine {
  side: 'debit' | 'credit'
  account_code: string
  account_name: string
  amount: number | string
  memo?: string
}

export interface AutoVoucherCandidate {
  id: number
  source_type: string
  source_id: string | null
  status: 'pending' | 'confirmed' | 'rejected' | 'duplicate'
  transaction_date: string
  counterparty: string | null
  description: string | null
  supply_amount: number | string
  vat_amount: number | string
  total_amount: number | string
  confidence: number
  suggested_account_code: string | null
  suggested_account_name: string | null
  debit_lines: AutoVoucherLine[]
  credit_lines: AutoVoucherLine[]
  duplicate_of_id: number | null
  confirmed_voucher_id: number | null
  created_at: string
}

export const autoVoucherApi = {
  generateCandidates: (params: { start_date: string; end_date: string; asset_id?: number; auto_match_duplicates?: boolean }) =>
    api.post('/auto-voucher/generate-candidates', params, { timeout: 600_000 }),
  matchDuplicates: (start_date: string, end_date: string, day_window: number = 35) =>
    api.post('/auto-voucher/match-duplicates', null, { params: { start_date, end_date, day_window } }),
  list: (params: {
    status?: string
    source_type?: string
    start_date?: string
    end_date?: string
    confidence_lt?: number
    confidence_gte?: number
    counterparty?: string
    sort?: string
    page?: number
    size?: number
  }) => api.get('/auto-voucher/list', { params }),
  get: (id: number) => api.get(`/auto-voucher/${id}`),
  patch: (id: number, patch: Partial<{
    debit_lines: AutoVoucherLine[]
    credit_lines: AutoVoucherLine[]
    counterparty: string
    description: string
    suggested_account_code: string
    suggested_account_name: string
  }>) => api.patch(`/auto-voucher/${id}`, patch),
  reject: (id: number, reason?: string) =>
    api.post(`/auto-voucher/${id}/reject`, { reason }),
  confirm: (id: number, user_id: number = 1) =>
    api.post(`/auto-voucher/${id}/confirm`, null, { params: { user_id } }),
  confirmBatch: (candidate_ids: number[], user_id: number = 1) =>
    api.post('/auto-voucher/confirm-batch', { candidate_ids, user_id }),
  directVoucher: (payload: {
    transaction_date: string
    source_type: string
    counterparty?: string
    description?: string
    supply_amount?: number | string
    vat_amount?: number | string
    debit_lines: AutoVoucherLine[]
    credit_lines: AutoVoucherLine[]
    external_ref?: string
  }) => api.post('/auto-voucher/direct-voucher', payload),
}

export default api

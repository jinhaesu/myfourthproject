import axios, { AxiosError, AxiosRequestConfig } from 'axios'
import { useAuthStore } from '@/store/authStore'

// 환경변수에서 API URL 가져오기 (프로덕션 배포 시 설정)
const API_BASE_URL = import.meta.env.VITE_API_URL || '/api/v1'

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
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as AxiosRequestConfig & { _retry?: boolean }

    if (error.response?.status === 401 && !originalRequest._retry) {
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

// Financial Reports API (기간 기반 재무보고서)
export const financialApi = {
  getAvailableYears: () => api.get('/financial/available-years'),
  getSummary: (year?: number) =>
    api.get('/financial/summary', { params: { year } }),
  getTrialBalance: (year?: number) =>
    api.get('/financial/trial-balance', { params: { year } }),
  getIncomeStatement: (year?: number, month?: number) =>
    api.get('/financial/income-statement', { params: { year, month } }),
  getBalanceSheet: (year?: number) =>
    api.get('/financial/balance-sheet', { params: { year } }),
  getMonthlyTrend: (year?: number, accountCode?: string) =>
    api.get('/financial/monthly-trend', { params: { year, account_code: accountCode } }),
  getAccountDetail: (accountCode: string, year?: number, page?: number, size?: number) =>
    api.get('/financial/account-detail', { params: { account_code: accountCode, year, page, size } }),
  backfillNames: (mappings: Array<{ code: string; name: string }>) =>
    api.post('/financial/backfill-names', { mappings }),
  getDebugData: () => api.get('/financial/debug-data'),
  getAIAnalysis: (year?: number, month?: number) =>
    api.get('/financial/ai-analysis', { params: { year, month }, timeout: 300000 }),
  getAIAccountCheck: (year?: number, accountCodes?: string[]) =>
    api.get('/financial/ai-account-check', { params: { year, account_codes: accountCodes?.join(',') }, timeout: 300000 }),
}

// 설문/출퇴근 관리 API
export const surveyApi = {
  // Surveys
  list: (params?: { category?: string; status?: string }) =>
    api.get('/survey/', { params }),
  get: (id: number) => api.get(`/survey/${id}`),
  create: (data: any) => api.post('/survey/', data),
  update: (id: number, data: any) => api.put(`/survey/${id}`, data),
  delete: (id: number) => api.delete(`/survey/${id}`),
  publish: (id: number) => api.post(`/survey/${id}/publish`),
  close: (id: number) => api.post(`/survey/${id}/close`),

  // Responses
  getResponses: (params: any) => api.get('/survey/responses/', { params }),
  getResponse: (id: number) => api.get(`/survey/responses/${id}`),
  submitResponse: (data: any) => api.post('/survey/responses/', data),
  updateResponse: (id: number, data: any) => api.put(`/survey/responses/${id}`, data),
  deleteResponse: (id: number) => api.delete(`/survey/responses/${id}`),
  exportResponses: (params: any) => api.get('/survey/responses/export/excel', { params, responseType: 'blob' }),

  // Commute
  getCommuteRecords: (params: any) => api.get('/survey/commute/', { params }),
  createCommute: (data: any) => api.post('/survey/commute/', data),
  updateCommute: (id: number, data: any) => api.put(`/survey/commute/${id}`, data),
  deleteCommute: (id: number) => api.delete(`/survey/commute/${id}`),
  checkIn: () => api.post('/survey/commute/check-in'),
  checkOut: () => api.post('/survey/commute/check-out'),
  getCommuteSummary: (params: any) => api.get('/survey/commute/summary', { params }),
  exportCommute: (params: any) => api.get('/survey/commute/export/excel', { params, responseType: 'blob' }),

  // Templates
  getTemplates: () => api.get('/survey/templates/'),
  createFromTemplate: (templateType: string) => api.post(`/survey/templates/${templateType}/create`),
}

export default api

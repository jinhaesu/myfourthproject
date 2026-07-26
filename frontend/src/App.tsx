import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import Layout from '@/components/common/Layout'
import LoginPage from '@/pages/LoginPage'
import SsoPage from '@/pages/SsoPage'

// 재배포로 청크 해시가 바뀌면 열려있던 탭에서 lazy 로드가 404로 실패해
// 메뉴 클릭 시 화면이 죽는다("튕김") — 실패 시 1회 자동 새로고침으로 복구.
function lazyRetry(factory: () => Promise<any>) {
  return lazy(() =>
    factory().catch((err) => {
      const key = 'chunk-reload-ts'
      const last = Number(sessionStorage.getItem(key) || 0)
      if (Date.now() - last > 30_000) {
        sessionStorage.setItem(key, String(Date.now()))
        window.location.reload()
        return new Promise<never>(() => {})  // reload 대기
      }
      throw err
    })
  )
}

// 페이지는 전부 lazy 로드 → 첫 진입 번들 대폭 축소, 방문하는 메뉴 코드만 내려받음.
// Layout/LoginPage 만 즉시 로드(앱 셸 + 첫 화면).
const DashboardPage = lazyRetry(() => import('@/pages/DashboardPage'))
const VouchersPage = lazyRetry(() => import('@/pages/VouchersPage'))
const AutoVoucherPage = lazyRetry(() => import('@/pages/AutoVoucherPage'))
const TaxVoucherEntryPage = lazyRetry(() => import('@/pages/TaxVoucherEntryPage'))
const VoucherDetailPage = lazyRetry(() => import('@/pages/VoucherDetailPage'))
const TreasuryPage = lazyRetry(() => import('@/pages/TreasuryPage'))
const BudgetPage = lazyRetry(() => import('@/pages/BudgetPage'))
const ForecastPage = lazyRetry(() => import('@/pages/ForecastPage'))
const ReportsPage = lazyRetry(() => import('@/pages/ReportsPage'))
const SettingsPage = lazyRetry(() => import('@/pages/SettingsPage'))
const AdminPage = lazyRetry(() => import('@/pages/AdminPage'))
const AIClassificationPage = lazyRetry(() => import('@/pages/AIClassificationPage'))
const SalesAutomationPage = lazyRetry(() => import('@/pages/SalesAutomationPage'))
const FinancialReportsPage = lazyRetry(() => import('@/pages/FinancialReportsPage'))
const UnifiedViewPage = lazyRetry(() => import('@/pages/UnifiedViewPage'))
const DailyReportPage = lazyRetry(() => import('@/pages/DailyReportPage'))
const CashDigestPage = lazyRetry(() => import('@/pages/CashDigestPage'))
const CardManagementPage = lazyRetry(() => import('@/pages/CardManagementPage'))
const CashPLPage = lazyRetry(() => import('@/pages/CashPLPage'))
const SettlementPage = lazyRetry(() => import('@/pages/SettlementPage'))
const TaxInvoicePage = lazyRetry(() => import('@/pages/TaxInvoicePage'))
const ConnectClientsPage = lazyRetry(() => import('@/pages/ConnectClientsPage'))
const ConnectClosingPage = lazyRetry(() => import('@/pages/ConnectClosingPage'))
const AccountLedgerPage = lazyRetry(() => import('@/pages/AccountLedgerPage'))
const ChannelProfitabilityPage = lazyRetry(() => import('@/pages/ChannelProfitabilityPage'))
const ContactScoringPage = lazyRetry(() => import('@/pages/ContactScoringPage'))
const CashflowForecastPage = lazyRetry(() => import('@/pages/CashflowForecastPage'))
const AuditReportPage = lazyRetry(() => import('@/pages/AuditReportPage'))
const ExchangeRatesPage = lazyRetry(() => import('@/pages/ExchangeRatesPage'))
const ArApPage = lazyRetry(() => import('@/pages/ArApPage'))
const PayrollPage = lazyRetry(() => import('@/pages/PayrollPage'))
const PayrollImportPage = lazyRetry(() => import('@/pages/PayrollImportPage'))
const MyCardsPage = lazyRetry(() => import('@/pages/MyCardsPage'))
const PurchasePage = lazyRetry(() => import('@/pages/PurchasePage'))
const InternalTransfersPage = lazyRetry(() => import('@/pages/InternalTransfersPage'))

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" />
}

// 회계 관리자 전용 라우트 — 일반 직원은 내 카드로 리다이렉트
function AdminRoute({ children }: { children: React.ReactNode }) {
  const user = useAuthStore((state) => state.user)
  return user?.isAdmin ? <>{children}</> : <Navigate to="/my-cards" replace />
}

// 로그인 직후 랜딩 — 관리자는 대시보드, 직원은 내 카드
function HomeRedirect() {
  const user = useAuthStore((state) => state.user)
  return <Navigate to={user?.isAdmin ? '/dashboard' : '/my-cards'} replace />
}

function PageFallback() {
  return (
    <div className="flex items-center justify-center py-24">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-gray-200 border-t-blue-600" />
    </div>
  )
}

function App() {
  return (
    <Suspense fallback={<PageFallback />}>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/sso" element={<SsoPage />} />

        <Route
          path="/"
          element={
            <PrivateRoute>
              <Layout />
            </PrivateRoute>
          }
        >
          <Route index element={<HomeRedirect />} />

          {/* 전 직원 접근 가능 (본인 데이터만) */}
          <Route path="my-cards" element={<MyCardsPage />} />
          <Route path="purchase" element={<PurchasePage />} />

          {/* 이하 회계 관리자 전용 */}
          <Route path="dashboard" element={<AdminRoute><DashboardPage /></AdminRoute>} />
          <Route path="unified" element={<AdminRoute><UnifiedViewPage /></AdminRoute>} />
          <Route path="daily-report" element={<AdminRoute><DailyReportPage /></AdminRoute>} />
          <Route path="cash-digest" element={<AdminRoute><CashDigestPage /></AdminRoute>} />
          <Route path="cards" element={<AdminRoute><CardManagementPage /></AdminRoute>} />
          <Route path="cash-pl" element={<AdminRoute><CashPLPage /></AdminRoute>} />
          <Route path="settlement" element={<AdminRoute><SettlementPage /></AdminRoute>} />
          <Route path="tax-invoices" element={<AdminRoute><TaxInvoicePage /></AdminRoute>} />
          <Route path="exchange-rates" element={<AdminRoute><ExchangeRatesPage /></AdminRoute>} />
          <Route path="vouchers" element={<AdminRoute><VouchersPage /></AdminRoute>} />
          <Route path="vouchers/:id" element={<AdminRoute><VoucherDetailPage /></AdminRoute>} />
          <Route path="auto-voucher" element={<AdminRoute><AutoVoucherPage /></AdminRoute>} />
          <Route path="tax-voucher-entry" element={<AdminRoute><TaxVoucherEntryPage /></AdminRoute>} />
          <Route path="treasury" element={<AdminRoute><TreasuryPage /></AdminRoute>} />
          <Route path="internal-transfers" element={<AdminRoute><InternalTransfersPage /></AdminRoute>} />
          <Route path="budget" element={<AdminRoute><BudgetPage /></AdminRoute>} />
          <Route path="forecast" element={<AdminRoute><ForecastPage /></AdminRoute>} />
          <Route path="reports" element={<AdminRoute><ReportsPage /></AdminRoute>} />
          <Route path="ai-classification" element={<AdminRoute><AIClassificationPage /></AdminRoute>} />
          <Route path="ledger" element={<AdminRoute><AccountLedgerPage /></AdminRoute>} />
          <Route path="sales" element={<AdminRoute><SalesAutomationPage /></AdminRoute>} />
          <Route path="financial" element={<AdminRoute><FinancialReportsPage /></AdminRoute>} />
          <Route path="connect/clients" element={<AdminRoute><ConnectClientsPage /></AdminRoute>} />
          <Route path="connect/closing" element={<AdminRoute><ConnectClosingPage /></AdminRoute>} />
          <Route path="channel-profitability" element={<AdminRoute><ChannelProfitabilityPage /></AdminRoute>} />
          <Route path="contact-scoring" element={<AdminRoute><ContactScoringPage /></AdminRoute>} />
          <Route path="cashflow-forecast" element={<AdminRoute><CashflowForecastPage /></AdminRoute>} />
          <Route path="audit-report" element={<AdminRoute><AuditReportPage /></AdminRoute>} />
          <Route path="ar-ap" element={<AdminRoute><ArApPage /></AdminRoute>} />
          <Route path="payroll" element={<AdminRoute><PayrollPage /></AdminRoute>} />
          <Route path="payroll-import" element={<AdminRoute><PayrollImportPage /></AdminRoute>} />
          <Route path="settings" element={<AdminRoute><SettingsPage /></AdminRoute>} />
          <Route path="admin" element={<AdminRoute><AdminPage /></AdminRoute>} />
        </Route>
      </Routes>
    </Suspense>
  )
}

export default App

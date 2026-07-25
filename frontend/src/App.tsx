import { Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import Layout from '@/components/common/Layout'
import LoginPage from '@/pages/LoginPage'

// 페이지는 전부 lazy 로드 → 첫 진입 번들 대폭 축소, 방문하는 메뉴 코드만 내려받음.
// Layout/LoginPage 만 즉시 로드(앱 셸 + 첫 화면).
const DashboardPage = lazy(() => import('@/pages/DashboardPage'))
const VouchersPage = lazy(() => import('@/pages/VouchersPage'))
const AutoVoucherPage = lazy(() => import('@/pages/AutoVoucherPage'))
const TaxVoucherEntryPage = lazy(() => import('@/pages/TaxVoucherEntryPage'))
const VoucherDetailPage = lazy(() => import('@/pages/VoucherDetailPage'))
const TreasuryPage = lazy(() => import('@/pages/TreasuryPage'))
const BudgetPage = lazy(() => import('@/pages/BudgetPage'))
const ForecastPage = lazy(() => import('@/pages/ForecastPage'))
const ReportsPage = lazy(() => import('@/pages/ReportsPage'))
const SettingsPage = lazy(() => import('@/pages/SettingsPage'))
const AdminPage = lazy(() => import('@/pages/AdminPage'))
const AIClassificationPage = lazy(() => import('@/pages/AIClassificationPage'))
const SalesAutomationPage = lazy(() => import('@/pages/SalesAutomationPage'))
const FinancialReportsPage = lazy(() => import('@/pages/FinancialReportsPage'))
const UnifiedViewPage = lazy(() => import('@/pages/UnifiedViewPage'))
const DailyReportPage = lazy(() => import('@/pages/DailyReportPage'))
const CashDigestPage = lazy(() => import('@/pages/CashDigestPage'))
const CardManagementPage = lazy(() => import('@/pages/CardManagementPage'))
const CashPLPage = lazy(() => import('@/pages/CashPLPage'))
const SettlementPage = lazy(() => import('@/pages/SettlementPage'))
const TaxInvoicePage = lazy(() => import('@/pages/TaxInvoicePage'))
const ConnectClientsPage = lazy(() => import('@/pages/ConnectClientsPage'))
const ConnectClosingPage = lazy(() => import('@/pages/ConnectClosingPage'))
const AccountLedgerPage = lazy(() => import('@/pages/AccountLedgerPage'))
const ChannelProfitabilityPage = lazy(() => import('@/pages/ChannelProfitabilityPage'))
const ContactScoringPage = lazy(() => import('@/pages/ContactScoringPage'))
const CashflowForecastPage = lazy(() => import('@/pages/CashflowForecastPage'))
const AuditReportPage = lazy(() => import('@/pages/AuditReportPage'))
const ExchangeRatesPage = lazy(() => import('@/pages/ExchangeRatesPage'))
const ArApPage = lazy(() => import('@/pages/ArApPage'))
const PayrollPage = lazy(() => import('@/pages/PayrollPage'))
const MyCardsPage = lazy(() => import('@/pages/MyCardsPage'))
const PurchasePage = lazy(() => import('@/pages/PurchasePage'))

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
          <Route path="settings" element={<AdminRoute><SettingsPage /></AdminRoute>} />
          <Route path="admin" element={<AdminRoute><AdminPage /></AdminRoute>} />
        </Route>
      </Routes>
    </Suspense>
  )
}

export default App

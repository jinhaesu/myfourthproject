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

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" />
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
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<DashboardPage />} />
          <Route path="unified" element={<UnifiedViewPage />} />
          <Route path="daily-report" element={<DailyReportPage />} />
          <Route path="cash-digest" element={<CashDigestPage />} />
          <Route path="cards" element={<CardManagementPage />} />
          <Route path="cash-pl" element={<CashPLPage />} />
          <Route path="settlement" element={<SettlementPage />} />
          <Route path="tax-invoices" element={<TaxInvoicePage />} />
          <Route path="exchange-rates" element={<ExchangeRatesPage />} />
          <Route path="vouchers" element={<VouchersPage />} />
          <Route path="vouchers/:id" element={<VoucherDetailPage />} />
          <Route path="auto-voucher" element={<AutoVoucherPage />} />
          <Route path="tax-voucher-entry" element={<TaxVoucherEntryPage />} />
          <Route path="treasury" element={<TreasuryPage />} />
          <Route path="budget" element={<BudgetPage />} />
          <Route path="forecast" element={<ForecastPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="ai-classification" element={<AIClassificationPage />} />
          <Route path="ledger" element={<AccountLedgerPage />} />
          <Route path="sales" element={<SalesAutomationPage />} />
          <Route path="financial" element={<FinancialReportsPage />} />
          <Route path="connect/clients" element={<ConnectClientsPage />} />
          <Route path="connect/closing" element={<ConnectClosingPage />} />
          <Route path="channel-profitability" element={<ChannelProfitabilityPage />} />
          <Route path="contact-scoring" element={<ContactScoringPage />} />
          <Route path="cashflow-forecast" element={<CashflowForecastPage />} />
          <Route path="audit-report" element={<AuditReportPage />} />
          <Route path="ar-ap" element={<ArApPage />} />
          <Route path="payroll" element={<PayrollPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="admin" element={<AdminPage />} />
        </Route>
      </Routes>
    </Suspense>
  )
}

export default App

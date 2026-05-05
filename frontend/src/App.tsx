import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import Layout from '@/components/common/Layout'
import LoginPage from '@/pages/LoginPage'
import DashboardPage from '@/pages/DashboardPage'
import VouchersPage from '@/pages/VouchersPage'
import VoucherDetailPage from '@/pages/VoucherDetailPage'
import TreasuryPage from '@/pages/TreasuryPage'
import BudgetPage from '@/pages/BudgetPage'
import ForecastPage from '@/pages/ForecastPage'
import ReportsPage from '@/pages/ReportsPage'
import SettingsPage from '@/pages/SettingsPage'
import AdminPage from '@/pages/AdminPage'
import AIClassificationPage from '@/pages/AIClassificationPage'
import SalesAutomationPage from '@/pages/SalesAutomationPage'
import FinancialReportsPage from '@/pages/FinancialReportsPage'
import UnifiedViewPage from '@/pages/UnifiedViewPage'
import DailyReportPage from '@/pages/DailyReportPage'
import CashPLPage from '@/pages/CashPLPage'
import SettlementPage from '@/pages/SettlementPage'
import TaxInvoicePage from '@/pages/TaxInvoicePage'
import ConnectClientsPage from '@/pages/ConnectClientsPage'
import ConnectClosingPage from '@/pages/ConnectClosingPage'
import AccountLedgerPage from '@/pages/AccountLedgerPage'
import ChannelProfitabilityPage from '@/pages/ChannelProfitabilityPage'
import ContactScoringPage from '@/pages/ContactScoringPage'
import CashflowForecastPage from '@/pages/CashflowForecastPage'
import AuditReportPage from '@/pages/AuditReportPage'

function PrivateRoute({ children }: { children: React.ReactNode }) {
  const isAuthenticated = useAuthStore((state) => state.isAuthenticated)
  return isAuthenticated ? <>{children}</> : <Navigate to="/login" />
}

function App() {
  return (
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
        <Route path="cash-pl" element={<CashPLPage />} />
        <Route path="settlement" element={<SettlementPage />} />
        <Route path="tax-invoices" element={<TaxInvoicePage />} />
        <Route path="vouchers" element={<VouchersPage />} />
        <Route path="vouchers/:id" element={<VoucherDetailPage />} />
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
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin" element={<AdminPage />} />
      </Route>
    </Routes>
  )
}

export default App

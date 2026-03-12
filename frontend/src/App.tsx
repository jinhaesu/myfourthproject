import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import Layout from '@/components/common/Layout'
import LoginPage from '@/pages/LoginPage'
import DashboardPage from '@/pages/DashboardPage'
import VouchersPage from '@/pages/VouchersPage'
import VoucherDetailPage from '@/pages/VoucherDetailPage'
import ApprovalsPage from '@/pages/ApprovalsPage'
import TreasuryPage from '@/pages/TreasuryPage'
import BudgetPage from '@/pages/BudgetPage'
import ForecastPage from '@/pages/ForecastPage'
import ReportsPage from '@/pages/ReportsPage'
import SettingsPage from '@/pages/SettingsPage'
import AdminPage from '@/pages/AdminPage'
import AIClassificationPage from '@/pages/AIClassificationPage'
import SalesAutomationPage from '@/pages/SalesAutomationPage'

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
        <Route path="vouchers" element={<VouchersPage />} />
        <Route path="vouchers/:id" element={<VoucherDetailPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="treasury" element={<TreasuryPage />} />
        <Route path="budget" element={<BudgetPage />} />
        <Route path="forecast" element={<ForecastPage />} />
        <Route path="reports" element={<ReportsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="admin" element={<AdminPage />} />
        <Route path="ai-classification" element={<AIClassificationPage />} />
        <Route path="sales" element={<SalesAutomationPage />} />
      </Route>
    </Routes>
  )
}

export default App

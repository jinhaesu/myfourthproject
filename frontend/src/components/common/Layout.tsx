import { useState } from 'react'
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import {
  HomeIcon,
  DocumentTextIcon,
  ClipboardDocumentCheckIcon,
  BanknotesIcon,
  CalculatorIcon,
  ChartBarIcon,
  DocumentChartBarIcon,
  Cog6ToothIcon,
  Bars3Icon,
  XMarkIcon,
  ArrowRightOnRectangleIcon,
  UserCircleIcon,
  UsersIcon,
  CpuChipIcon,
  PresentationChartBarIcon,
  TableCellsIcon,
  Squares2X2Icon,
  SunIcon,
  ScaleIcon,
  ArrowsRightLeftIcon,
  PaperAirplaneIcon,
  ReceiptPercentIcon,
  ArchiveBoxArrowDownIcon,
} from '@heroicons/react/24/outline'

type NavItem =
  | { name: string; href: string; icon: any; section?: never; children?: never }
  | { name: string; section: true; children?: never }

const baseNavigation: NavItem[] = [
  { name: '대시보드', href: '/dashboard', icon: HomeIcon },

  { name: '실시간 자금관리', section: true },
  { name: '통합 조회', href: '/unified', icon: Squares2X2Icon },
  { name: '자금일보', href: '/daily-report', icon: SunIcon },
  { name: '계좌 이체', href: '/transfers', icon: PaperAirplaneIcon },
  { name: '세금계산서', href: '/tax-invoices', icon: ReceiptPercentIcon },
  { name: '거래처 정산', href: '/settlement', icon: ArrowsRightLeftIcon },

  { name: '회계 / 분석', section: true },
  { name: 'AI 분류', href: '/ai-classification', icon: CpuChipIcon },
  { name: '현금주의 손익', href: '/cash-pl', icon: ScaleIcon },
  { name: '재무보고서', href: '/financial', icon: TableCellsIcon },
  { name: '전표관리', href: '/vouchers', icon: DocumentTextIcon },
  { name: '결재함', href: '/approvals', icon: ClipboardDocumentCheckIcon },
  { name: '자금관리', href: '/treasury', icon: BanknotesIcon },
  { name: '예산관리', href: '/budget', icon: CalculatorIcon },
  { name: '매출 자동화', href: '/sales', icon: PresentationChartBarIcon },
  { name: '예측/시뮬레이션', href: '/forecast', icon: ChartBarIcon },
  { name: '보고서', href: '/reports', icon: DocumentChartBarIcon },

  { name: '세무대리인', section: true },
  { name: '수임고객 관리', href: '/connect/clients', icon: UsersIcon },
  { name: '결산 자동화', href: '/connect/closing', icon: ArchiveBoxArrowDownIcon },

  { name: '시스템', section: true },
  { name: '설정', href: '/settings', icon: Cog6ToothIcon },
]

const adminNavItem: NavItem = { name: '관리자', href: '/admin', icon: UsersIcon }

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout } = useAuthStore()
  const isAdmin = user?.roleName === 'admin' || user?.roleName === 'super_admin'
  const navigation: NavItem[] = isAdmin ? [...baseNavigation, adminNavItem] : baseNavigation

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Mobile sidebar */}
      <div
        className={`fixed inset-0 z-50 lg:hidden ${sidebarOpen ? '' : 'hidden'}`}
      >
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75" onClick={() => setSidebarOpen(false)} />
        <div className="fixed inset-y-0 left-0 flex w-64 flex-col bg-white">
          <div className="flex h-16 items-center justify-between px-4 border-b">
            <span className="text-xl font-bold text-primary-600">Smart Finance</span>
            <button onClick={() => setSidebarOpen(false)} className="text-gray-400 hover:text-gray-500">
              <XMarkIcon className="h-6 w-6" />
            </button>
          </div>
          <nav className="flex-1 overflow-y-auto py-4">
            {navigation.map((item, idx) => {
              if ('section' in item && item.section) {
                return (
                  <div
                    key={`sec-${idx}`}
                    className="px-4 mt-4 mb-1 text-xs font-semibold text-gray-400 uppercase tracking-wider"
                  >
                    {item.name}
                  </div>
                )
              }
              const isActive = location.pathname.startsWith(item.href)
              const Icon = item.icon
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  onClick={() => setSidebarOpen(false)}
                  className={`flex items-center px-4 py-2 mx-2 rounded-lg text-sm font-medium ${
                    isActive
                      ? 'bg-primary-50 text-primary-700'
                      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                  }`}
                >
                  <Icon className="mr-3 h-5 w-5 flex-shrink-0" />
                  {item.name}
                </Link>
              )
            })}
          </nav>
        </div>
      </div>

      {/* Desktop sidebar */}
      <div className="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-64 lg:flex-col">
        <div className="flex flex-col flex-1 bg-white border-r border-gray-200">
          <div className="flex h-16 items-center px-6 border-b">
            <span className="text-xl font-bold text-primary-600">Smart Finance</span>
          </div>
          <nav className="flex-1 overflow-y-auto py-4">
            {navigation.map((item, idx) => {
              if ('section' in item && item.section) {
                return (
                  <div
                    key={`sec-${idx}`}
                    className="px-4 mt-4 mb-1 text-xs font-semibold text-gray-400 uppercase tracking-wider"
                  >
                    {item.name}
                  </div>
                )
              }
              const isActive = location.pathname.startsWith(item.href)
              const Icon = item.icon
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={`flex items-center px-4 py-2 mx-2 rounded-lg text-sm font-medium ${
                    isActive
                      ? 'bg-primary-50 text-primary-700'
                      : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                  }`}
                >
                  <Icon className="mr-3 h-5 w-5 flex-shrink-0" />
                  {item.name}
                </Link>
              )
            })}
          </nav>
          <div className="border-t border-gray-200 p-4">
            <div className="flex items-center">
              <UserCircleIcon className="h-10 w-10 text-gray-400" />
              <div className="ml-3">
                <p className="text-sm font-medium text-gray-700">{user?.fullName}</p>
                <p className="text-xs text-gray-500">{user?.departmentName}</p>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="lg:pl-64">
        {/* Top header */}
        <header className="sticky top-0 z-40 bg-white border-b border-gray-200">
          <div className="flex h-16 items-center justify-between px-4 sm:px-6 lg:px-8">
            <button
              type="button"
              className="lg:hidden -m-2.5 p-2.5 text-gray-700"
              onClick={() => setSidebarOpen(true)}
            >
              <Bars3Icon className="h-6 w-6" />
            </button>

            <div className="flex-1" />

            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-500 hidden sm:block">
                {user?.fullName} ({user?.position})
              </span>
              <button
                onClick={handleLogout}
                className="flex items-center text-sm text-gray-500 hover:text-gray-700"
              >
                <ArrowRightOnRectangleIcon className="h-5 w-5 mr-1" />
                로그아웃
              </button>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="py-6">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}

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
  BookOpenIcon,
} from '@heroicons/react/24/outline'

type NavItem =
  | { name: string; href: string; icon: any; section?: never }
  | { name: string; section: true }

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
  { name: '계정별 원장', href: '/ledger', icon: BookOpenIcon },
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

function NavList({
  navigation,
  pathname,
  onItemClick,
}: {
  navigation: NavItem[]
  pathname: string
  onItemClick?: () => void
}) {
  return (
    <nav className="flex-1 overflow-y-auto py-2 px-2">
      {navigation.map((item, idx) => {
        if ('section' in item && item.section) {
          return (
            <div key={`sec-${idx}`} className="nav-section">
              {item.name}
            </div>
          )
        }
        const isActive = pathname === item.href || pathname.startsWith(item.href + '/')
        const Icon = item.icon
        return (
          <Link
            key={item.name}
            to={item.href}
            onClick={onItemClick}
            className={`flex items-center gap-2 px-2 py-1 my-px rounded-md text-xs font-medium transition-colors duration-100 ${
              isActive
                ? 'bg-ink-100 text-ink-900'
                : 'text-ink-600 hover:bg-ink-50 hover:text-ink-900'
            }`}
          >
            <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${isActive ? 'text-ink-900' : 'text-ink-400'}`} />
            <span className="truncate">{item.name}</span>
          </Link>
        )
      })}
    </nav>
  )
}

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

  const userInitial = user?.fullName?.[0] || user?.username?.[0] || '?'

  return (
    <div className="min-h-screen bg-canvas-50">
      {/* Mobile sidebar */}
      <div className={`fixed inset-0 z-50 lg:hidden ${sidebarOpen ? '' : 'hidden'}`}>
        <div className="fixed inset-0 bg-ink-900/40" onClick={() => setSidebarOpen(false)} />
        <div className="fixed inset-y-0 left-0 flex w-56 flex-col bg-white">
          <div className="flex h-12 items-center justify-between px-3 border-b border-ink-200">
            <span className="text-sm font-bold text-ink-900 tracking-tightish">Smart Finance</span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="text-ink-400 hover:text-ink-700 p-1 rounded"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
          <NavList
            navigation={navigation}
            pathname={location.pathname}
            onItemClick={() => setSidebarOpen(false)}
          />
        </div>
      </div>

      {/* Desktop sidebar */}
      <div className="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-56 lg:flex-col">
        <div className="flex flex-col flex-1 bg-white border-r border-ink-200">
          <div className="flex h-12 items-center px-3 border-b border-ink-200">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded bg-ink-900 flex items-center justify-center">
                <span className="text-2xs font-bold text-white tracking-tighter">SF</span>
              </div>
              <span className="text-sm font-semibold text-ink-900 tracking-tightish">Smart Finance</span>
            </div>
          </div>

          <NavList navigation={navigation} pathname={location.pathname} />

          {/* User strip */}
          <div className="border-t border-ink-200 p-2">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-ink-50 transition group"
            >
              <div className="w-6 h-6 rounded-full bg-ink-200 flex items-center justify-center text-2xs font-semibold text-ink-700">
                {userInitial}
              </div>
              <div className="flex-1 min-w-0 text-left">
                <div className="text-xs font-medium text-ink-900 truncate">
                  {user?.fullName || user?.username}
                </div>
                <div className="text-2xs text-ink-500 truncate">{user?.position || user?.departmentName || '-'}</div>
              </div>
              <ArrowRightOnRectangleIcon className="h-3.5 w-3.5 text-ink-400 group-hover:text-ink-700" />
            </button>
          </div>
        </div>
      </div>

      {/* Main */}
      <div className="lg:pl-56">
        <header className="sticky top-0 z-40 bg-white/80 backdrop-blur border-b border-ink-200">
          <div className="flex h-12 items-center justify-between px-4 sm:px-6 lg:px-8">
            <button
              type="button"
              className="lg:hidden -m-2 p-2 text-ink-700"
              onClick={() => setSidebarOpen(true)}
            >
              <Bars3Icon className="h-5 w-5" />
            </button>
            <div className="flex-1" />
            <div className="flex items-center gap-3 text-2xs text-ink-500">
              <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-ink-200 bg-canvas-50 font-mono">
                ⌘K
              </kbd>
              <span className="hidden sm:inline-block">검색</span>
            </div>
          </div>
        </header>

        <main className="py-4">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  )
}

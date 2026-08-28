import { useEffect, useState } from 'react'
import { Outlet, Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuthStore } from '@/store/authStore'
import { useThemeStore } from '@/store/themeStore'
import { authApi } from '@/services/api'
import { useAdminPrefetch } from '@/hooks/useAdminPrefetch'
import NuldamSystemBar from '@/components/NuldamSystemBar'
import {
  HomeIcon,
  DocumentTextIcon,
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
  MoonIcon,
  ScaleIcon,
  ReceiptPercentIcon,
  ArchiveBoxArrowDownIcon,
  BookOpenIcon,
  ShoppingBagIcon,
  StarIcon,
  ArrowTrendingUpIcon,
  ShieldCheckIcon,
  GlobeAltIcon,
  BoltIcon,
  PencilSquareIcon,
  SparklesIcon,
  CreditCardIcon,
  BuildingLibraryIcon,
} from '@heroicons/react/24/outline'

type NavItem =
  | { name: string; href: string; icon: any; section?: never }
  | { name: string; section: true }

// 일반 직원용 메뉴 — 회사 도메인 로그인 직원 (본인 카드·구매요청만)
const employeeNavigation: NavItem[] = [
  { name: '내 카드', section: true },
  { name: '내 카드 관리', href: '/my-cards', icon: CreditCardIcon },

  { name: '구매', section: true },
  { name: '구매 요청', href: '/purchase', icon: ShoppingBagIcon },
]

// 회계 관리자용 메뉴 — 지정된 관리자 이메일 전용
const baseNavigation: NavItem[] = [
  { name: '대시보드', href: '/dashboard', icon: HomeIcon },

  { name: '실시간 자금관리', section: true },
  { name: '통합 조회', href: '/unified', icon: Squares2X2Icon },
  { name: '자금일보', href: '/daily-report', icon: SunIcon },
  { name: 'AI 자금 다이제스트', href: '/cash-digest', icon: SparklesIcon },
  { name: '카드 관리', href: '/cards', icon: CreditCardIcon },
  { name: '은행간 내부거래', href: '/internal-transfers', icon: BuildingLibraryIcon },
  { name: '구매요청 관리', href: '/purchase', icon: ShoppingBagIcon },
  { name: '세금계산서', href: '/tax-invoices', icon: ReceiptPercentIcon },
  { name: '환율 흐름', href: '/exchange-rates', icon: GlobeAltIcon },

  { name: '경영 인사이트', section: true },
  { name: '채널별 수익성', href: '/channel-profitability', icon: ShoppingBagIcon },
  { name: '거래처 스코어링', href: '/contact-scoring', icon: StarIcon },
  { name: '캐시플로우 예측', href: '/cashflow-forecast', icon: ArrowTrendingUpIcon },
  { name: '감사·컴플라이언스', href: '/audit-report', icon: ShieldCheckIcon },

  { name: '전표 처리', section: true },
  { name: '자동 전표 검수', href: '/auto-voucher', icon: BoltIcon },
  { name: '매입매출 전표 입력', href: '/tax-voucher-entry', icon: PencilSquareIcon },
  { name: '전표관리', href: '/vouchers', icon: DocumentTextIcon },
  { name: 'AI 분류·학습', href: '/ai-classification', icon: CpuChipIcon },
  { name: '급여·노무비 통합', href: '/payroll-import', icon: BanknotesIcon },

  { name: '회계 / 분석', section: true },
  { name: '계정별 원장', href: '/ledger', icon: BookOpenIcon },
  { name: '현금주의 손익', href: '/cash-pl', icon: ScaleIcon },
  { name: '재무보고서', href: '/financial', icon: TableCellsIcon },
  { name: '매출채권·매입채무', href: '/ar-ap', icon: ScaleIcon },
  { name: '자금관리', href: '/treasury', icon: BanknotesIcon },
  { name: '예산관리', href: '/budget', icon: CalculatorIcon },
  { name: '매출 자동화', href: '/sales', icon: PresentationChartBarIcon },
  { name: '예측/시뮬레이션', href: '/forecast', icon: ChartBarIcon },
  { name: '보고서', href: '/reports', icon: DocumentChartBarIcon },

  { name: '세무대리인', section: true },
  { name: '수임고객 관리', href: '/connect/clients', icon: UsersIcon },
  { name: '결산 자동화', href: '/connect/closing', icon: ArchiveBoxArrowDownIcon },

  { name: '시스템', section: true },
  { name: '하이픈 은행연동', href: '/hyphen', icon: BuildingLibraryIcon },
  { name: '설정', href: '/settings', icon: Cog6ToothIcon },
]

const adminNavItem: NavItem = { name: '관리자', href: '/admin', icon: UsersIcon }

/** Sun/moon button — persists preference via themeStore, toggles <html class="dark">. */
function ThemeToggle() {
  const { theme, toggleTheme } = useThemeStore()
  const isDark = theme === 'dark'

  return (
    <button
      type="button"
      onClick={toggleTheme}
      aria-label={isDark ? '라이트 모드로 전환' : '다크 모드로 전환'}
      title={isDark ? '라이트 모드로 전환' : '다크 모드로 전환'}
      className="p-1.5 rounded-md text-ink-500 dark:text-ink-400 hover:bg-ink-100 dark:hover:bg-ink-800 hover:text-ink-900 dark:hover:text-ink-50 transition-colors"
    >
      {isDark ? <SunIcon className="h-4 w-4" /> : <MoonIcon className="h-4 w-4" />}
    </button>
  )
}

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
    <nav className="flex-1 min-h-0 overflow-y-auto py-2 px-2">
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
                ? 'bg-ink-100 dark:bg-ink-800 text-ink-900 dark:text-ink-50'
                : 'text-ink-600 dark:text-ink-400 hover:bg-ink-50 dark:hover:bg-ink-800 hover:text-ink-900 dark:hover:text-ink-50'
            }`}
          >
            <Icon className={`h-3.5 w-3.5 flex-shrink-0 ${isActive ? 'text-ink-900 dark:text-ink-50' : 'text-ink-400'}`} />
            <span className="truncate">{item.name}</span>
          </Link>
        )
      })}
    </nav>
  )
}

function MenuModeToggle() {
  const { user, menuMode, setMenuMode } = useAuthStore()
  const navigate = useNavigate()
  if (!user?.isAdmin) return null

  const switchTo = (mode: 'employee' | 'admin') => {
    if (mode === menuMode) return
    setMenuMode(mode)
    navigate(mode === 'admin' ? '/dashboard' : '/my-cards')
  }

  return (
    <div className="px-2 pt-2">
      <div className="flex rounded-md border border-ink-200 dark:border-ink-800 bg-canvas-50 dark:bg-ink-950 p-0.5">
        <button
          onClick={() => switchTo('employee')}
          className={`flex-1 rounded px-1 py-1 text-2xs font-medium transition ${
            menuMode === 'employee'
              ? 'bg-white dark:bg-ink-900 text-ink-900 dark:text-ink-50 shadow-sm'
              : 'text-ink-500 dark:text-ink-400 hover:text-ink-800 dark:hover:text-ink-100'
          }`}
        >
          일반 직원용
        </button>
        <button
          onClick={() => switchTo('admin')}
          className={`flex-1 rounded px-1 py-1 text-2xs font-medium transition ${
            menuMode === 'admin'
              ? 'bg-white dark:bg-ink-900 text-ink-900 dark:text-ink-50 shadow-sm'
              : 'text-ink-500 dark:text-ink-400 hover:text-ink-800 dark:hover:text-ink-100'
          }`}
        >
          회계 관리자용
        </button>
      </div>
    </div>
  )
}

export default function Layout() {
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const location = useLocation()
  const navigate = useNavigate()
  const { user, logout, menuMode, updateUser, setMenuMode } = useAuthStore()
  const isAdmin = !!user?.isAdmin

  // 관리자 진입 시 주요 메뉴 백그라운드 선조회 (실제 클릭 시 빠른 열람)
  useAdminPrefetch(isAdmin && menuMode === 'admin')

  // 관리자 여부는 항상 서버 기준으로 동기화 (구버전 세션·배포 시점 캐시로 고착 방지)
  useEffect(() => {
    authApi.getMe()
      .then((r) => {
        const admin = !!r.data.is_admin
        if (admin !== user?.isAdmin) {
          updateUser({ isAdmin: admin })
        }
        // 관리자 계정은 어느 기기에서든 관리자 메뉴로 구분되도록 승격.
        // 과거엔 `if (admin !== isAdmin && isAdmin === undefined)` 안에서만 승격해,
        // 다른 기기/과거 세션에서 menuMode='employee'가 persist되면(이미 isAdmin 확정)
        // 서버가 admin으로 확인해줘도 일반 메뉴로 고착되던 버그가 있었다.
        // 이제 서버가 admin이고 현재 employee 모드면 항상 관리자 메뉴로 올린다.
        // (세션 중 '일반 직원용'으로 직접 전환한 경우는 리로드 전까지 유지됨 — 마운트 시 1회만 승격.)
        if (admin && useAuthStore.getState().menuMode === 'employee') {
          setMenuMode('admin')
        }
      })
      .catch(() => { /* 토큰 만료 등 — 인터셉터가 처리 */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  // 관리자만 관리자 메뉴 사용 가능. 직원은 항상 직원용 메뉴.
  const navigation: NavItem[] =
    isAdmin && menuMode === 'admin'
      ? [...baseNavigation, adminNavItem]
      : employeeNavigation

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const userInitial = user?.fullName?.[0] || user?.username?.[0] || '?'

  return (
    <>
      <NuldamSystemBar current="account" />
      <div className="min-h-screen bg-canvas-50 dark:bg-ink-950">
      {/* Mobile sidebar */}
      <div className={`fixed inset-0 z-50 lg:hidden ${sidebarOpen ? '' : 'hidden'}`}>
        <div className="fixed inset-0 bg-ink-900 dark:bg-ink-50/40" onClick={() => setSidebarOpen(false)} />
        <div className="fixed inset-y-0 left-0 flex w-56 flex-col bg-white dark:bg-ink-900 min-h-0">
          <div className="flex h-12 items-center justify-between px-3 border-b border-ink-200 dark:border-ink-800">
            <span className="text-sm font-bold text-ink-900 dark:text-ink-50 tracking-tightish">Smart Finance</span>
            <button
              onClick={() => setSidebarOpen(false)}
              className="text-ink-400 hover:text-ink-700 dark:hover:text-ink-200 p-1 rounded"
            >
              <XMarkIcon className="h-4 w-4" />
            </button>
          </div>
          <MenuModeToggle />
          <NavList
            navigation={navigation}
            pathname={location.pathname}
            onItemClick={() => setSidebarOpen(false)}
          />
        </div>
      </div>

      {/* Desktop sidebar */}
      <div className="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-56 lg:flex-col">
        <div className="flex flex-col flex-1 min-h-0 bg-white dark:bg-ink-900 border-r border-ink-200 dark:border-ink-800">
          <div className="flex h-12 items-center px-3 border-b border-ink-200 dark:border-ink-800">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded bg-ink-900 dark:bg-ink-100 flex items-center justify-center">
                <span className="text-2xs font-bold text-white dark:text-ink-900 tracking-tighter">SF</span>
              </div>
              <span className="text-sm font-semibold text-ink-900 dark:text-ink-50 tracking-tightish">Smart Finance</span>
            </div>
          </div>

          <MenuModeToggle />
          <NavList navigation={navigation} pathname={location.pathname} />

          {/* User strip */}
          <div className="border-t border-ink-200 dark:border-ink-800 p-2">
            <button
              onClick={handleLogout}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-ink-50 dark:hover:bg-ink-800 transition group"
            >
              <div className="w-6 h-6 rounded-full bg-ink-200 dark:bg-ink-700 flex items-center justify-center text-2xs font-semibold text-ink-700 dark:text-ink-300">
                {userInitial}
              </div>
              <div className="flex-1 min-w-0 text-left">
                <div className="text-xs font-medium text-ink-900 dark:text-ink-50 truncate">
                  {user?.fullName || user?.username}
                </div>
                <div className="text-2xs text-ink-500 dark:text-ink-400 truncate">{user?.position || user?.departmentName || '-'}</div>
              </div>
              <ArrowRightOnRectangleIcon className="h-3.5 w-3.5 text-ink-400 group-hover:text-ink-700 dark:group-hover:text-ink-200" />
            </button>
          </div>
        </div>
      </div>

      {/* Main */}
      <div className="lg:pl-56">
        <header className="sticky top-0 z-40 bg-white/80 dark:bg-ink-900/80 backdrop-blur border-b border-ink-200 dark:border-ink-800">
          <div className="flex h-12 items-center justify-between px-4 sm:px-6 lg:px-8">
            <button
              type="button"
              className="lg:hidden -m-2 p-2 text-ink-700 dark:text-ink-300"
              onClick={() => setSidebarOpen(true)}
            >
              <Bars3Icon className="h-5 w-5" />
            </button>
            <div className="flex-1" />
            <div className="flex items-center gap-3 text-2xs text-ink-500 dark:text-ink-400">
              <kbd className="hidden sm:inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border border-ink-200 dark:border-ink-800 bg-canvas-50 dark:bg-ink-950 font-mono">
                ⌘K
              </kbd>
              <span className="hidden sm:inline-block">검색</span>
              <ThemeToggle />
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
    </>
  )
}
